//! P1-1 后台数据回填模块
//!
//! 集中处理"扫描后增量补全"的批处理:文件 hash 回填、micro 缩略图回填、design source 回填。
//! 这些函数通常由 lib.rs 在启动时调用,而非从前端 invoke。
use crate::commands::{db_path, library_root};
use crate::db::open_conn;
use crate::media::hash as image_hash;

// P1-1 大搬后的简化常量 — 原 mod.rs 中是 `static AtomicBool`/`OnceLock` 全局变量。
// 这里保持 `static AtomicBool` 直接语义,初值 false。`folder_paths_updated_once` 等
// helper 在 mod.rs 末尾的测试中不再使用(测试只测 token 行为),保留最简形式即可。
pub(crate) static REBUILD_RUNNING: AtomicBool = AtomicBool::new(false);
pub(crate) static REBUILD_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static STARTUP_BACKFILL_QUEUED: AtomicBool = AtomicBool::new(false);
static FOLDER_PATHS_UPDATED: AtomicBool = AtomicBool::new(false);

// StartupBackfillRow: (id, micro_path, design_source_path) — 由 startup_backfill_once 返回
type StartupBackfillRow = (String, String, Option<String>, Option<String>);
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, Manager};
pub fn startup_backfill_once() -> &'static AtomicBool {
    &STARTUP_BACKFILL_QUEUED
}

pub fn folder_paths_updated_once() -> &'static AtomicBool {
    &FOLDER_PATHS_UPDATED
}

/// 补全已有图片的 sha256 和 phash（后台批量处理）
#[command]
pub async fn backfill_file_hashes(handle: AppHandle) -> Result<String, String> {
    eprintln!("[backfill_file_hashes] Starting hash backfill");

    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        let mut total_processed = 0;
        let mut total_errors = 0;

        loop {
            let batch = crate::db::crud::backfill_hashes_batch(&conn, 50).map_err(|e| e.to_string())?;
            if batch.is_empty() {
                break;
            }

            eprintln!(
                "[backfill_file_hashes] Processing batch of {} files",
                batch.len()
            );

            for (id, filepath) in batch {
                match (
                    image_hash::compute_sha256(&filepath),
                    image_hash::compute_phash(&filepath),
                ) {
                    (Ok(sha256), Ok(phash)) => {
                        if let Err(e) = crate::db::crud::update_file_hashes(&conn, &id, &sha256, phash as i64)
                        {
                            eprintln!(
                                "[backfill_file_hashes] Failed to update hashes for {}: {}",
                                id, e
                            );
                            total_errors += 1;
                        }
                    }
                    (Err(e), _) | (_, Err(e)) => {
                        eprintln!(
                            "[backfill_file_hashes] Failed to compute hash for {}: {}",
                            filepath, e
                        );
                        total_errors += 1;
                    }
                }
                total_processed += 1;
            }
        }

        let remaining = crate::db::crud::count_missing_hashes(&conn).unwrap_or(-1);
        eprintln!(
            "[backfill_file_hashes] Done. Processed: {}, Errors: {}, Remaining: {}",
            total_processed, total_errors, remaining
        );
        Ok(format!(
            "Processed: {}, Errors: {}, Remaining: {}",
            total_processed, total_errors, remaining
        ))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Lightweight micro thumbnail backfill: regenerates micro + thumbhash for
/// files with NULL thumbnail_micro_path. Does NOT clear existing thumbnails.
/// Runs with low priority — delayed start + per-file yield to avoid blocking
/// the spawn_blocking thread pool that user-facing IPC depends on.
#[command]
pub async fn regenerate_missing_micro(
    handle: AppHandle,
    source_folder: Option<String>,
    active_nav: Option<String>,
) -> Result<String, String> {
    let marker = startup_backfill_once();
    if marker.swap(true, Ordering::Relaxed) {
        log::info!("[startup_backfill] regenerate_missing_micro already queued or running");
        return Ok("queued".to_string());
    }

    let db = db_path(&handle)?;
    let state = handle.state::<crate::AppState>();
    state
        .manual_micro_backfill_shutdown
        .store(false, Ordering::Relaxed);
    let result = run_micro_backfill(
        &handle,
        &db,
        state.manual_micro_backfill_shutdown.clone(),
        0,
        None,
        source_folder,
        active_nav,
    )
    .await;

    marker.store(false, Ordering::Relaxed);
    result
}

pub fn micro_backfill_scope_is_priority(source_folder: Option<&str>, active_nav: Option<&str>) -> bool {
    matches!(source_folder.map(str::trim), Some("灵感库"))
        || matches!(active_nav.map(str::trim), Some("library"))
}

/// 后台补齐旧库图片的 micro 缩略图，仅修复缺失或尺寸过小的旧 micro。
pub async fn run_micro_backfill(
    handle: &AppHandle,
    db: &str,
    shutdown: Arc<AtomicBool>,
    initial_delay_secs: u64,
    max_items: Option<usize>,
    source_folder: Option<String>,
    active_nav: Option<String>,
) -> Result<String, String> {
    if initial_delay_secs > 0 {
        tokio::time::sleep(std::time::Duration::from_secs(initial_delay_secs)).await;
    }

    if shutdown.load(Ordering::Relaxed) {
        return Ok("[startup_backfill] cancelled".to_string());
    }

    let db_path = db.to_string();
    let source_folder = source_folder
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let active_nav = active_nav
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let library_root_filter = library_root(handle).ok().map(|root| format!("{}%", root));
    let files = tokio::task::spawn_blocking(move || -> Result<Vec<StartupBackfillRow>, String> {
        let conn = open_conn(&db_path).map_err(|e| e.to_string())?;
        let mut stmt = if library_root_filter.is_some() {
            conn.prepare(
                "SELECT id, filepath, thumbnail_path, thumbnail_micro_path, COALESCE(source_folder, '')
                 FROM media_files
                 WHERE filetype = 'image'
                   AND is_trashed = 0
                   AND filepath LIKE ?1
                 ORDER BY imported_at DESC, id DESC"
            ).map_err(|e| e.to_string())?
        } else {
            conn.prepare(
                "SELECT id, filepath, thumbnail_path, thumbnail_micro_path, COALESCE(source_folder, '')
                 FROM media_files
                 WHERE filetype = 'image'
                   AND is_trashed = 0
                 ORDER BY imported_at DESC, id DESC"
            ).map_err(|e| e.to_string())?
        };

        let mut files = if let Some(root_like) = library_root_filter.clone() {
            let rows = stmt.query_map([root_like], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            }).map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
        } else {
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            }).map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
        };

        if micro_backfill_scope_is_priority(source_folder.as_deref(), active_nav.as_deref()) {
            files.sort_by(|a, b| {
                let a_priority = if a.4 == "灵感库" { 0 } else { 1 };
                let b_priority = if b.4 == "灵感库" { 0 } else { 1 };
                a_priority.cmp(&b_priority)
                    .then_with(|| b.0.cmp(&a.0))
            });
        }

        Ok(files.into_iter().map(|(id, filepath, thumbnail_path, thumbnail_micro_path, _scope)| {
            (id, filepath, thumbnail_path, thumbnail_micro_path)
        }).collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let total = files.len();
    if total == 0 {
        return Ok("[startup_backfill] empty".to_string());
    }

    let limit = max_items.unwrap_or(5_000).min(5_000);
    let total_to_process = total.min(limit);
    log::info!("[startup_backfill] start, count={}", total);

    let app = handle.clone();
    let db_path = db.to_string();
    let mut processed = 0usize;
    let mut last_emit = 0usize;

    for (media_id, filepath, thumbnail_path, thumbnail_micro_path) in
        files.into_iter().take(total_to_process)
    {
        if shutdown.load(Ordering::Relaxed) {
            log::warn!("[startup_backfill] cancelled by shutdown signal");
            break;
        }

        let source_path = filepath.trim();
        if source_path.is_empty() || !std::path::Path::new(source_path).is_file() {
            processed += 1;
            continue;
        }

        let source_path_buf = std::path::PathBuf::from(source_path);
        let parent_dir = source_path_buf
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        let meta_dir = parent_dir.join(".nocturne_meta");
        let _ = std::fs::create_dir_all(&meta_dir);

        let base_name = source_path_buf
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&media_id);

        let thumbnail_micro_path_buf = thumbnail_micro_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from);

        let micro_needs_regen = match thumbnail_micro_path_buf.as_ref() {
            None => true,
            Some(existing_micro_path) => {
                if !existing_micro_path.is_file() {
                    true
                } else {
                    match image::image_dimensions(existing_micro_path) {
                        Ok((width, height)) => width.max(height) < 512,
                        Err(_) => true,
                    }
                }
            }
        };

        if !micro_needs_regen {
            processed += 1;
            continue;
        }

        let micro_dst = match thumbnail_micro_path_buf {
            Some(p) if p.is_file() => p,
            _ => meta_dir.join(format!("{}_micro.webp", base_name)),
        };

        let thumbnail_src_for_task = thumbnail_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_file())
            .unwrap_or_else(|| source_path_buf.clone());

        let db_path_for_task = db_path.clone();
        let media_id_for_task = media_id.clone();
        let micro_dst_for_task = micro_dst.clone();
        let source_path_owned = source_path.to_string();

        let _ = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            if let Some(parent) = micro_dst_for_task.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            let micro_path_owned = if micro_dst_for_task.is_file() {
                Some(micro_dst_for_task.to_string_lossy().to_string())
            } else {
                let from_embedded = crate::media::thumbnail::generate_micro_from_embedded_thumbnail(
                    &source_path_owned,
                    &micro_dst_for_task,
                );
                let generated = if from_embedded.is_some() {
                    true
                } else {
                    crate::media::thumbnail::generate_micro_thumbnail(
                        &thumbnail_src_for_task,
                        &micro_dst_for_task,
                    )
                    .map(|_| micro_dst_for_task.is_file())
                    .unwrap_or(false)
                };
                if generated && micro_dst_for_task.is_file() {
                    Some(micro_dst_for_task.to_string_lossy().to_string())
                } else {
                    None
                }
            };

            if let Some(micro_path) = micro_path_owned.as_deref() {
                let conn = open_conn(&db_path_for_task).map_err(|e| e.to_string())?;
                crate::media::thumbnail::update_multi_tier_thumbnails(
                    &conn,
                    &media_id_for_task,
                    Some(micro_path),
                    None,
                    None,
                    None,
                )
                .map_err(|e| e.to_string())?;
                return Ok(true);
            }

            Ok(false)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

        processed += 1;
        if processed - last_emit >= 50 {
            last_emit = processed;
            let _ = app.emit(
                "startup_backfill_progress",
                serde_json::json!({
                    "current": processed,
                    "total": total,
                }),
            );
        }

        if processed >= total_to_process {
            break;
        }
    }

    let remaining = total.saturating_sub(processed);
    let _ = app.emit(
        "startup_backfill_complete",
        serde_json::json!({
            "processed": processed,
            "remaining": remaining,
        }),
    );
    log::info!(
        "[startup_backfill] done, processed={}, remaining={}",
        processed,
        remaining
    );
    Ok(format!("processed={}, remaining={}", processed, remaining))
}

/// 启动后补全 design/document 源文件缩略图（PSD 内嵌 + Quick Look / Shell）。
pub async fn run_design_source_backfill(
    handle: &AppHandle,
    db: &str,
    shutdown: Arc<AtomicBool>,
    initial_delay_secs: u64,
    max_items: Option<usize>,
) -> Result<String, String> {
    if initial_delay_secs > 0 {
        tokio::time::sleep(std::time::Duration::from_secs(initial_delay_secs)).await;
    }
    if shutdown.load(Ordering::Relaxed) {
        return Ok("[design_backfill] cancelled".to_string());
    }

    let library_root = library_root(handle).unwrap_or_default();
    let db_path = db.to_string();
    let root_trim = library_root.trim().to_string();

    let candidates = tokio::task::spawn_blocking(
        move || -> Result<Vec<(String, String, String, String)>, String> {
            let conn = open_conn(&db_path).map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id, filepath, filename, filetype
                 FROM media_files
                 WHERE is_trashed = 0
                   AND filetype IN ('design', 'document')
                 ORDER BY imported_at DESC, id DESC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;

            let mut out = Vec::new();
            for (id, filepath, filename, filetype) in rows {
                let ext = std::path::Path::new(&filepath)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !crate::media::design_source::needs_source_preview_for_filetype_and_ext(
                    &filetype, &ext,
                ) {
                    continue;
                }
                out.push((id, filepath, filename, filetype));
            }
            Ok(out)
        },
    )
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let limit = max_items.unwrap_or(200).min(500);
    let app = handle.clone();
    let mut processed = 0usize;
    let mut changed = 0usize;

    for (media_id, filepath, filename, filetype) in candidates.into_iter().take(limit) {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        let db_clone = db.to_string();
        let root_clone = root_trim.clone();
        let id_clone = media_id.clone();
        let fp_clone = filepath.clone();
        let name_clone = filename.clone();
        let ft_clone = filetype.clone();

        let did_change = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            let conn = open_conn(&db_clone).map_err(|e| e.to_string())?;
            let file = crate::db::crud::get_media_file_by_id(&conn, &id_clone).map_err(|e| e.to_string())?;
            if crate::media::design_source::has_modern_webp_tiers(
                file.thumbnail_micro_path.as_deref(),
                file.thumbnail_path.as_deref(),
                file.thumbnail_preview_path.as_deref(),
            ) {
                return Ok(false);
            }

            let root_opt = if root_clone.is_empty() {
                None
            } else {
                Some(root_clone.as_str())
            };
            let Some(resolved) = crate::media::path_util::resolve_media_file_on_disk(
                &fp_clone,
                root_opt,
                Some(&name_clone),
            ) else {
                return Ok(false);
            };
            let disk_path = resolved.to_string_lossy().to_string();
            if disk_path != fp_clone {
                let _ = conn.execute(
                    "UPDATE media_files SET filepath = ?1 WHERE id = ?2",
                    rusqlite::params![disk_path, id_clone],
                );
            }

            let ext = crate::media::design_source::ext_lower_from_path(&resolved);
            let meta_dir = resolved
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join(".nocturne_meta");

            let before_micro = file.thumbnail_micro_path.clone();
            let before_std = file.thumbnail_path.clone();

            let _ = crate::media::design_source::ensure_source_preview_thumbnails(
                &id_clone,
                &disk_path,
                &name_clone,
                &meta_dir,
                &db_clone,
                &ft_clone,
                &ext,
            );

            let after = crate::db::crud::get_media_file_by_id(&conn, &id_clone).map_err(|e| e.to_string())?;
            Ok(after.thumbnail_micro_path != before_micro || after.thumbnail_path != before_std)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

        processed += 1;
        if did_change {
            changed += 1;
            let _ = app.emit(
                "media_metadata_updated",
                serde_json::json!({ "id": media_id }),
            );
        }
    }

    log::info!(
        "[design_backfill] done processed={} changed={}",
        processed,
        changed
    );
    Ok(format!(
        "design_backfill processed={} changed={}",
        processed, changed
    ))
}
