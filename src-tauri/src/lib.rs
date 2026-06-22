mod commands;
pub mod db;
pub mod media;
mod menu;
pub mod models;

use commands::*;
use commands::DestructiveTokenStore;
use media::thumbnail_queue::ThumbnailQueue;
use media::watcher::LibraryWatcher;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{Emitter, Manager};

fn log_startup(is_dev: bool, message: &str) {
    if !is_dev {
        eprintln!("{}", message);
    }
}

fn log_startup_error(message: &str) {
    eprintln!("{}", message);
}

// 全局应用状态
pub struct AppState {
    pub thumbnail_queue: Arc<ThumbnailQueue>,
    /// 启动 micro backfill 的中断标志
    pub startup_backfill_shutdown: Arc<AtomicBool>,
    /// 手动 micro backfill 的中断标志
    pub manual_micro_backfill_shutdown: Arc<AtomicBool>,
    /// 持有 LibraryWatcher，避免创建后立即 drop
    pub library_watcher: Mutex<Option<LibraryWatcher>>,
    /// 后台初始化线程句柄（用于应用退出时等待完成）
    pub background_thread: Mutex<Option<JoinHandle<()>>>,
}

/// 初始化 Tauri 应用并启动缩略图队列、库监听和后台维护任务。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 创建缩略图队列
    let thumbnail_queue = Arc::new(ThumbnailQueue::new());
    let startup_backfill_shutdown = Arc::new(AtomicBool::new(false));
    let manual_micro_backfill_shutdown = Arc::new(AtomicBool::new(false));

    // 创建后台线程句柄存储（在 Mutex 中以支持跨线程访问）
    let background_thread_handle: Arc<Mutex<Option<JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let background_thread_handle_clone = Arc::clone(&background_thread_handle);
    let startup_backfill_shutdown_clone = Arc::clone(&startup_backfill_shutdown);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            thumbnail_queue: Arc::clone(&thumbnail_queue),
            startup_backfill_shutdown: Arc::clone(&startup_backfill_shutdown),
            manual_micro_backfill_shutdown: Arc::clone(&manual_micro_backfill_shutdown),
            library_watcher: Mutex::new(None),
            background_thread: Mutex::new(None),
        })
        .manage(DestructiveTokenStore(Mutex::new(HashMap::new())))
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let app_handle = app.handle().clone();
            let is_dev = cfg!(debug_assertions);
            thumbnail_queue.start_processor(app_handle.clone());
            if is_dev {
                log_startup(true, "[setup] Dev mode: thumbnail queue + limited micro backfill enabled");
            }

            // 从 AppData/.nocturne/config.json 读取并规范化 library_root（与用户所选目录一致）
            let config_path = data_dir.join(".nocturne/config.json");
            let library_root_opt: Option<String> =
                media::watcher::configured_library_root_from_app_data(&data_dir);
            if let Some(ref root) = library_root_opt {
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    if let Ok(config) =
                        serde_json::from_str::<media::watcher::LibraryConfig>(&content)
                    {
                        if config.root_path != *root {
                            let updated = media::watcher::LibraryConfig {
                                root_path: root.clone(),
                                version: config.version,
                            };
                            if let Ok(json) = serde_json::to_string_pretty(&updated) {
                                let _ = std::fs::write(&config_path, json);
                            }
                        }
                    }
                }
            }

            // 计算 db_path：有库配置时用 {library_root}/.nocturne/nocturne.db，否则回落 AppData
            let db_path = if let Some(ref root) = library_root_opt {
                let new_db = std::path::Path::new(root)
                    .join(".nocturne")
                    .join("nocturne.db")
                    .to_string_lossy()
                    .to_string();

                // 自动迁移：AppData/nocturne.db 存在且新路径不存在时复制过去
                let old_db = data_dir.join("nocturne.db");
                if old_db.exists() && !std::path::Path::new(&new_db).exists() {
                    eprintln!("[setup] Migrating database to library: {}", new_db);
                    if let Some(parent) = std::path::Path::new(&new_db).parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    match std::fs::copy(&old_db, &new_db) {
                        Ok(_) => eprintln!("[setup] Database migrated successfully"),
                        Err(e) => eprintln!("[setup] Migration failed, will init fresh DB: {}", e),
                    }
                }

                new_db
            } else {
                data_dir.join("nocturne.db").to_string_lossy().to_string()
            };

            // 初始化数据库（建表 / schema 迁移）
            db::init_db(&db_path).map_err(|e| e.to_string())?;

            // 启动文件监控 + 缩略图补全
            if let Some(ref root_path) = library_root_opt {
                if media::watcher::is_valid_library_root(root_path) {
                    log_startup(is_dev, &format!("[setup] Library root configured: {}", root_path));

                    // Allow the library root directory in the asset protocol scope so
                    // thumbnails and media files can be served via convertFileSrc.
                    // scope in tauri.conf.json is [] (empty); we add paths here at runtime
                    // so the scope stays as narrow as the current library root.
                    if let Err(e) = app_handle.asset_protocol_scope().allow_directory(
                        std::path::Path::new(root_path),
                        true,
                    ) {
                        log::warn!("[setup] Failed to allow library root in asset scope: {}", e);
                    }

                    if let Ok(mut conn) = db::open_conn(&db_path) {
                        if let Ok(n) = db::crud::repair_unix_path_separators_in_media_paths(&conn) {
                            if n > 0 {
                                log_startup(
                                    is_dev,
                                    &format!("[setup] Fixed {} path fields (backslash → slash)", n),
                                );
                            }
                        }
                        match db::crud::update_library_root_prefixes(&mut conn, root_path) {
                            Ok(n) if n > 0 => {
                                log_startup(
                                    is_dev,
                                    &format!("[setup] Repaired {} stale path fields in DB", n),
                                );
                            }
                            Ok(_) => {}
                            Err(e) => log::warn!("[setup] Library path rebase failed: {}", e),
                        }
                        if let Ok(n) =
                            crate::media::path_util::relink_media_filepaths_in_db(&conn, root_path)
                        {
                            if n > 0 {
                                log_startup(
                                    is_dev,
                                    &format!("[setup] Relinked {} media paths to files on disk", n),
                                );
                            }
                        }
                        match crate::media::trash_reconcile::reconcile_trashed_media_with_disk(
                            &conn,
                            root_path,
                        ) {
                            Ok(rep) if rep.moved_to_trash_dir > 0
                                || rep.db_path_updated > 0
                                || rep.orphaned_trash_records > 0
                                || rep.failed > 0 =>
                            {
                                log_startup(
                                    is_dev,
                                    &format!(
                                        "[setup] Trash reconcile: scanned={} ok={} moved={} path_fix={} orphaned={} failed={}",
                                        rep.scanned,
                                        rep.already_ok,
                                        rep.moved_to_trash_dir,
                                        rep.db_path_updated,
                                        rep.orphaned_trash_records,
                                        rep.failed
                                    ),
                                );
                            }
                            Ok(_) => {}
                            Err(e) => log::warn!("[setup] Trash reconcile failed: {}", e),
                        }
                    }

                    match LibraryWatcher::new(root_path, &db_path, app_handle.clone()) {
                        Ok(watcher) => {
                            let state = app_handle.state::<AppState>();
                            let mut guard = state.library_watcher.lock().unwrap_or_else(|e| {
                                log::warn!("[setup] Library watcher mutex poisoned: {}", e);
                                e.into_inner()
                            });
                            *guard = Some(watcher);
                            log_startup(is_dev, "[setup] File watcher started");
                        }
                        Err(e) => log_startup_error(&format!("[setup] Failed to start file watcher: {}", e)),
                    }

                    let db_path_clone = db_path.clone();
                    let root_clone = root_path.clone();
                    let startup_backfill_shutdown = Arc::clone(&startup_backfill_shutdown_clone);
                    let handle = std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(1));

                        let count = db::open_conn(&db_path_clone)
                            .ok()
                            .and_then(|conn| {
                                conn.query_row(
                                    "SELECT COUNT(*) FROM media_files",
                                    [],
                                    |r| r.get::<_, i64>(0),
                                )
                                .ok()
                            })
                            .unwrap_or(0);

                        if count == 0 {
                            log_startup_error("[setup] Empty database detected, auto-scanning library...");
                            match media::scanner::scan_directory(&root_clone, &db_path_clone, "") {
                                Ok(r) => {
                                    log_startup_error(&format!(
                                        "[setup] Auto-scan completed: scanned={}, imported={}",
                                        r.scanned_count, r.imported_count
                                    ));
                                    if r.imported_count > 0 {
                                        let _ = app_handle.emit(
                                            "library_files_imported",
                                            serde_json::json!({ "imported": r.imported_count }),
                                        );
                                    }
                                }
                                Err(e) => log_startup_error(&format!("[setup] Auto-scan failed: {}", e)),
                            }
                        } else {
                            match media::library_sync::sync_library_from_disk(
                                &root_clone,
                                &db_path_clone,
                            ) {
                                Ok(r) => {
                                    log_startup(is_dev, &format!(
                                        "[setup] Startup disk sync: scanned={}, imported={}, skipped={}",
                                        r.scanned_count, r.imported_count, r.skipped_count
                                    ));
                                    if r.imported_count > 0 {
                                        let _ = app_handle.emit(
                                            "library_files_imported",
                                            serde_json::json!({ "imported": r.imported_count }),
                                        );
                                    }
                                }
                                Err(e) => log::warn!("[setup] Startup disk sync failed: {}", e),
                            }
                        }

                        let db_for_backfill = db_path_clone.clone();
                        let app_handle_for_backfill = app_handle.clone();
                        let backfill_delay = if is_dev { 2 } else { 5 };
                        let backfill_max = if is_dev { Some(800) } else { Some(5000) };
                        let shutdown_micro = Arc::clone(&startup_backfill_shutdown);
                        let shutdown_design = Arc::clone(&startup_backfill_shutdown);
                        let app_micro = app_handle_for_backfill.clone();
                        let app_design = app_handle_for_backfill.clone();
                        let db_micro = db_for_backfill.clone();
                        let db_design = db_for_backfill.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = commands::run_micro_backfill(
                                &app_micro,
                                &db_micro,
                                shutdown_micro,
                                backfill_delay,
                                backfill_max,
                                None,
                                None,
                            )
                            .await
                            {
                                log::warn!("[startup_backfill] failed: {}", e);
                            }
                        });
                        let design_delay = backfill_delay.saturating_add(3);
                        let design_max = if is_dev { Some(80) } else { Some(200) };
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = commands::run_design_source_backfill(
                                &app_design,
                                &db_design,
                                shutdown_design,
                                design_delay,
                                design_max,
                            )
                            .await
                            {
                                log::warn!("[design_backfill] failed: {}", e);
                            }
                        });
                        if is_dev {
                            log_startup(true, "[setup] Dev mode: micro + design source backfill scheduled");
                        }

                        log_startup_error("[setup] Background thumbnail backfill scheduled");
                        log_startup_error("[setup] Background initialization thread completed");
                    });

                    // 存储线程句柄以供后续清理
                    *background_thread_handle_clone.lock().unwrap_or_else(|e| { log::warn!("[setup] Mutex poisoned: {}", e); e.into_inner() }) = Some(handle);
                } else {
                    eprintln!("[setup] Library root not valid: {}", root_path);
                }
            } else {
                eprintln!("[setup] No library root configured, showing setup UI");
            }

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }

            if let Ok(app_menu) = menu::build_app_menu(app.handle()) {
                app.set_menu(app_menu)?;
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_menu_event(app, event.id().as_ref());
        })
        // 应用退出时的清理钩子
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                log_startup_error("[on_window_event] CloseRequested, cleaning up background thread...");
                startup_backfill_shutdown.store(true, Ordering::Relaxed);
                if let Some(handle) = background_thread_handle.lock().unwrap_or_else(|e| { log::warn!("[cleanup] Mutex poisoned: {}", e); e.into_inner() }).take() {
                    log_startup_error("[on_window_event] Waiting for background thread to finish...");
                    match handle.join() {
                        Ok(()) => log_startup_error("[on_window_event] Background thread joined successfully"),
                        Err(e) => log_startup_error(&format!("[on_window_event] Background thread panicked: {:?}", e)),
                    }
                }
                let watcher = {
                    let state = window.state::<AppState>();
                    let watcher = state.library_watcher.lock().unwrap_or_else(|e| { log::warn!("[cleanup] Watcher mutex poisoned: {}", e); e.into_inner() }).take();
                    watcher
                };
                if let Some(watcher) = watcher {
                    watcher.stop();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            scan_library,
            sync_library_from_disk,
            rescan_library,
            get_media_files,
            get_media_detail,
            get_group_item_counts,
            get_nav_item_counts,
            add_media_attachments,
            remove_media_attachment,
            get_attachment_preview_data,
            read_media_file_as_base64,
            read_attachment_file_as_base64,
            read_attachment_preview,
            update_ai_metadata,
            update_tags,
            generate_thumbnail,
            move_to_trash,
            batch_move_to_trash,
            restore_from_trash,
            batch_restore_from_trash,
            reconcile_trash_with_disk,
            get_trash_diagnostics,
            empty_trash,
            request_destructive_token,
            init_library,
            get_native_platform,
            get_library_root,
            set_library_root,
            clear_all_media,
            rename_file,
            move_file_to_folder,
            import_file_to_library,
            import_paths_to_library,
            add_bookmark,
            get_bookmarks,
            delete_bookmark,
            update_bookmark,
            open_url_in_browser,
            delete_file_permanently,
            batch_delete_files_permanently,
            save_file_as,
            write_temp_file,
            import_generated_image_to_ai_prompts,
            extract_colors,
            save_clipboard_image,
            rehydrate_all_media_metadata,
            regenerate_all_thumbnails,
            regenerate_missing_micro,
            force_clear_thumbnails,
            emergency_cleanup_invalid_files,
            get_all_file_paths,
            fix_paste_filenames,
            get_preference,
            set_preference,
            load_ai_chat_session,
            save_ai_chat_session,
            delete_ai_chat_session,
            check_duplicate,
            backfill_file_hashes,
            get_file_info,
            replace_file,
            check_ffmpeg_available,            // v5.8: Multi-tier thumbnail commands
            ensure_media_preview_thumbnails,
            generate_preview_thumbnail_for_item,
            count_missing_thumbnails,
            rebuild_missing_thumbnails,
            cancel_rebuild_thumbnails,
            repair_missing_dimensions,
            probe_image_dimensions,
            update_media_dimensions,
            start_file_drag,
            show_in_folder,
            open_path,
            // AI Agent å·¥å…·
            commands::ai_tools::ai_search_library,
            commands::ai_tools::ai_add_tags,
            commands::ai_tools::ai_set_category,
            commands::ai_tools::ai_get_item_detail,
            commands::ai_tools::ai_update_prompt,
            commands::ai_tools::ai_batch_get_items,
            commands::ai_tools::ai_reverse_prompt,
            commands::ai_tools::ai_get_library_stats,
            commands::ai_tools::ai_web_search_save,
            commands::ai_tools::batch_add_tags,
            commands::ai_tools::openai_get_config,
            commands::ai_tools::openai_list_models,
            commands::ai_tools::openai_chat_completion,
            commands::ai_tools::openai_generate_image,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("Gega Gallery 启动失败：{}", error);
            std::process::exit(1);
        });
}
