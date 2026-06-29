//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
use crate::commands::backfill::{REBUILD_RUNNING, REBUILD_SHUTDOWN};
use crate::commands::{db_path, library_root, thumbs_dir};
use crate::commands::media::design_preview_already_complete;
use crate::db::open_conn;
use crate::media::thumbnail;
use std::sync::{Arc, atomic::Ordering};
use tauri::{command, AppHandle, Emitter, Manager};

#[command]
pub fn generate_preview_thumbnail_for_item(
    app: tauri::AppHandle,
    item_id: String,
) -> Result<String, String> {
    let db_path = db_path(&app).map_err(|e| format!("Failed to resolve DB path: {}", e))?;
    let conn = open_conn(&db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

    let file = crate::db::crud::get_media_file_by_id(&conn, &item_id)
        .map_err(|e| format!("Failed to get item: {}", e))?;

    let src = std::path::Path::new(&file.filepath);
    if !src.exists() {
        return Err(format!("Source file not found: {}", file.filepath));
    }

    let meta_dir = src
        .parent()
        .map(|p| p.join(".nocturne_meta"))
        .ok_or_else(|| "Cannot determine meta directory".to_string())?;
    std::fs::create_dir_all(&meta_dir).map_err(|e| format!("Failed to create meta dir: {}", e))?;

    let preview_filename = format!(
        "{}_preview.webp",
        src.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("preview")
    );
    let preview_dst = meta_dir.join(&preview_filename);

    crate::media::thumbnail::generate_preview_thumbnail(src, &preview_dst)
        .map_err(|e| format!("Failed to generate preview: {}", e))?;

    let preview_abs = preview_dst.to_string_lossy().to_string();

    crate::db::crud::update_thumbnail_preview_path(&conn, &item_id, &preview_abs)
        .map_err(|e| format!("Failed to update DB: {}", e))?;

    Ok(preview_abs)
}

#[tauri::command]
pub fn count_missing_thumbnails(app: tauri::AppHandle) -> Result<u64, String> {
    let db_path = db_path(&app).map_err(|e| format!("Failed to resolve DB path: {}", e))?;
    let conn = open_conn(&db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_files WHERE is_trashed = 0 AND thumbnail_micro_path IS NULL AND thumbnail_path IS NOT NULL",
        [],
        |r| r.get(0),
    ).map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as u64)
}

#[tauri::command]
pub fn rebuild_missing_thumbnails(app: tauri::AppHandle) -> Result<(), String> {
    let db_path = db_path(&app).map_err(|e| format!("Failed to resolve DB path: {}", e))?;
    let conn = open_conn(&db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT id, filename, filepath FROM media_files WHERE is_trashed = 0 AND thumbnail_micro_path IS NULL AND thumbnail_path IS NOT NULL"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let items: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("Failed to query items: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let total = items.len() as u64;
    if total == 0 {
        return Ok(());
    }

    if REBUILD_RUNNING.swap(true, Ordering::Relaxed) {
        log::debug!("[rebuild] Missing thumbnail rebuild already running");
        return Ok(());
    }
    REBUILD_SHUTDOWN.store(false, Ordering::Relaxed);

    std::thread::spawn(move || {
        let conn = match open_conn(&db_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[rebuild] Failed to open DB in thread: {}", e);
                return;
            }
        };

        let batch_size = 5;
        let mut current = 0u64;

        for chunk in items.chunks(batch_size) {
            if REBUILD_SHUTDOWN.load(Ordering::Relaxed) {
                log::warn!("[rebuild] Rebuild cancelled by shutdown signal");
                break;
            }

            for (id, filename, filepath) in chunk {
                let src = std::path::Path::new(filepath);
                if !src.exists() {
                    log::warn!("[rebuild] Source file not found: {}", filepath);
                    current += 1;
                    continue;
                }

                let meta_dir = src
                    .parent()
                    .map(|p| p.join(".nocturne_meta"))
                    .unwrap_or_else(|| std::path::Path::new("").to_path_buf());

                let source_name_for_thumb =
                    src.file_name().and_then(|s| s.to_str()).unwrap_or(filename);
                let micro_filename = format!("{}_micro.webp", source_name_for_thumb);
                let micro_dst = meta_dir.join(&micro_filename);
                let micro_path_opt =
                    crate::media::thumbnail::generate_micro_from_embedded_thumbnail(
                        &src.to_string_lossy(),
                        &micro_dst,
                    )
                    .or_else(|| {
                        if let Err(e) =
                            crate::media::thumbnail::generate_micro_thumbnail(src, &micro_dst)
                        {
                            log::warn!(
                                "[rebuild] Micro thumbnail failed for '{}': {}",
                                filename,
                                e
                            );
                            None
                        } else if micro_dst.exists() {
                            Some(micro_dst.to_string_lossy().to_string())
                        } else {
                            None
                        }
                    });

                let thumbhash_opt = match crate::media::thumbnail::generate_thumbhash(src) {
                    Ok(hash) if !hash.is_empty() => Some(hash),
                    Ok(_) => None,
                    Err(e) => {
                        log::warn!("[rebuild] ThumbHash failed for '{}': {}", filename, e);
                        None
                    }
                };

                if micro_path_opt.is_some() || thumbhash_opt.is_some() {
                    if let Err(e) = crate::media::thumbnail::update_multi_tier_thumbnails(
                        &conn,
                        id,
                        micro_path_opt.as_deref(),
                        None,
                        None,
                        thumbhash_opt.as_deref(),
                    ) {
                        log::warn!("[rebuild] DB update failed for '{}': {}", filename, e);
                    }
                }

                current += 1;

                let _ = app.emit(
                    "thumbnail_rebuild_progress",
                    serde_json::json!({
                        "current": current,
                        "total": total,
                        "current_file": filename,
                    }),
                );
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let _ = app.emit(
            "thumbnail_rebuild_complete",
            serde_json::json!({
                "total": total,
            }),
        );
        REBUILD_RUNNING.store(false, Ordering::Relaxed);
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_rebuild_thumbnails() {
    REBUILD_SHUTDOWN.store(true, Ordering::Relaxed);
    REBUILD_RUNNING.store(false, Ordering::Relaxed);
}

/// 为 PSD 等设计源文件补生成缩略图（内嵌预览 / macOS Quick Look），并写回 DB。
#[command]
pub async fn ensure_media_preview_thumbnails(
    handle: AppHandle,
    media_id: String,
) -> Result<Option<crate::models::MediaFile>, String> {
    let db = db_path(&handle)?;
    let library_root = library_root(&handle).unwrap_or_default();
    eprintln!("[ensure_media_preview_thumbnails] invoked id={}", media_id);
    let (opt, metadata_changed) = tokio::task::spawn_blocking(
        move || -> Result<(Option<crate::models::MediaFile>, bool), String> {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let file = crate::db::crud::get_media_file_by_id(&conn, &media_id).map_err(|e| e.to_string())?;
        let snapshot_before = (
            file.thumbnail_micro_path.clone(),
            file.thumbnail_path.clone(),
            file.thumbnail_preview_path.clone(),
            file.filepath.clone(),
        );
        eprintln!(
            "[ensure_media_preview_thumbnails] file={} type={} thumb={:?} micro={:?}",
            file.filename,
            file.filetype,
            file.thumbnail_path,
            file.thumbnail_micro_path
        );

        let root_opt = library_root.trim();
        let library_root_opt = if root_opt.is_empty() { None } else { Some(root_opt) };
        let folder_hint = file
            .source_folder
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let resolved = crate::media::path_util::resolve_media_file_on_disk_with_folder_hint(
            &file.filepath,
            library_root_opt,
            Some(&file.filename),
            folder_hint,
        );
        let Some(resolved_path) = resolved else {
            eprintln!(
                "[ensure_media_preview_thumbnails] skip (not on disk): {} (library_root={:?} folder={:?})",
                file.filepath,
                library_root_opt,
                folder_hint
            );
            let changed = file.thumbnail_micro_path != snapshot_before.0
                || file.thumbnail_path != snapshot_before.1
                || file.thumbnail_preview_path != snapshot_before.2
                || file.filepath != snapshot_before.3;
            return Ok((Some(file), changed));
        };
        let disk_path = resolved_path.to_string_lossy().to_string();
        if disk_path != file.filepath {
            eprintln!(
                "[ensure_media_preview_thumbnails] resolved path: {} -> {}",
                file.filepath, disk_path
            );
            if !library_root.trim().is_empty() {
                let _ = crate::media::library_sync::apply_repaired_media_path(
                    &conn,
                    &media_id,
                    &disk_path,
                    library_root.trim(),
                );
            } else {
                let _ = conn.execute(
                    "UPDATE media_files SET filepath = ?1 WHERE id = ?2",
                    rusqlite::params![disk_path, media_id],
                );
            }
        }

        let _ = crate::media::design_source::hydrate_db_thumbnails_from_sidecar(
            &conn,
            &media_id,
            &resolved_path,
            &file.filename,
        );

        let file = crate::db::crud::get_media_file_by_id(&conn, &media_id).map_err(|e| e.to_string())?;
        if design_preview_already_complete(&file) {
            eprintln!("[ensure_media_preview_thumbnails] ok (sidecar or DB already has tiers)");
            let changed = file.thumbnail_micro_path != snapshot_before.0
                || file.thumbnail_path != snapshot_before.1
                || file.thumbnail_preview_path != snapshot_before.2
                || file.filepath != snapshot_before.3;
            return Ok((Some(file), changed));
        }

        let ext = crate::media::design_source::ext_lower_from_path(&resolved_path);
        let meta_dir = resolved_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(".nocturne_meta");

        if !crate::media::design_source::needs_source_preview_for_filetype_and_ext(
            &file.filetype,
            &ext,
        ) {
            eprintln!(
                "[ensure_media_preview_thumbnails] skip (not a previewable source): type={} ext={}",
                file.filetype, ext
            );
        } else {
            eprintln!(
                "[ensure_media_preview_thumbnails] running source preview pipeline (ext={})...",
                ext
            );
            match crate::media::design_source::ensure_source_preview_thumbnails(
                &media_id,
                &disk_path,
                &file.filename,
                &meta_dir,
                &db,
                &file.filetype,
                &ext,
            ) {
                Some(p) => eprintln!("[ensure_media_preview_thumbnails] ok: {}", p),
                None => eprintln!("[ensure_media_preview_thumbnails] failed (no preview source)"),
            }
        }

        let updated = crate::db::crud::get_media_file_by_id(&conn, &media_id).map_err(|e| e.to_string())?;
        let metadata_changed = updated.thumbnail_micro_path != snapshot_before.0
            || updated.thumbnail_path != snapshot_before.1
            || updated.thumbnail_preview_path != snapshot_before.2
            || updated.filepath != snapshot_before.3;
        eprintln!(
            "[ensure_media_preview_thumbnails] done thumb={:?} micro={:?} changed={}",
            updated.thumbnail_path,
            updated.thumbnail_micro_path,
            metadata_changed
        );
        Ok((Some(updated), metadata_changed))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if metadata_changed {
        if let Some(ref updated) = opt {
            let _ = handle.emit(
                "media_metadata_updated",
                serde_json::json!({ "id": updated.id }),
            );
        }
    }
    Ok(opt)
}

/// 为指定媒体文件生成缩略图。
#[command]
pub async fn generate_thumbnail(handle: AppHandle, id: String) -> Result<String, String> {
    let db = db_path(&handle)?;

    // å…ˆæŸ¥è¯¢æ–‡ä»¶è·¯å¾„ï¼ˆåŒæ­¥åœ¨ spawn_blocking å†…å®Œæˆï¼‰
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        // èŽ·å–æ–‡ä»¶è·¯å¾„
        let filepath: String = conn
            .query_row(
                "SELECT filepath FROM media_files WHERE id = ?",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .map_err(|e| format!("Media file not found: {}", e))?;

        // thumbs_dir 参数已弃用，传入空字符串
        thumbnail::generate_thumbnail_and_meta(&id, &filepath, &db).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn regenerate_all_thumbnails(handle: AppHandle) -> Result<String, String> {
    eprintln!("[regenerate_all_thumbnails] Starting thumbnail regeneration");

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    // æ­¥éª¤ 1: æ¸…ç©º thumbs ç›®å½•
    // Step 1: Clear all .nocturne_meta/ directories
    eprintln!("[regenerate_all_thumbnails] Clearing .nocturne_meta directories under library root");
    let thumbs_cleared = tokio::task::spawn_blocking({
        let library_root = library_root.clone();
        move || -> Result<usize, String> {
            let mut count = 0;
            let root_path = std::path::Path::new(&library_root);
            if let Ok(entries) = std::fs::read_dir(root_path) {
                for entry in entries.flatten() {
                    if let Ok(file_type) = entry.file_type() {
                        if file_type.is_dir() {
                            let meta_dir = entry.path().join(".nocturne_meta");
                            if meta_dir.exists() {
                                if let Ok(meta_entries) = std::fs::read_dir(&meta_dir) {
                                    for meta_entry in meta_entries.flatten() {
                                        if let Ok(ft) = meta_entry.file_type() {
                                            if ft.is_file() {
                                                let name = meta_entry.file_name();
                                                let name_str = name.to_string_lossy();
                                                if name_str.ends_with("_thumb.jpg") || name_str.ends_with(".json") {
                                                    if let Err(e) = std::fs::remove_file(meta_entry.path()) {
                                                        eprintln!("[regenerate_all_thumbnails] Failed to remove: {} - {}", meta_entry.path().display(), e);
                                                    } else {
                                                        count += 1;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(count)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!(
        "[regenerate_all_thumbnails] Cleared {} thumbnail files",
        thumbs_cleared
    );

    // æ­¥éª¤ 2: æ¸…ç©ºæ•°æ®åº“ä¸­çš„ thumbnail_path
    let db_cleared = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<usize, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let count = crate::db::crud::clear_all_thumbnail_paths(&conn).map_err(|e| e.to_string())?;
            Ok(count)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!(
        "[regenerate_all_thumbnails] Cleared {} thumbnail paths from DB",
        db_cleared
    );

    // æ­¥éª¤ 3: æŸ¥è¯¢æ‰€æœ‰å›¾ç‰‡æ–‡ä»¶
    let image_files = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<Vec<(String, String)>, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let files = crate::db::crud::query_media_files_for_regenerate(&conn).map_err(|e| e.to_string())?;
            Ok(files)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let total_files = image_files.len();
    eprintln!(
        "[regenerate_all_thumbnails] Found {} image files to regenerate",
        total_files
    );

    // æ­¥éª¤ 4: æ·»åŠ åˆ°ç¼©ç•¥å›¾é˜Ÿåˆ—
    let thumbnail_queue = {
        let state = handle.state::<crate::AppState>();
        Arc::clone(&state.thumbnail_queue)
    };

    let mut tasks_added = 0;
    let thumbs_dir_path = thumbs_dir(&handle)?;
    for (media_id, filepath) in image_files {
        if let Some(task) = crate::media::thumbnail_queue::ThumbnailTask::new(
            &media_id,
            &filepath,
            &thumbs_dir_path,
            &db,
        ) {
            thumbnail_queue.enqueue(task);
            tasks_added += 1;
        }
    }

    // å“¤é†’å¤„ç†å™¨å¼€å§‹å¤„ç†
    thumbnail_queue.wake_processor();

    let message = format!(
        "缩略图重新生成已开始\n已清理: {} 个旧缩略图\n已添加: {} 个任务到队列",
        thumbs_cleared, tasks_added
    );
    eprintln!("[regenerate_all_thumbnails] {}", message);

    Ok(message)
}

/// 强制清空缩略图目录和数据库字段
#[command]
pub async fn force_clear_thumbnails(handle: AppHandle) -> Result<String, String> {
    eprintln!("[force_clear_thumbnails] Force clearing all thumbnails");

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    // Step 1: Clear all .nocturne_meta/ directories
    let thumbs_cleared = tokio::task::spawn_blocking({
        let library_root = library_root.clone();
        move || -> Result<usize, String> {
            let mut count = 0;
            let root_path = std::path::Path::new(&library_root);
            if let Ok(entries) = std::fs::read_dir(root_path) {
                for entry in entries.flatten() {
                    if let Ok(file_type) = entry.file_type() {
                        if file_type.is_dir() {
                            let meta_dir = entry.path().join(".nocturne_meta");
                            if meta_dir.exists() {
                                if let Ok(meta_entries) = std::fs::read_dir(&meta_dir) {
                                    for meta_entry in meta_entries.flatten() {
                                        if let Ok(ft) = meta_entry.file_type() {
                                            if ft.is_file() {
                                                let name = meta_entry.file_name();
                                                let name_str = name.to_string_lossy();
                                                if name_str.ends_with("_thumb.jpg") || name_str.ends_with(".json") {
                                                    if let Err(e) = std::fs::remove_file(meta_entry.path()) {
                                                        eprintln!("[force_clear_thumbnails] Failed to remove: {} - {}", meta_entry.path().display(), e);
                                                    } else {
                                                        count += 1;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(count)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!(
        "[force_clear_thumbnails] Cleared {} thumbnail files",
        thumbs_cleared
    );

    // æ­¥éª¤ 2: æ¸…ç©ºæ•°æ®åº“ä¸­çš„ thumbnail_path å’Œ color_dominant
    let db_cleared = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<(usize, usize), String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;

            // æ¸…ç©º thumbnail_path
            let thumb_count = conn
                .execute("UPDATE media_files SET thumbnail_path = NULL", [])
                .map_err(|e| e.to_string())?;

            // æ¸…ç©º color_dominant
            let color_count = conn
                .execute("UPDATE media_files SET color_dominant = NULL", [])
                .map_err(|e| e.to_string())?;

            Ok((thumb_count, color_count))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!(
        "[force_clear_thumbnails] Cleared {} thumbnail paths and {} color records from DB",
        db_cleared.0, db_cleared.1
    );

    let message = format!(
        "已清空缩略图数据\n文件: {} 个\n数据库: {} 条缩略图记录, {} 条颜色记录",
        thumbs_cleared, db_cleared.0, db_cleared.1
    );

    Ok(message)
}
