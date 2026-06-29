//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
use crate::commands::{
    db_path, folder_paths_updated_once, library_root,
};
use crate::commands::destructive::consume_destructive_token;
use crate::commands::media::encode_rgba_preview_data_url;
use crate::db::open_conn;
use crate::media::{hash as image_hash, watcher};
use crate::media::watcher::LibraryWatcher;
use crate::models::ScanResult;
use crate::AppState;
use rusqlite::OptionalExtension;
use std::sync::atomic::Ordering;
use tauri::{command, AppHandle, Emitter, Manager};
pub fn validate_existing_local_path(path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return Err("路径无效".to_string());
    }
    std::fs::canonicalize(trimmed).map_err(|e| format!("无法访问路径：{}", e))
}

pub fn assign_category_for_filepath(
    db_path: &str,
    filepath: &str,
    category_name: Option<&str>,
) -> Result<(), String> {
    let Some(category_name) = category_name.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(());
    };

    let conn = open_conn(db_path).map_err(|e| e.to_string())?;
    let media_id = conn
        .query_row(
            "SELECT id FROM media_files WHERE filepath = ? LIMIT 1",
            rusqlite::params![filepath],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!(
                "Imported media not found for category assignment: {}",
                filepath
            )
        })?;

    crate::db::crud::set_media_category(&conn, &media_id, category_name).map_err(|e| e.to_string())
}

/// 统一的库根落盘校验入口：对输入路径做规范化（解析符号链接、消除 `..`、借助
/// `canonicalize` 处理 macOS 大小写不敏感与 Unicode 归一化差异），确认目标位于
/// 库根之内后返回规范化的目标路径。当目标文件尚不存在（典型的落盘前场景）时，
/// 改为规范化其父目录再拼接文件名。越界或非法路径返回可读中文错误，不 panic。
pub fn resolve_under_library_root(
    input_path: &str,
    library_root: &str,
) -> Result<std::path::PathBuf, String> {
    let trimmed = input_path.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return Err("路径无效".to_string());
    }

    let root_trimmed = library_root.trim();
    if root_trimmed.is_empty() {
        return Err("未配置素材库根目录".to_string());
    }

    let canonical_root = std::fs::canonicalize(root_trimmed)
        .map_err(|e| format!("无法访问素材库根目录：{} ({})", root_trimmed, e))?;

    // 目标已存在时直接规范化（可解析符号链接与大小写差异）。
    let canonical_target = match std::fs::canonicalize(trimmed) {
        Ok(path) => path,
        Err(_) => {
            // 目标尚不存在（典型的落盘前场景）：向上找到最近的已存在祖先目录并
            // 规范化它，再拼接尚不存在的剩余路径段。剩余段中若出现 `..` 等穿越
            // 组件一律拒绝，避免绕过库根边界。
            let raw = std::path::Path::new(trimmed);
            let mut existing = raw;
            let mut tail: Vec<std::ffi::OsString> = Vec::new();
            loop {
                if existing.exists() {
                    break;
                }
                let file_name = existing
                    .file_name()
                    .ok_or_else(|| format!("路径无效：{}", input_path))?;
                tail.push(file_name.to_os_string());
                existing = existing
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .ok_or_else(|| format!("无法定位已存在的父目录：{}", input_path))?;
            }
            let mut resolved = std::fs::canonicalize(existing)
                .map_err(|e| format!("无法访问目标目录：{} ({})", existing.display(), e))?;
            for component in tail.iter().rev() {
                let comp_path = std::path::Path::new(component);
                let is_normal = comp_path
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_)));
                if !is_normal {
                    return Err("路径包含非法的穿越组件".to_string());
                }
                resolved.push(component);
            }
            resolved
        }
    };

    if canonical_target == canonical_root || canonical_target.starts_with(&canonical_root) {
        Ok(canonical_target)
    } else {
        Err(format!(
            "路径超出素材库范围（目标：{}，库根：{}）",
            canonical_target.display(),
            canonical_root.display()
        ))
    }
}

pub fn is_supported_import_file(path: &std::path::Path) -> bool {
    let ext = match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => ext.to_ascii_lowercase(),
        None => return false,
    };

    matches!(
        ext.as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "bmp"
            | "tiff"
            | "avif"
            | "heic"
            | "svg"
            | "mp4"
            | "mov"
            | "avi"
            | "mkv"
            | "webm"
            | "flv"
            | "obj"
            | "fbx"
            | "glb"
            | "gltf"
            | "blend"
            | "stl"
            | "pdf"
            | "psd"
            | "ai"
            | "sketch"
            | "fig"
            | "xd"
            | "zip"
            | "rar"
    )
}

pub fn read_pending_import_preview_data_url(path: &str) -> Result<String, String> {
    use image::imageops::FilterType;

    let path_buf = std::path::PathBuf::from(path);
    let ext = path_buf
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "preview_unavailable".to_string())?;

    if !matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif"
    ) {
        return Err("preview_unavailable".to_string());
    }

    let metadata =
        std::fs::symlink_metadata(&path_buf).map_err(|_| "preview_unavailable".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() > 8 * 1024 * 1024
    {
        return Err("preview_unavailable".to_string());
    }

    let file = std::fs::File::open(&path_buf).map_err(|_| "preview_unavailable".to_string())?;
    let reader = std::io::BufReader::new(file);
    let image = image::load(
        reader,
        image::ImageFormat::from_extension(&ext)
            .ok_or_else(|| "preview_unavailable".to_string())?,
    )
    .map_err(|_| "preview_unavailable".to_string())?;

    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Err("preview_unavailable".to_string());
    }

    let max_side = width.max(height);
    let resized = if max_side > 512 {
        let scale = 512.0 / max_side as f32;
        let new_width = (width as f32 * scale).round().max(1.0) as u32;
        let new_height = (height as f32 * scale).round().max(1.0) as u32;
        image.resize(new_width, new_height, FilterType::Lanczos3)
    } else {
        image
    };

    let rgba = resized.to_rgba8();
    encode_rgba_preview_data_url(rgba.width(), rgba.height(), rgba.as_raw())
        .map_err(|_| "preview_unavailable".to_string())
}

/// 初始化灵感库根目录
///
/// 接收用户选择的父目录路径（如 H:\），
/// 在其下创建 "NocturneGallery" 文件夹，然后初始化子结构。
/// 如果 NocturneGallery 已存在则直接使用。
#[command]
pub async fn init_library(handle: AppHandle, parent_path: String) -> Result<String, String> {
    println!("init_library called with path: {}", parent_path);
    eprintln!("[init_library] Parent path provided: {}", parent_path);

    let library_root_str = ensure_switchable_library_root(&parent_path)?;

    eprintln!("[init_library] Library root will be: {}", library_root_str);

    // åˆ›å»ºç›®å½•ç»“æž„ï¼ˆå¦‚æžœå·²å­˜åœ¨åˆ™ç›´æŽ¥ä½¿ç“¨ï¼‰
    // æ›´æ–°æ•°æ®åº“ä¸­çš„è·¯å¾„（启动期仅运行一次）
    if !folder_paths_updated_once().swap(true, Ordering::Relaxed) {
        let db_path = db_path(&handle)?;
        if let Err(e) = watcher::update_folder_paths_in_db(&db_path, &library_root_str) {
            eprintln!("[init_library] Path update warning: {}", e);
        }
    }

    // ä¿å­˜é…ç½®åˆ° AppData/.nocturne/config.json
    let config = watcher::LibraryConfig {
        root_path: library_root_str.clone(),
        version: "1.0".to_string(),
    };

    let state = handle.state::<crate::AppState>();
    state
        .startup_backfill_shutdown
        .store(true, Ordering::Relaxed);

    let config_path = handle
        .path()
        .app_data_dir()
        .map(|p| {
            p.join(".nocturne/config.json")
                .to_string_lossy()
                .to_string()
        })
        .map_err(|e| format!("Failed to get config path: {}", e))?;

    // ç¡®ä¿ AppData/.nocturne ç›®å½•å­˜åœ¨
    if let Some(parent) = std::path::Path::new(&config_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let config_json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, config_json)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    // config 写入后，db_path() 已指向新路径，确保该 DB 已初始化
    // 同时处理旧 AppData/nocturne.db 的迁移
    let new_db_path = std::path::Path::new(&library_root_str)
        .join(".nocturne")
        .join("nocturne.db")
        .to_string_lossy()
        .to_string();

    let old_db_path = handle
        .path()
        .app_data_dir()
        .map(|p| p.join("nocturne.db"))
        .ok();
    if let Some(ref old_db) = old_db_path {
        if old_db.exists() && !std::path::Path::new(&new_db_path).exists() {
            eprintln!("[init_library] Migrating old database to library directory");
            match std::fs::copy(old_db, &new_db_path) {
                Ok(_) => eprintln!("[init_library] Database migrated successfully"),
                Err(e) => eprintln!("[init_library] Migration failed, will init fresh DB: {}", e),
            }
        }
    }
    if let Err(e) = crate::db::init_db(&new_db_path) {
        eprintln!(
            "[init_library] Warning: Failed to init DB at new path: {}",
            e
        );
    }

    eprintln!(
        "[init_library] Library initialized successfully at: {}",
        library_root_str
    );
    Ok(library_root_str)
}

pub fn ensure_switchable_library_root(raw_path: &str) -> Result<String, String> {
    let path = raw_path.trim();
    if path.is_empty() {
        return Err("路径为空".to_string());
    }

    if watcher::is_valid_library_root(path) {
        return watcher::normalize_library_root_path(path);
    }

    let root_path = std::path::Path::new(path);
    if !root_path.exists() {
        std::fs::create_dir_all(root_path).map_err(|e| format!("无法创建目录 {}：{}", path, e))?;
    } else if !root_path.is_dir() {
        return Err(format!("所选路径不是文件夹：{}", path));
    }

    let library_root = watcher::normalize_library_root_path(path)?;
    watcher::init_library_structure(&library_root)?;
    watcher::migrate_folder_names(&library_root)?;
    watcher::normalize_library_root_path(&library_root)
}

pub fn restart_library_watcher(handle: &AppHandle, root: &str) {
    let Ok(db) = db_path(handle) else {
        log::warn!("[set_library_root] Cannot restart watcher: db_path failed");
        return;
    };
    let state = handle.state::<AppState>();
    let mut guard = state.library_watcher.lock().unwrap_or_else(|e| {
        log::warn!("[set_library_root] Watcher mutex poisoned: {}", e);
        e.into_inner()
    });
    if let Some(old) = guard.take() {
        old.stop();
    }
    match LibraryWatcher::new(root, &db, handle.clone()) {
        Ok(watcher) => {
            *guard = Some(watcher);
            eprintln!("[set_library_root] File watcher restarted for: {}", root);
        }
        Err(e) => log::warn!("[set_library_root] Failed to restart watcher: {}", e),
    }
}

/// 获取库根目录路径
#[command]
pub async fn get_library_root(handle: AppHandle) -> Result<Option<String>, String> {
    let config_path = handle
        .path()
        .app_data_dir()
        .map(|p| {
            p.join(".nocturne/config.json")
                .to_string_lossy()
                .to_string()
        })
        .map_err(|e| format!("Failed to get config path: {}", e))?;

    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<watcher::LibraryConfig>(&content) {
            // éªŒè¯è·¯å¾„æ˜¯å¦æœ‰æ•ˆ
            if watcher::is_valid_library_root(&config.root_path) {
                let root_path = watcher::normalize_library_root_path(&config.root_path)?;

                if root_path != config.root_path {
                    let updated = watcher::LibraryConfig {
                        root_path: root_path.clone(),
                        version: config.version.clone(),
                    };
                    if let Ok(json) = serde_json::to_string_pretty(&updated) {
                        let _ = std::fs::write(&config_path, json);
                    }
                }

                if let Err(e) = watcher::migrate_folder_names(&root_path) {
                    eprintln!("[get_library_root] Migration warning: {}", e);
                }

                let db_path = db_path(&handle)?;
                if let Err(e) = watcher::update_folder_paths_in_db(&db_path, &root_path) {
                    eprintln!("[get_library_root] Path update warning: {}", e);
                }

                return Ok(Some(root_path));
            }
        }
    }

    Ok(None)
}

/// 设置库根目录路径
#[command]
pub async fn set_library_root(handle: AppHandle, path: String) -> Result<String, String> {
    eprintln!("[set_library_root] Requested path: {}", path);

    let data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let previous_root = watcher::configured_library_root_from_app_data(&data_dir);

    let library_root = ensure_switchable_library_root(&path)?;
    eprintln!("[set_library_root] Resolved library root: {}", library_root);

    if let Some(ref old) = previous_root {
        if crate::media::library_relocate::should_relocate_library_on_switch(old, &library_root) {
            {
                let state = handle.state::<AppState>();
                let mut guard = state
                    .library_watcher
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if let Some(w) = guard.take() {
                    w.stop();
                    eprintln!("[set_library_root] Stopped file watcher before library relocation");
                }
            }
            crate::media::library_relocate::relocate_library_contents(old, &library_root)?;
        }
    }

    let config = watcher::LibraryConfig {
        root_path: library_root.clone(),
        version: "1.0".to_string(),
    };

    let config_path = handle
        .path()
        .app_data_dir()
        .map(|p| {
            p.join(".nocturne/config.json")
                .to_string_lossy()
                .to_string()
        })
        .map_err(|e| format!("Failed to get config path: {}", e))?;

    if let Some(parent) = std::path::Path::new(&config_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let config_json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, config_json)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    let new_db_path = std::path::Path::new(&library_root)
        .join(".nocturne")
        .join("nocturne.db")
        .to_string_lossy()
        .to_string();

    let data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let old_appdata_db = data_dir.join("nocturne.db");
    if old_appdata_db.exists() && !std::path::Path::new(&new_db_path).exists() {
        if let Some(parent) = std::path::Path::new(&new_db_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        eprintln!(
            "[set_library_root] Migrating AppData database to library: {}",
            new_db_path
        );
        match std::fs::copy(&old_appdata_db, &new_db_path) {
            Ok(_) => eprintln!("[set_library_root] Database migrated successfully"),
            Err(e) => eprintln!("[set_library_root] Database migration failed: {}", e),
        }
    }

    if let Err(e) = crate::db::init_db(&new_db_path) {
        eprintln!(
            "[set_library_root] Warning: Failed to init DB at new path: {}",
            e
        );
    }

    if let Err(e) = watcher::migrate_folder_names(&library_root) {
        eprintln!("[set_library_root] Folder name migration warning: {}", e);
    }

    if let Ok(db) = db_path(&handle) {
        if let Err(e) = watcher::update_folder_paths_in_db(&db, &library_root) {
            eprintln!("[set_library_root] DB path prefix update warning: {}", e);
        }
    }

    if let Err(e) = handle
        .asset_protocol_scope()
        .allow_directory(std::path::Path::new(&library_root), true)
    {
        log::warn!(
            "[set_library_root] Failed to allow library root in asset scope: {}",
            e
        );
    }

    restart_library_watcher(&handle, &library_root);

    let _ = handle.emit(
        "library_root_changed",
        serde_json::json!({ "root": library_root }),
    );

    Ok(library_root)
}

/// 扫描库根目录下的所有子文件夹
#[command]
pub async fn scan_library(handle: AppHandle) -> Result<ScanResult, String> {
    sync_library_from_disk(handle).await
}

/// 增量同步：磁盘上有、数据库里没有的素材自动入库。
#[command]
pub async fn sync_library_from_disk(handle: AppHandle) -> Result<ScanResult, String> {
    let root = library_root(&handle)?;
    let db = db_path(&handle)?;

    eprintln!("[sync_library_from_disk] Syncing: {}", root);

    let result = tokio::task::spawn_blocking(move || {
        crate::media::library_sync::sync_library_from_disk(&root, &db)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!(
        "[sync_library_from_disk] scanned={}, imported={}, skipped={}",
        result.scanned_count, result.imported_count, result.skipped_count
    );
    let _ = handle.emit(
        "library_files_imported",
        serde_json::json!({ "imported": result.imported_count }),
    );
    let _ = handle.emit(
        "scan_complete",
        serde_json::json!({ "total": result.imported_count }),
    );

    Ok(result)
}

/// 清空所有媒体数据（用于重新初始化），返回删除的文件数量
#[command]
pub async fn clear_all_media(
    handle: AppHandle,
    confirmation_token: String,
) -> Result<i64, String> {
    eprintln!("[clear_all_media] Starting to clear all media...");
    consume_destructive_token(&handle, &confirmation_token, "clear_all_media")?;
    let db = db_path(&handle)?;
    let count = tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::clear_all_data(&mut conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("clear_all_data error: {}", e))?;

    eprintln!("[clear_all_media] Cleared {} media files", count);
    Ok(count)
}

/// 重新扫描：增量同步磁盘上新文件（不清空数据库）。
#[command]
pub async fn rescan_library(handle: AppHandle) -> Result<ScanResult, String> {
    eprintln!("[rescan_library] Incremental sync from disk");
    sync_library_from_disk(handle).await
}

/// 重新生成所有缩略图
/// 1. 清空 thumbs 目录
/// 2. 清空数据库中的 thumbnail_path
/// 3. 为所有图片文件重新生成缩略图并添加到队列
#[command]
pub async fn rehydrate_all_media_metadata(handle: AppHandle) -> Result<String, String> {
    eprintln!("[rehydrate_all_media_metadata] Starting metadata rehydration");

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;
    let handle_for_emit = handle.clone();

    let (summary, updated_ids) = tokio::task::spawn_blocking(move || -> Result<(String, Vec<String>), String> {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, filepath, filetype, thumbnail_path, thumbnail_micro_path, thumbnail_preview_path, thumbhash, color_dominant, sha256, phash, width, height
                 FROM media_files
                 ORDER BY imported_at ASC"
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i32>>(10)?,
                    row.get::<_, Option<i32>>(11)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut processed = 0usize;
        let mut changed = 0usize;
        let mut failed = 0usize;
        let mut updated_ids: Vec<String> = Vec::new();

        for item in rows.filter_map(Result::ok) {
            let (id, filepath, filetype, thumbnail_path, thumbnail_micro_path, thumbnail_preview_path, thumbhash, color_dominant, sha256, phash, width, height) = item;
            processed += 1;

            let path = std::path::Path::new(&filepath);
            if !path.exists() {
                failed += 1;
                continue;
            }

            let mut need_update = false;
            let mut next_thumbnail_path = thumbnail_path.clone();
            let mut next_thumbnail_micro_path = thumbnail_micro_path.clone();
            let mut next_thumbnail_preview_path = thumbnail_preview_path.clone();
            let mut next_thumbhash = thumbhash.clone();
            let mut next_color_dominant = color_dominant.clone();
            let mut next_sha256 = sha256.clone();
            let mut next_phash = phash;
            let mut next_width = width;
            let mut next_height = height;

            let is_image = matches!(filetype.as_str(), "image" | "design" | "3d");
            let is_video = filetype == "video";
            let parent_dir = path.parent().unwrap_or(std::path::Path::new(&library_root));
            let meta_dir = parent_dir.join(".nocturne_meta");
            let _ = std::fs::create_dir_all(&meta_dir);
            let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or(&id);

            if next_sha256.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                if let Ok(hash) = image_hash::compute_sha256(&filepath) {
                    next_sha256 = Some(hash);
                    need_update = true;
                }
            }

            if next_phash.is_none() && is_image {
                if let Ok(hash) = image_hash::compute_phash(&filepath) {
                    next_phash = Some(i64::try_from(hash).unwrap_or(i64::MAX));
                    need_update = true;
                }
            }

            if (next_width.is_none() || next_height.is_none()) && is_image {
                if let Ok((w, h)) = image::image_dimensions(&filepath) {
                    next_width = Some(w as i32);
                    next_height = Some(h as i32);
                    need_update = true;
                }
            }

            if is_image {
                if next_thumbnail_micro_path.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                    let micro_dst = meta_dir.join(format!("{}_micro.webp", filename));
                    let micro_path_opt = crate::media::thumbnail::generate_micro_from_embedded_thumbnail(&filepath, &micro_dst)
                        .or_else(|| {
                            crate::media::thumbnail::generate_micro_thumbnail(path, &micro_dst)
                                .ok()
                                .and_then(|_| micro_dst.exists().then(|| micro_dst.to_string_lossy().to_string()))
                        });
                    if let Some(micro_path) = micro_path_opt {
                        next_thumbnail_micro_path = Some(micro_path);
                        need_update = true;
                    }
                }

                if next_thumbnail_path.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                    let standard_dst = meta_dir.join(format!("{}_thumb.webp", filename));
                    if crate::media::thumbnail::generate_standard_thumbnail(path, &standard_dst).is_ok() {
                        next_thumbnail_path = Some(standard_dst.to_string_lossy().to_string());
                        need_update = true;
                    }
                }

                if next_thumbnail_preview_path.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                    let preview_dst = meta_dir.join(format!("{}_preview.webp", filename));
                    if crate::media::thumbnail::generate_preview_thumbnail(path, &preview_dst).is_ok() {
                        next_thumbnail_preview_path = Some(preview_dst.to_string_lossy().to_string());
                        need_update = true;
                    }
                }

                if next_thumbhash.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                    if let Ok(hash) = crate::media::thumbnail::generate_thumbhash(path) {
                        if !hash.is_empty() {
                            next_thumbhash = Some(hash);
                            need_update = true;
                        }
                    }
                }

                if next_color_dominant.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                    if let Ok(color) = crate::media::thumbnail::extract_dominant_color(filepath.as_str()) {
                        next_color_dominant = Some(color);
                        need_update = true;
                    }
                }
            }

            if is_video && next_thumbnail_path.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                let video_thumb = crate::media::thumbnail::generate_video_thumbnail(&id, &filepath, &db).ok();
                if video_thumb.is_some() {
                    next_thumbnail_path = video_thumb;
                    need_update = true;
                }
                if next_thumbnail_preview_path.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                    let preview_dst = meta_dir.join(format!("{}_preview.webp", filename));
                    if crate::media::thumbnail::generate_preview_thumbnail(path, &preview_dst).is_ok() {
                        next_thumbnail_preview_path = Some(preview_dst.to_string_lossy().to_string());
                        need_update = true;
                    }
                }
            }

            if need_update {
                let result = crate::media::thumbnail::update_multi_tier_thumbnails(
                    &conn,
                    &id,
                    next_thumbnail_micro_path.as_deref(),
                    next_thumbnail_path.as_deref(),
                    next_thumbnail_preview_path.as_deref(),
                    next_thumbhash.as_deref(),
                );
                if result.is_ok() {
                    if let Some(ref color) = next_color_dominant {
                        let _ = conn.execute(
                            "UPDATE media_files SET color_dominant = ? WHERE id = ?",
                            rusqlite::params![color, id],
                        );
                    }
                    if next_sha256.is_some() || next_phash.is_some() || next_width.is_some() || next_height.is_some() {
                        let _ = conn.execute(
                            "UPDATE media_files
                             SET sha256 = COALESCE(?1, sha256),
                                 phash = COALESCE(?2, phash),
                                 width = COALESCE(?3, width),
                                 height = COALESCE(?4, height)
                             WHERE id = ?5",
                            rusqlite::params![
                                next_sha256,
                                next_phash,
                                next_width,
                                next_height,
                                id,
                            ],
                        );
                    }
                    changed += 1;
                    updated_ids.push(id);
                } else {
                    failed += 1;
                }
            }
        }

        Ok((
            format!("Processed: {}, Changed: {}, Failed: {}", processed, changed, failed),
            updated_ids,
        ))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if !updated_ids.is_empty() {
        let _ = handle_for_emit.emit(
            "media_metadata_updated_batch",
            serde_json::json!({
                "ids": updated_ids,
                "summary": summary,
            }),
        );
    }

    Ok(summary)
}

/// 获取数据库中的所有文件路径（用于诊断）
#[command]
pub async fn get_all_file_paths(handle: AppHandle) -> Result<Vec<(String, String)>, String> {
    eprintln!("[get_all_file_paths] Getting all file paths from database");

    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, filepath FROM media_files ORDER BY filepath")
            .map_err(|e| e.to_string())?;
        let files: Vec<(String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;

        eprintln!("[get_all_file_paths] Found {} files", files.len());
        for (id, path) in &files {
            eprintln!("  - {}: {}", id, path);
        }

        Ok(files)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 修复粘贴导入的文件名（报告无法还原的 nocturne_paste_* 文件）
/// 由于剪贴板元数据已丢失，无法自动还原原始文件名，此命令用于统计和报告
#[command]
pub async fn fix_paste_filenames(handle: AppHandle) -> Result<String, String> {
    eprintln!("[fix_paste_filenames] Checking for nocturne_paste_* files");

    let db = db_path(&handle)?;

    let paste_files = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<Vec<(String, String, String)>, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare(
                "SELECT id, filepath, filename FROM media_files WHERE filename LIKE 'nocturne_paste_%'"
            ).map_err(|e| e.to_string())?;

            let files: Vec<(String, String, String)> = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;

            Ok(files)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let count = paste_files.len();
    eprintln!("[fix_paste_filenames] Found {} nocturne_paste files", count);

    // Log all paste files for reference
    for (id, filepath, filename) in &paste_files {
        eprintln!("  - {}: {} (path: {})", id, filename, filepath);
    }

    let message = format!(
        "粘贴文件名检查完成\n找到 {} 个以 nocturne_paste_ 命名的文件\n\n注意：由于剪贴板元数据已丢失，这些文件的原始文件名无法自动还原。\n如需重命名，请手动修改文件名后重新导入。",
        count
    );

    Ok(message)
}
