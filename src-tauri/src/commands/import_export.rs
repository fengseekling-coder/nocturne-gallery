//! P1-1 后导入/导出模块
use crate::commands::{
    consume_destructive_token, db_path, is_movable_library_entry, library_root,
    move_file_within_library, move_to_trash,
    resolve_library_media_on_disk, resolve_under_library_root,
    unique_path_in_dir, validate_existing_local_path, validate_library_relative_folder,
    validate_path_in_library, TRASH_FOLDER_NAME,
};
use crate::commands::library::{assign_category_for_filepath, is_supported_import_file};
use crate::commands::trash::{query_file_records, relocate_bundle_after_move};
use crate::db::open_conn;
use crate::media::{media_bundle, scanner};
use crate::commands::BatchFileOperationResult;
use crate::models::{ImportPathsResult, MediaFile};
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};
use tauri::{command, AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

/// 路径守卫:解析路径必须落在库根内。
fn media_id_by_filepath(conn: &rusqlite::Connection, filepath: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT id FROM media_files WHERE filepath = ?",
        rusqlite::params![filepath],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn media_file_by_filepath(conn: &rusqlite::Connection, filepath: &str) -> Result<crate::models::MediaFile, String> {
    conn.query_row(
        "SELECT id, filename, filepath, filetype, width, height, color_dominant, thumbnail_path, thumbnail_micro_path, thumbhash, is_trashed, imported_at FROM media_files WHERE filepath = ?",
        rusqlite::params![filepath],
        |row| {
            Ok(crate::models::MediaFile {
                id: row.get(0)?,
                filename: row.get(1)?,
                filepath: row.get(2)?,
                filetype: row.get(3)?,
                mime_type: None,
                width: row.get(4)?,
                height: row.get(5)?,
                file_size: 0,
                created_at: 0,
                modified_at: 0,
                color_dominant: row.get(6)?,
                thumbnail_path: row.get(7)?,
                thumbnail_micro_path: row.get(8)?,
                thumbnail_preview_path: None,
                thumbhash: row.get(9)?,
                is_trashed: row.get(10)?,
                source_folder: None,
                sha256: None,
                phash: None,
                imported_at: row.get(11)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn remove_import_placeholder(db: &str, _file_id: &str, filepath: &str) {
    if let Ok(conn) = crate::db::open_conn(db) {
        let _ = conn.execute(
            "DELETE FROM media_files WHERE filepath = ? AND thumbnail_path IS NULL AND thumbnail_micro_path IS NULL AND media_hash IS NULL",
            rusqlite::params![filepath],
        );
    }
}

// 拖拽相关函数已迁移到 `commands/drag.rs`(P1-1 收尾时拆出,缩小本文件至 <1500 行)。
// `mod.rs` 的 `pub use drag::*;` 已让符号在 `commands::` 命名空间可用,无需保留 wrapper。

#[command]
pub async fn rename_file(
    handle: AppHandle,
    id: String,
    new_name: String,
) -> Result<MediaFile, String> {
    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let current_file = crate::db::crud::get_media_file_by_id(&conn, &id).map_err(|e| e.to_string())?;
        let sanitized_name = new_name.trim();

        if sanitized_name.is_empty() {
            return Err("文件名不能为空".to_string());
        }

        if sanitized_name == current_file.filename {
            return Ok(current_file);
        }

        if sanitized_name.contains('\\') || sanitized_name.contains('/') {
            return Err("文件名不能包含路径分隔符".to_string());
        }

        let source_path = std::path::Path::new(&current_file.filepath);
        validate_path_in_library(&current_file.filepath, &library_root)?;

        let parent_dir = source_path
            .parent()
            .ok_or_else(|| "无法确定文件所在目录".to_string())?;
        let target_path = parent_dir.join(sanitized_name);
        let target_path_str = target_path.to_string_lossy().to_string();

        validate_path_in_library(&target_path_str, &library_root)?;

        if !source_path.exists() {
            return Err("原文件不存在，无法重命名".to_string());
        }

        if target_path.exists() {
            return Err("目标文件名已存在，请更换其他名称".to_string());
        }

        let current_ext = source_path
            .extension()
            .and_then(|segment| segment.to_str())
            .map(|segment| segment.to_ascii_lowercase());
        let target_ext = target_path
            .extension()
            .and_then(|segment| segment.to_str())
            .map(|segment| segment.to_ascii_lowercase());

        if current_ext != target_ext {
            return Err("暂不支持修改文件扩展名".to_string());
        }

        std::fs::rename(source_path, &target_path).map_err(|e| format!("重命名文件失败: {}", e))?;

        let meta_dir = parent_dir.join(".nocturne_meta");
        let old_meta_path = media_bundle::find_meta_json_path(&meta_dir, &current_file.filename);
        let new_meta_path = meta_dir.join(format!("{}.json", sanitized_name));
        let mut wrote_new_meta = false;

        if let Some(existing_meta_path) = old_meta_path.as_ref() {
            match media_bundle::update_meta_json_filename(existing_meta_path, sanitized_name) {
                Ok(updated_meta) => {
                    if let Err(error) = std::fs::write(&new_meta_path, updated_meta) {
                        log::warn!(
                            "[rename_file] Failed to update meta JSON for {}: {}",
                            current_file.filepath,
                            error
                        );
                    } else {
                        wrote_new_meta = true;
                        if existing_meta_path != &new_meta_path {
                            let _ = std::fs::remove_file(existing_meta_path);
                        }
                    }
                }
                Err(error) => {
                    log::warn!(
                        "[rename_file] Failed to parse meta JSON for {}: {}",
                        current_file.filepath,
                        error
                    );
                }
            }
        }

        let modified_at = std::fs::metadata(&target_path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|timestamp| timestamp.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(current_file.modified_at);

        if let Err(error) =
            crate::db::crud::rename_media_file(&conn, &id, sanitized_name, &target_path_str, modified_at)
        {
            let rollback_file_result = std::fs::rename(&target_path, source_path);

            if wrote_new_meta {
                if let Some(existing_meta_path) = old_meta_path.as_ref() {
                    if existing_meta_path != &new_meta_path && new_meta_path.exists() {
                        let _ = std::fs::rename(&new_meta_path, existing_meta_path);
                    }
                } else if new_meta_path.exists() {
                    let _ = std::fs::remove_file(&new_meta_path);
                }
            }

            if let Err(rollback_error) = rollback_file_result {
                return Err(format!(
                    "数据库同步失败，且回滚文件名失败: {} / {}",
                    error, rollback_error
                ));
            }

            return Err(format!("数据库同步失败，已回滚文件名: {}", error));
        }

        crate::db::crud::get_media_file_by_id(&conn, &id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 将文件移动到目标文件夹（灵感库/作品集/回收站）
#[command]
pub async fn move_file_to_folder(
    handle: AppHandle,
    file_id: String,
    source_path: String,
    target_folder: String,
) -> Result<(), String> {
    eprintln!(
        "[move_file_to_folder] Moving file {} to folder {}",
        file_id, target_folder
    );

    let target_folder_trimmed = target_folder.trim();
    if target_folder_trimmed == TRASH_FOLDER_NAME {
        return move_to_trash(handle, file_id).await;
    }

    // èŽ·å–åº“æ ¹ç›®å½•
    let library_root = library_root(&handle)?;
    eprintln!("[move_file_to_folder] Library root: {}", library_root);
    let db_for_lookup = db_path(&handle)?;
    let source_path_from_db = tokio::task::spawn_blocking({
        let db = db_for_lookup.clone();
        let file_id = file_id.clone();
        move || {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT filepath FROM media_files WHERE id = ?",
                rusqlite::params![file_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("Media file not found: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if !source_path.trim().is_empty() && source_path != source_path_from_db {
        log::warn!(
            "[move_file_to_folder] Ignoring renderer source path mismatch for {}: renderer={}, db={}",
            file_id,
            source_path,
            source_path_from_db
        );
    }
    let (db_filename, source_folder): (String, String) = tokio::task::spawn_blocking({
        let db = db_for_lookup.clone();
        let file_id = file_id.clone();
        move || {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT filename, COALESCE(source_folder, '') FROM media_files WHERE id = ?",
                rusqlite::params![file_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|e| format!("Media file not found: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let source_path_buf = resolve_library_media_on_disk(
        &source_path_from_db,
        &db_filename,
        &source_folder,
        &library_root,
    )
    .ok_or_else(|| {
        format!(
            "无法在磁盘上找到源文件（记录：{}），未移动",
            source_path_from_db
        )
    })?;
    if !is_movable_library_entry(&source_path_buf) {
        return Err(format!(
            "源文件不存在或无法访问：{}",
            source_path_buf.display()
        ));
    }
    let source_path = source_path_buf.to_string_lossy().to_string();
    validate_path_in_library(&source_path, &library_root)?;
    let target_folder = validate_library_relative_folder(&target_folder)?;

    // æž„å»ºç›®æ ‡è·¯å¾„ï¼šlibrary_root + target_folder + filename
    let filename = source_path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(db_filename.as_str())
        .to_string();

    let target_dir = std::path::Path::new(&library_root).join(&target_folder);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create target folder: {}", e))?;
    let target_path = unique_path_in_dir(&target_dir, &filename);

    let target_path_str = target_path.to_string_lossy().to_string();
    validate_path_in_library(&target_path_str, &library_root)?;
    eprintln!("[move_file_to_folder] Target path: {}", target_path_str);

    let _ = handle.emit(
        "file_move_progress",
        serde_json::json!({
            "current": 0,
            "total": 1,
            "filename": filename,
        }),
    );

    let new_filename = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&filename)
        .to_string();
    let source_path_move = source_path.clone();
    let library_root_move = library_root.clone();
    let file_id_move = file_id.clone();
    let target_path_str_move = target_path_str.clone();
    let filename_move = filename.clone();
    let db_move = db_path(&handle)?;

    let target_path_for_verify = target_path.clone();
    tokio::task::spawn_blocking(move || {
        move_file_within_library(std::path::Path::new(&source_path_move), &target_path)?;
        if !target_path_for_verify.is_file() {
            return Err(format!(
                "文件移动后未出现在目标目录：{}",
                target_path_str_move
            ));
        }
        let mut conn = open_conn(&db_move).map_err(|e| e.to_string())?;
        relocate_bundle_after_move(
            &conn,
            &file_id_move,
            &source_path_move,
            &target_path_str_move,
            &filename_move,
            &new_filename,
            &library_root_move,
        );
        crate::db::crud::update_media_file_path(
            &mut conn,
            &file_id_move,
            &target_path_str_move,
            Some(library_root_move.as_str()),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[move_file_to_folder] DB update failed: {}", e);
        e
    })?;

    eprintln!("[move_file_to_folder] Database updated successfully");
    Ok(())
}

/// 从外部拖入文件到库目录（复制文件并导入数据库）
#[command]
pub async fn import_file_to_library(
    handle: AppHandle,
    source_path: String,
    target_folder: String,
    target_category: Option<String>,
) -> Result<(), String> {
    log::debug!(
        "[import_file_to_library] Importing {} to {}",
        source_path,
        target_folder
    );

    // èŽ·å–åº“æ ¹ç›®å½•
    let library_root = library_root(&handle)?;
    log::debug!("[import_file_to_library] Library root: {}", library_root);

    // æå–æ–‡ä»¶å
    let filename = std::path::Path::new(&source_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid source path")?
        .to_string();

    // æž„å»ºç›®æ ‡è·¯å¾„ï¼šlib_root + target_folder + filename
    let target_folder = validate_library_relative_folder(&target_folder)?;
    let target_path = std::path::Path::new(&library_root)
        .join(&target_folder)
        .join(&filename);

    // 路径守卫（A 类）：落盘目标必须落在库根之内。
    let target_path = resolve_under_library_root(&target_path.to_string_lossy(), &library_root)?;
    let target_path_str = target_path.to_string_lossy().to_string();
    log::debug!("[import_file_to_library] Target path: {}", target_path_str);

    // æ£€æŸ¥ç›®æ ‡æ–‡ä»¶æ˜¯å¦å·²å­˜åœ¨ï¼ˆå­˜åœ¨åˆ™è·³è¿‡ï¼‰
    if target_path.exists() {
        log::debug!(
            "[import_file_to_library] File already exists, backfilling thumbnails: {}",
            target_path_str
        );
        let db_existing = db_path(&handle)?;
        if let Ok(conn) = open_conn(&db_existing) {
            if let Ok(existing_id) = media_id_by_filepath(&conn, &target_path_str) {
                let ext_lower = target_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase())
                    .unwrap_or_default();
                let is_heavy = matches!(
                    ext_lower.as_str(),
                    "psd" | "psb" | "tiff" | "mp4" | "mov" | "avi" | "mkv" | "webm"
                );
                let sem = if is_heavy {
                    scanner::HEAVY_ENRICH_SEMAPHORE.clone()
                } else {
                    scanner::LIGHT_ENRICH_SEMAPHORE.clone()
                };
                let id_bf = existing_id.clone();
                let id_emit = existing_id.clone();
                let path_bf = target_path_str.clone();
                let db_bf = db_existing.clone();
                let root_bf = library_root.clone();
                let handle_bf = handle.clone();
                tokio::spawn(async move {
                    if let Ok(_permit) = sem.acquire_owned().await {
                        let _ = tokio::task::spawn_blocking(move || {
                            scanner::scan_single_file_enrich(&id_bf, &path_bf, &db_bf, &root_bf)
                        })
                        .await;
                    }
                    let _ = handle_bf.emit(
                        "media_metadata_updated",
                        serde_json::json!({ "id": id_emit }),
                    );
                });
            }
        }
        let _ = handle.emit(
            "import_skipped",
            serde_json::json!({
                "filename": filename,
                "targetFolder": target_folder,
                "reason": "existing-file",
            }),
        );
        return Ok(());
    }

    let _ = handle.emit(
        "import_progress",
        serde_json::json!({
            "current": 0,
            "total": 1,
            "filename": filename.clone(),
        }),
    );

    // ── Phase 1：最小化扫描（从源文件读元数据，但记录库内目标路径），< 10ms ──
    let db = db_path(&handle)?;
    let db_p1 = db.clone();
    let source_p1 = source_path.clone();
    let target_p1 = target_path_str.clone();
    let root_p1 = library_root.clone();

    // 立即执行 Phase 1：写入 DB
    let _indexed_file_id = tokio::task::spawn_blocking(move || {
        scanner::scan_single_file_minimal(&source_p1, &target_p1, &db_p1, &root_p1)
            .map_err(|e| format!("scan_minimal failed: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let file_id = {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        media_id_by_filepath(&conn, &target_path_str)?
    };

    // 类别分配紧跟 Phase 1
    assign_category_for_filepath(&db, &target_path_str, target_category.as_deref()).map_err(
        |e| {
            log::debug!("[import_file_to_library] Category assignment failed: {}", e);
            e
        },
    )?;

    let _ = handle.emit(
        "import_index_committed",
        serde_json::json!({
            "current": 1,
            "total": 1,
        }),
    );

    // ── Phase 2：物理复制成功后再完成导入提示 ──
    let db_p2 = db.clone();
    let source_p2 = source_path.clone();
    let target_p2 = target_path_str.clone();
    let root_p2 = library_root.clone();

    // 根据文件类型决定使用哪个并发队列
    let ext_lower = std::path::Path::new(&target_p2)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let is_heavy = matches!(
        ext_lower.as_str(),
        "psd" | "psb" | "tiff" | "mp4" | "mov" | "avi" | "mkv" | "webm"
    );
    let semaphore = if is_heavy {
        std::sync::Arc::clone(&scanner::HEAVY_ENRICH_SEMAPHORE)
    } else {
        std::sync::Arc::clone(&scanner::LIGHT_ENRICH_SEMAPHORE)
    };

    let copy_permit = match scanner::IMPORT_COPY_SEMAPHORE.clone().acquire_owned().await {
        Ok(permit) => permit,
        Err(e) => {
            remove_import_placeholder(&db, &file_id, &target_path_str);
            let _ = handle.emit("import_complete", serde_json::json!({ "total": 0 }));
            return Err(format!("Failed to acquire copy permit: {}", e));
        }
    };

    let target_path_buf_for_copy = target_path.clone();
    let target_p2_for_copy = target_p2.clone();
    let copy_result = tokio::task::spawn_blocking(move || {
        // 确保目录存在
        if let Some(parent) = target_path_buf_for_copy.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::copy(&source_p2, &target_p2_for_copy)
            .map_err(|e| format!("Background copy failed: {}", e))
    })
    .await;
    drop(copy_permit);

    match copy_result {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            remove_import_placeholder(&db, &file_id, &target_path_str);
            let _ = handle.emit("import_complete", serde_json::json!({ "total": 0 }));
            return Err(e);
        }
        Err(e) => {
            remove_import_placeholder(&db, &file_id, &target_path_str);
            let _ = handle.emit("import_complete", serde_json::json!({ "total": 0 }));
            return Err(format!("Task join error: {}", e));
        }
    }

    if let Ok(conn) = open_conn(&db) {
        let _ = scanner::ensure_image_micro_thumbnail_for_file(&conn, &file_id, &target_path_str);
    }

    if let Ok(_permit) = semaphore.acquire_owned().await {
        let id_for_enrich = file_id.clone();
        let target_p2_for_enrich = target_p2.clone();
        let db_p2_for_enrich = db_p2.clone();
        let root_p2_for_enrich = root_p2.clone();

        match tokio::task::spawn_blocking(move || {
            scanner::scan_single_file_enrich(
                &id_for_enrich,
                &target_p2_for_enrich,
                &db_p2_for_enrich,
                &root_p2_for_enrich,
            )
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::warn!(
                "[import_file_to_library] Enrich failed for {}: {}",
                target_p2,
                e
            ),
            Err(e) => log::warn!(
                "[import_file_to_library] Enrich task join error for {}: {}",
                target_p2,
                e
            ),
        }
    } else {
        log::warn!(
            "[import_file_to_library] Failed to acquire enrich permit for {}",
            target_p2
        );
    }

    let _ = handle.emit(
        "media_metadata_updated",
        serde_json::json!({ "id": file_id }),
    );
    let _ = handle.emit(
        "import_progress",
        serde_json::json!({
            "current": 1,
            "total": 1,
            "filename": filename.clone(),
        }),
    );
    let _ = handle.emit("import_complete", serde_json::json!({ "total": 1 }));

    log::debug!("[import_file_to_library] Import copy complete, enrichment attempted");
    Ok(())
}

/// 永久删除文件（从数据库和文件系统）
#[command]
pub async fn import_paths_to_library(
    handle: AppHandle,
    source_paths: Vec<String>,
    target_folder: String,
    target_category: Option<String>,
) -> Result<ImportPathsResult, String> {
    let handle_for_task = handle.clone();

    tokio::task::spawn_blocking(move || {
        let target_category = target_category
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if source_paths.is_empty() {
            let _ = handle_for_task.emit("import_complete", serde_json::json!({ "total": 0 }));
            return Ok(ImportPathsResult {
                imported_count: 0,
                skipped_count: 0,
                failed_count: 0,
            });
        }

        let _ = handle_for_task.emit(
            "import_progress",
            serde_json::json!({
                "current": 0,
                "total": 1,
                "filename": "正在分析拖入项目",
            }),
        );

        let library_root = library_root(&handle_for_task)?;
        let db = db_path(&handle_for_task)?;
        // 路径守卫（A 类）：目标文件夹必须是库内相对目录。
        let target_folder = validate_library_relative_folder(&target_folder)?;
        let target_root = std::path::Path::new(&library_root).join(&target_folder);
        std::fs::create_dir_all(&target_root)
            .map_err(|e| format!("Failed to create target folder: {}", e))?;

        let mut skipped_count = 0_i64;
        let mut failed_count = 0_i64;
        let mut imported_count = 0_i64;
        let mut planned_imports: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
        let mut seen_destinations: HashSet<std::path::PathBuf> = HashSet::new();

        for raw_source_path in source_paths {
            let source_path = std::path::PathBuf::from(&raw_source_path);
            if !source_path.exists() {
                log::warn!(
                    "[import_paths_to_library] Source path does not exist: {}",
                    raw_source_path
                );
                failed_count += 1;
                continue;
            }

            if source_path.is_file() {
                if !is_supported_import_file(&source_path) {
                    skipped_count += 1;
                    continue;
                }

                let Some(filename) = source_path.file_name() else {
                    failed_count += 1;
                    continue;
                };

                let target_path = target_root.join(filename);
                // 路径守卫（A 类）：逐项确认落盘目标仍在库根之内。
                let target_path =
                    match resolve_under_library_root(&target_path.to_string_lossy(), &library_root)
                    {
                        Ok(path) => path,
                        Err(err) => {
                            log::warn!(
                                "[import_paths_to_library] Reject out-of-range target: {}",
                                err
                            );
                            failed_count += 1;
                            continue;
                        }
                    };
                if target_path.exists() || !seen_destinations.insert(target_path.clone()) {
                    skipped_count += 1;
                    continue;
                }

                planned_imports.push((source_path, target_path));
                continue;
            }

            if !source_path.is_dir() {
                skipped_count += 1;
                continue;
            }

            let folder_name = source_path
                .file_name()
                .map(std::ffi::OsStr::to_os_string)
                .unwrap_or_else(|| std::ffi::OsString::from("导入目录"));

            for entry in walkdir::WalkDir::new(&source_path)
                .into_iter()
                .filter_map(Result::ok)
            {
                let entry_path = entry.path();
                if !entry_path.is_file() || !is_supported_import_file(entry_path) {
                    continue;
                }

                let relative_path = match entry_path.strip_prefix(&source_path) {
                    Ok(path) => path,
                    Err(err) => {
                        log::warn!(
                            "[import_paths_to_library] Failed to compute relative path for {}: {}",
                            entry_path.display(),
                            err
                        );
                        failed_count += 1;
                        continue;
                    }
                };

                let target_path = target_root.join(&folder_name).join(relative_path);
                // 路径守卫（A 类）：递归导入的每个落盘目标也必须在库根之内。
                let target_path =
                    match resolve_under_library_root(&target_path.to_string_lossy(), &library_root)
                    {
                        Ok(path) => path,
                        Err(err) => {
                            log::warn!(
                                "[import_paths_to_library] Reject out-of-range target: {}",
                                err
                            );
                            failed_count += 1;
                            continue;
                        }
                    };
                if target_path.exists() || !seen_destinations.insert(target_path.clone()) {
                    skipped_count += 1;
                    continue;
                }

                planned_imports.push((entry_path.to_path_buf(), target_path));
            }
        }

        let total = planned_imports.len() as i64;
        if total == 0 {
            let _ = handle_for_task.emit("import_complete", serde_json::json!({ "total": 0 }));
            return Ok(ImportPathsResult {
                imported_count,
                skipped_count,
                failed_count,
            });
        }

        // ── Phase 1：最小化扫描（批量写 DB），极快（事务优化） ──
        let _ = handle_for_task.emit(
            "import_progress",
            serde_json::json!({
                "current": 0,
                "total": total,
                "filename": "正在写入素材索引",
            }),
        );

        let mut import_jobs: Vec<(String, std::path::PathBuf, std::path::PathBuf)> = Vec::new();

        if !planned_imports.is_empty() {
            let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
            let import_index_chunk_size = 50usize;
            let mut indexed_count = 0_i64;

            for chunk in planned_imports.chunks(import_index_chunk_size) {
                let tx = conn.transaction().map_err(|e| e.to_string())?;

                for (source_path, target_path) in chunk {
                    let source_path_str = source_path.to_string_lossy();
                    let target_path_str = target_path.to_string_lossy();

                    // 批量导入不在索引阶段生成 micro（避免对源图 image::open N 次阻塞 UI）
                    match scanner::scan_single_file_minimal_with_conn(
                        &tx,
                        &source_path_str,
                        &target_path_str,
                        &library_root,
                        false,
                    ) {
                        Ok(_) => {
                            let file_id = match media_id_by_filepath(&tx, &target_path_str) {
                                Ok(id) => id,
                                Err(e) => {
                                    log::error!(
                                        "[bulk import] media id lookup failed for {}: {}",
                                        target_path_str,
                                        e
                                    );
                                    failed_count += 1;
                                    continue;
                                }
                            };

                            indexed_count += 1;
                            if let Some(category_name) = target_category.as_deref() {
                                if let Err(e) =
                                    crate::db::crud::set_media_category(&tx, &file_id, category_name)
                                {
                                    log::warn!(
                                        "[bulk import] category assignment failed for {}: {}",
                                        target_path_str,
                                        e
                                    );
                                }
                            }
                            import_jobs.push((file_id, source_path.clone(), target_path.clone()));
                        }
                        Err(e) => {
                            log::error!(
                                "[bulk import] minimal scan failed for {}: {}",
                                target_path_str,
                                e
                            );
                            failed_count += 1;
                        }
                    }
                }

                tx.commit()
                    .map_err(|e| format!("Transaction commit failed: {}", e))?;
                let _ = handle_for_task.emit(
                    "import_index_committed",
                    serde_json::json!({
                        "current": indexed_count,
                        "total": total,
                    }),
                );
            }
        }

        let mut enrich_jobs: Vec<(String, String)> = Vec::new();
        const IMPORT_PROGRESS_EMIT_INTERVAL: i64 = 8;

        for (file_id, source_path, target_path) in import_jobs {
            let target_path_str = target_path.to_string_lossy().to_string();
            let progress_filename = target_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("正在导入素材");

            let copy_result = (|| -> Result<(), String> {
                if let Some(parent) = target_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create target folder: {}", e))?;
                }
                std::fs::copy(&source_path, &target_path)
                    .map_err(|e| format!("Copy failed: {}", e))?;
                Ok(())
            })();

            if let Err(e) = copy_result {
                log::error!("[bulk import] Copy failed for {}: {}", target_path_str, e);
                let _ = std::fs::remove_file(&target_path);
                remove_import_placeholder(&db, &file_id, &target_path_str);
                failed_count += 1;
                continue;
            }

            // micro / 主缩略图由后台 enrich 统一生成，避免复制阶段逐张解码阻塞前端

            imported_count += 1;
            enrich_jobs.push((file_id.clone(), target_path_str.clone()));
            if imported_count == total || imported_count % IMPORT_PROGRESS_EMIT_INTERVAL == 0 {
                let _ = handle_for_task.emit(
                    "import_progress",
                    serde_json::json!({
                        "current": imported_count,
                        "total": total,
                        "filename": progress_filename,
                    }),
                );
            }
        }

        let _ = handle_for_task.emit(
            "import_complete",
            serde_json::json!({ "total": imported_count }),
        );

        if !enrich_jobs.is_empty() {
            let db_for_enrich = db.clone();
            let root_for_enrich = library_root.clone();
            let handle_for_enrich = handle_for_task.clone();
            let enrich_ids: Vec<String> = enrich_jobs.iter().map(|(id, _)| id.clone()).collect();
            std::thread::spawn(move || {
                use rayon::prelude::*;
                enrich_jobs.par_iter().for_each(|(file_id, target_path)| {
                    if let Err(e) = scanner::scan_single_file_enrich(
                        file_id,
                        target_path,
                        &db_for_enrich,
                        &root_for_enrich,
                    ) {
                        log::warn!("[bulk import] Enrich failed for {}: {}", target_path, e);
                    }
                });
                // 批量通知前端刷新，避免每张图触发 refreshFileById 压垮 UI
                const BATCH_CHUNK: usize = 40;
                for chunk in enrich_ids.chunks(BATCH_CHUNK) {
                    let _ = handle_for_enrich.emit(
                        "media_metadata_updated_batch",
                        serde_json::json!({ "ids": chunk }),
                    );
                }
            });
        }

        Ok(ImportPathsResult {
            imported_count,
            skipped_count,
            failed_count,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn delete_file_permanently(
    handle: AppHandle,
    id: String,
    confirmation_token: String,
) -> Result<(), String> {
    eprintln!("[delete_file_permanently] Deleting file: {}", id);

    consume_destructive_token(&handle, &confirmation_token, "delete_file_permanently")?;

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        // å…ˆèŽ·å–æ–‡ä»¶è·¯å¾„
        let filepath: String = conn
            .query_row(
                "SELECT filepath FROM media_files WHERE id = ?",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .map_err(|e| format!("Failed to get file path: {}", e))?;

        // è·¯å¾„éªŒè¯ï¼šç¡®ä¿æ–‡ä»¶åœ¨åº“æ ¹ç›®å½•èŒƒå›´å†…
        validate_path_in_library(&filepath, &library_root)?;

        eprintln!(
            "[delete_file_permanently] Removing physical file: {}",
            filepath
        );

        // åˆ é™¤ç‰©ç†æ–‡ä»¶
        media_bundle::purge_media_sidecar_and_library_attachment_files(
            &conn,
            &id,
            &filepath,
            &library_root,
        );

        // 删除物理文件
        std::fs::remove_file(&filepath).map_err(|e| format!("Failed to delete file: {}", e))?;

        eprintln!("[delete_file_permanently] Deleting database record: {}", id);

        // 从数据库删除记录
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crate::db::crud::delete_media_file(&tx, &id).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[delete_file_permanently] Error: {}", e);
        e
    })
}

#[command]
pub async fn batch_delete_files_permanently(
    handle: AppHandle,
    ids: Vec<String>,
    confirmation_token: String,
) -> Result<BatchFileOperationResult, String> {
    if ids.is_empty() {
        return Ok(BatchFileOperationResult {
            succeeded: 0,
            failed: 0,
            first_error: None,
        });
    }

    consume_destructive_token(&handle, &confirmation_token, "batch_delete_files_permanently")?;

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let rows = query_file_records(
            &conn,
            &ids,
            "SELECT id, filepath FROM media_files WHERE id IN ({placeholders})",
        )?;
        let file_map: HashMap<String, String> = rows
            .into_iter()
            .filter_map(|row| {
                if row.len() == 2 {
                    Some((row[0].clone(), row[1].clone()))
                } else {
                    None
                }
            })
            .collect();

        let mut deleted_ids: Vec<String> = Vec::new();
        let mut failed = 0usize;

        for id in &ids {
            let Some(filepath) = file_map.get(id) else {
                failed += 1;
                continue;
            };

            if validate_path_in_library(filepath, &library_root).is_err() {
                failed += 1;
                continue;
            }

            media_bundle::purge_media_sidecar_and_library_attachment_files(
                &conn,
                id,
                filepath,
                &library_root,
            );

            match std::fs::remove_file(filepath) {
                Ok(_) => deleted_ids.push(id.clone()),
                Err(error) => {
                    log::warn!(
                        "[batch_delete_files_permanently] Failed to delete {}: {}",
                        filepath,
                        error
                    );
                    failed += 1;
                }
            }
        }

        if !deleted_ids.is_empty() {
            let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for id in &deleted_ids {
                crate::db::crud::delete_media_file(&tx, id).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(BatchFileOperationResult {
            succeeded: deleted_ids.len(),
            failed,
            first_error: None,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 另存为 - 打开系统保存对话框并复制文件
#[command]
pub async fn save_file_as(handle: AppHandle, source_path: String) -> Result<String, String> {
    eprintln!("[save_file_as] Saving file: {}", source_path);

    // 路径守卫（B 类）：源文件做存在性 + 规范化校验；目标走系统保存对话框，可在库外。
    let source_path = validate_existing_local_path(&source_path)?
        .to_string_lossy()
        .to_string();

    // èŽ·å–é»˜è®¤æ–‡ä»¶å
    let default_name = std::path::Path::new(&source_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    // ä½¿ç“¨ blocking_save_fileï¼ˆåœ¨åŽå°çº¿ç¨‹ä¸­è¿è¡Œï¼‰
    let source_path_clone = source_path.clone();
    let handle_clone = handle.clone();

    tokio::task::spawn_blocking(move || {
        // åœ¨ä¸»çº¿ç¨‹ä¸Šè¿è¡Œå¯¹è¯æ¡†
        let (tx, rx) = std::sync::mpsc::channel();

        handle
            .run_on_main_thread(move || {
                let file_path = handle_clone
                    .dialog()
                    .file()
                    .set_title("另存为")
                    .set_file_name(&default_name)
                    .blocking_save_file();

                let result = match file_path {
                    Some(path) => {
                        // ä½¿ç“¨ into_path() æ–¹æ³•è½¬æ¢ FilePath ä¸º PathBuf
                        match path.into_path() {
                            Ok(path_buf) => match std::fs::copy(&source_path_clone, &path_buf) {
                                Ok(_) => Ok(path_buf.to_string_lossy().to_string()),
                                Err(e) => Err(format!("Failed to copy file: {}", e)),
                            },
                            Err(e) => Err(format!("Failed to convert path: {}", e)),
                        }
                    }
                    None => Err("用户取消".to_string()),
                };

                let _ = tx.send(result);
            })
            .map_err(|e| format!("Failed to run on main thread: {}", e))?;

        rx.recv()
            .unwrap_or_else(|e| Err(format!("Channel error: {}", e)))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// 将 base64 图片数据写入临时文件，返回临时文件路径
#[command]
pub async fn write_temp_file(base64_data: String) -> Result<String, String> {
    eprintln!("[write_temp_file] Writing base64 image to temp file");

    // Determine file extension from original data URL if available
    let extension = if base64_data.starts_with("data:image/") {
        let mime_part = &base64_data[..base64_data.find(';').unwrap_or(base64_data.len())];
        match mime_part.split('/').next_back() {
            Some("jpeg") | Some("jpg") => ".jpg",
            Some("png") => ".png",
            Some("gif") => ".gif",
            Some("webp") => ".webp",
            _ => ".png", // default
        }
    } else {
        ".png" // default
    };

    // Remove data URL prefix if present (e.g., "data:image/png;base64,")
    let base64_content = if let Some(pos) = base64_data.find(',') {
        base64_data[pos + 1..].to_string()
    } else {
        base64_data
    };

    // Decode base64
    let engine = base64::engine::general_purpose::STANDARD;
    let decoded_bytes = base64::Engine::decode(&engine, &base64_content)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // Create a temporary file with unique name
    let temp_dir = std::env::temp_dir();
    let unique_filename = format!(
        "nocturne_paste_{}_{}",
        chrono::Utc::now().timestamp_millis(),
        extension
    );
    let temp_path = temp_dir.join(unique_filename);
    let temp_path_str = temp_path.to_string_lossy().to_string();

    eprintln!("[write_temp_file] Creating temp file: {}", temp_path_str);

    // Write bytes to temp file
    std::fs::write(&temp_path, decoded_bytes)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    eprintln!(
        "[write_temp_file] Temp file created successfully: {}",
        temp_path_str
    );
    Ok(temp_path_str)
}

/// 从图片文件中提取主要颜色（带缓存）
#[command]
pub async fn import_generated_image_to_ai_prompts(
    handle: AppHandle,
    source_path: String,
    prompt: String,
    model: String,
) -> Result<MediaFile, String> {
    let trimmed_prompt = prompt.trim().to_string();
    if trimmed_prompt.is_empty() {
        return Err("生成图片的提示词不能为空".to_string());
    }

    let handle_for_task = handle.clone();
    tokio::task::spawn_blocking(move || {
        let source_path_buf = std::path::PathBuf::from(&source_path);
        if !source_path_buf.is_file() {
            return Err("生成图片临时文件不存在".to_string());
        }

        let library_root = library_root(&handle_for_task)?;
        let db = db_path(&handle_for_task)?;
        let target_root = std::path::Path::new(&library_root).join("AI 提示词库");
        std::fs::create_dir_all(&target_root)
            .map_err(|e| format!("Failed to create AI prompt target folder: {}", e))?;

        let extension = source_path_buf
            .extension()
            .and_then(|ext| ext.to_str())
            .filter(|ext| !ext.trim().is_empty())
            .unwrap_or("png");

        let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut target_path = target_root.join(format!("ai-generated-{}.{}", timestamp, extension));
        let mut suffix = 1;
        while target_path.exists() {
            target_path = target_root.join(format!(
                "ai-generated-{}-{}.{}",
                timestamp, suffix, extension
            ));
            suffix += 1;
        }

        // 路径守卫（A 类）：生成图落盘目标必须落在库根之内。
        let target_path =
            resolve_under_library_root(&target_path.to_string_lossy(), &library_root)?;
        let target_path_str = target_path.to_string_lossy().to_string();
        let filename = target_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("ai-generated.png")
            .to_string();

        let _ = handle_for_task.emit(
            "import_progress",
            serde_json::json!({
                "current": 0,
                "total": 1,
                "filename": filename,
            }),
        );

        std::fs::copy(&source_path_buf, &target_path)
            .map_err(|e| format!("Failed to save generated image: {}", e))?;

        scanner::scan_single_file(&target_path_str, &db, "", &library_root)
            .map_err(|e| format!("Failed to import generated image: {}", e))?;

        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let media_file = media_file_by_filepath(&conn, &target_path_str)?;
        crate::db::crud::upsert_ai_metadata(
            &conn,
            &media_file.id,
            &trimmed_prompt,
            &model,
            "OpenAI-compatible",
        )
        .map_err(|e| e.to_string())?;

        let _ = handle_for_task.emit(
            "import_progress",
            serde_json::json!({
                "current": 1,
                "total": 1,
                "filename": media_file.filename,
            }),
        );
        let _ = handle_for_task.emit("import_complete", serde_json::json!({ "total": 1 }));
        let _ = handle_for_task.emit(
            "media_metadata_updated",
            serde_json::json!({ "id": media_file.id }),
        );

        Ok(media_file)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn extract_colors(
    handle: AppHandle,
    media_id: String,
    file_path: String,
) -> Result<Vec<String>, String> {
    eprintln!(
        "[extract_colors] Extracting colors from: {} for media_id: {}",
        file_path, media_id
    );

    // é¦–å…ˆæ£€æŸ¥æ•°æ®åº“ä¸­æ˜¯å¦å·²æœ‰ç¼“å­˜
    let db = db_path(&handle)?;
    let cached_colors: Option<String> = tokio::task::spawn_blocking({
        let db = db.clone();
        let media_id = media_id.clone();
        move || -> Result<Option<String>, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let color_dominant: Option<String> = conn
                .query_row(
                    "SELECT color_dominant FROM media_files WHERE id = ?",
                    rusqlite::params![media_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(color_dominant)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // å¦‚æžœå·²æœ‰ç¼“å­˜ï¼Œç›´æŽ¥è¿“å›ž
    if let Some(colors_json) = cached_colors {
        if !colors_json.is_empty() {
            eprintln!("[extract_colors] Using cached colors: {}", colors_json);
            // è§£æž JSON æ•°ç»„
            let colors: Vec<String> = serde_json::from_str(&colors_json)
                .map_err(|e| format!("Failed to parse cached colors: {}", e))?;
            return Ok(colors);
        }
    }

    eprintln!("[extract_colors] No cache found, extracting from image...");

    // 路径守卫（B 类）：可能读取外部附件，做存在性 + 规范化校验（拒绝 `..` 穿越），不强制库内。
    let file_path = validate_existing_local_path(&file_path)?
        .to_string_lossy()
        .to_string();

    // 没有缓存，从图片提取（复用公共函数）
    let file_path_clone = file_path.clone();
    let top_colors: Vec<String> =
        tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
            let img = image::open(&file_path_clone)
                .map_err(|e| format!("Failed to open image: {}", e))?;
            Ok(crate::media::thumbnail::extract_dominant_colors(&img))
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!(
        "[extract_colors] Extracted {} colors: {:?}",
        top_colors.len(),
        top_colors
    );

    // ç¼“å­˜åˆ°æ•°æ®åº“
    let colors_json = serde_json::to_string(&top_colors)
        .map_err(|e| format!("Failed to serialize colors: {}", e))?;

    tokio::task::spawn_blocking({
        let db = db.clone();
        let media_id = media_id.clone();
        let colors_json = colors_json.clone();
        move || -> Result<(), String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE media_files SET color_dominant = ? WHERE id = ?",
                rusqlite::params![colors_json, media_id],
            )
            .map_err(|e| e.to_string())?;
            eprintln!(
                "[extract_colors] Cached colors to database for media_id: {}",
                media_id
            );
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(top_colors)
}

/// Save clipboard image directly to library folder
#[command]
pub async fn save_clipboard_image(
    handle: AppHandle,
    file_name: String,
    image_bytes: Vec<u8>,
    target_folder: Option<String>,
    target_category: Option<String>,
) -> Result<String, String> {
    eprintln!(
        "[save_clipboard_image] Saving clipboard image: {}",
        file_name
    );

    // Get library root directory using the existing function
    let library_root = library_root(&handle)?;
    eprintln!("[save_clipboard_image] Library root: {}", library_root);

    // Determine target folder based on current context.
    let target_folder = target_folder.unwrap_or_else(|| "灵感库".to_string());
    // 路径守卫（A 类）：目标文件夹必须是库内相对目录。
    let target_folder = validate_library_relative_folder(&target_folder)?;
    let target_path = std::path::Path::new(&library_root)
        .join(&target_folder)
        .join(&file_name);

    // 路径守卫（A 类）：剪贴板图片落盘目标必须落在库根之内（同时拦截 file_name 中的穿越）。
    let target_path = resolve_under_library_root(&target_path.to_string_lossy(), &library_root)?;
    let target_path_str = target_path.to_string_lossy().to_string();
    eprintln!("[save_clipboard_image] Target path: {}", target_path_str);

    // Ensure target folder exists
    let _ = handle.emit(
        "import_progress",
        serde_json::json!({
            "current": 0,
            "total": 1,
            "filename": file_name.clone(),
        }),
    );
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create target folder: {}", e))?;
    }

    // Write image bytes directly to the target file
    std::fs::write(&target_path, image_bytes)
        .map_err(|e| format!("Failed to write image file: {}", e))?;

    eprintln!(
        "[save_clipboard_image] Image saved successfully: {}",
        target_path_str
    );

    // Scan the imported file into the database
    let db = db_path(&handle)?;
    // ç¼©ç•¥å›¾ç›®å½•ä½¿ç“¨åº“æ ¹ç›®å½•ä¸‹çš„ .nocturne/thumbs
    let thumbs = std::path::Path::new(&library_root)
        .join(".nocturne")
        .join("thumbs")
        .to_string_lossy()
        .to_string();

    // Clone target_path_str and library_root to use them after the move into the closure
    let path_for_log = target_path_str.clone();
    let library_root_clone = library_root.clone();
    let db_for_scan = db.clone();
    tokio::task::spawn_blocking(move || {
        eprintln!("[save_clipboard_image] Scanning imported file...");
        scanner::scan_single_file(&path_for_log, &db_for_scan, &thumbs, &library_root_clone)
            .map_err(|e| format!("Failed to scan file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[save_clipboard_image] Scan failed: {}", e);
        e
    })?;

    assign_category_for_filepath(&db, &target_path_str, target_category.as_deref()).map_err(
        |e| {
            eprintln!("[save_clipboard_image] Category assignment failed: {}", e);
            e
        },
    )?;

    eprintln!(
        "[save_clipboard_image] File saved and scanned successfully: {}",
        target_path_str
    );
    let _ = handle.emit(
        "import_progress",
        serde_json::json!({
            "current": 1,
            "total": 1,
            "filename": file_name,
        }),
    );
    let _ = handle.emit("import_complete", serde_json::json!({ "total": 1 }));
    Ok(target_path_str)
}
