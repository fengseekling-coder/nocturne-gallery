pub mod db;
pub mod media;
pub mod models;
mod commands;

use commands::*;
use media::thumbnail_queue::ThumbnailQueue;
use media::watcher::LibraryWatcher;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use tauri::Manager;

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

/// æ£€æŸ¥å¹¶é‡æ–°ç”Ÿæˆç¼ºå¤±çš„ç¼©ç•¥å›¾
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // åˆ›å»ºç¼©ç•¥å›¾é˜Ÿåˆ—
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
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let app_handle = app.handle().clone();
            let is_dev = cfg!(debug_assertions);
            if is_dev {
                log_startup(true, "[setup] Dev mode: thumbnail queue processor will start on demand only");
            } else {
                thumbnail_queue.start_processor(app_handle.clone());
            }

            // 从 AppData/.nocturne/config.json 读取 library_root
            let config_path = data_dir.join(".nocturne/config.json");
            let library_root_opt: Option<String> = std::fs::read_to_string(&config_path).ok()
                .and_then(|c| serde_json::from_str::<media::watcher::LibraryConfig>(&c).ok())
                .map(|c| c.root_path);

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

                    match LibraryWatcher::new(root_path, &db_path) {
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
                        if is_dev {
                            log_startup(true, "[setup] Dev mode: startup heavy tasks disabled");
                            log_startup(true, "[setup] Background initialization thread completed");
                            return;
                        }

                        std::thread::sleep(std::time::Duration::from_secs(1));

                        let count = db::open_conn(&db_path_clone)
                            .ok()
                            .and_then(|conn| {
                                conn.query_row(
                                    "SELECT COUNT(*) FROM media_files",
                                    [],
                                    |r| r.get::<_, i64>(0),
                                ).ok()
                            })
                            .unwrap_or(0);

                        if count == 0 {
                            log_startup_error("[setup] Empty database detected, auto-scanning library...");
                            match media::scanner::scan_directory(&root_clone, &db_path_clone, "") {
                                Ok(r) => log_startup_error(&format!(
                                    "[setup] Auto-scan completed: scanned={}, imported={}",
                                    r.scanned_count, r.imported_count
                                )),
                                Err(e) => log_startup_error(&format!("[setup] Auto-scan failed: {}", e)),
                            }
                        }

                        let db_for_backfill = db_path_clone.clone();
                        let app_handle_for_backfill = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = commands::run_micro_backfill(
                                &app_handle_for_backfill,
                                &db_for_backfill,
                                startup_backfill_shutdown,
                                5,
                                Some(5000),
                                None,
                                None,
                            ).await {
                                log::warn!("[startup_backfill] failed: {}", e);
                            }
                        });

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

            Ok(())
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
            empty_trash,
            init_library,
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
            generate_preview_thumbnail_for_item,
            count_missing_thumbnails,
            rebuild_missing_thumbnails,
            cancel_rebuild_thumbnails,
            repair_missing_dimensions,
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
        .expect("error while running tauri application");
}
