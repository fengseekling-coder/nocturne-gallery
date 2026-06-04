use tauri::{command, AppHandle, Emitter, Manager};
pub mod ai_tools;

use tauri_plugin_dialog::DialogExt;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use rusqlite::{params_from_iter, OptionalExtension};

use crate::db::{crud, open_conn};
use crate::media::{scanner, thumbnail, watcher, hash as image_hash};
use crate::models::{AiChatLoadResult, AiChatSession, GroupItemCount, MediaCursor, MediaDetail, MediaFilter, MediaPage, NavItemCount, ScanResult, DuplicateCheckResult, DuplicatePlacement, FileInfo, ImportPathsResult, FileMetaJSON, MediaFile};
use crate::AppState;

#[derive(serde::Serialize)]
pub struct BatchFileOperationResult {
    pub succeeded: usize,
    pub failed: usize,
}

#[command]
pub fn start_file_drag(window: tauri::Window, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有可拖出的文件".to_string());
    }

    let mut drag_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for path in paths {
        let path_buf = std::fs::canonicalize(&path)
            .map_err(|e| format!("无法读取拖拽文件：{} ({})", path, e))?;
        if !path_buf.is_file() {
            return Err(format!("只能拖出文件：{}", path_buf.display()));
        }
        drag_paths.push(path_buf);
    }

    let preview = drag_paths
        .first()
        .cloned()
        .ok_or_else(|| "没有可拖出的文件".to_string())?;

    drag::start_drag(
        &window,
        drag::DragItem::Files(drag_paths),
        drag::Image::File(preview),
        |_result, _cursor_position| {},
        drag::Options::default(),
    )
    .map_err(|e| format!("启动系统拖拽失败：{}", e))
}

fn media_id_by_filepath(conn: &rusqlite::Connection, filepath: &str) -> Result<String, String> {
    conn
        .query_row(
            "SELECT id FROM media_files WHERE filepath = ? LIMIT 1",
            rusqlite::params![filepath],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media file not found for path: {}", filepath))
}

fn media_file_by_filepath(conn: &rusqlite::Connection, filepath: &str) -> Result<MediaFile, String> {
    let id = media_id_by_filepath(conn, filepath)?;
    crud::get_media_file_by_id(conn, &id).map_err(|e| e.to_string())
}

fn remove_import_placeholder(db_path: &str, media_id: &str, filepath: &str) {
    let Ok(conn) = open_conn(db_path) else {
        return;
    };
    let _ = conn.execute(
        "DELETE FROM media_files WHERE id = ?1 AND filepath = ?2",
        rusqlite::params![media_id, filepath],
    );
}

fn validate_http_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err("URL 无效".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Err("仅支持打开 http:// 或 https:// 链接".to_string())
    }
}

fn validate_existing_local_path(path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return Err("路径无效".to_string());
    }
    std::fs::canonicalize(trimmed).map_err(|e| format!("无法访问路径：{}", e))
}

fn canonical_regular_file_path(raw_path: &str, label: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return Err(format!("{}路径无效", label));
    }

    let raw = std::path::Path::new(trimmed);
    let symlink_meta = std::fs::symlink_metadata(raw)
        .map_err(|e| format!("无法读取{}信息：{} ({})", label, raw_path, e))?;
    if symlink_meta.file_type().is_symlink() {
        return Err(format!("{}不能是符号链接：{}", label, raw_path));
    }
    if !symlink_meta.file_type().is_file() {
        return Err(format!("{}必须是文件：{}", label, raw_path));
    }

    let canonical = std::fs::canonicalize(raw)
        .map_err(|e| format!("无法规范化{}路径：{} ({})", label, raw_path, e))?;
    let canonical_meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("无法读取{}信息：{} ({})", label, canonical.display(), e))?;
    if !canonical_meta.is_file() {
        return Err(format!("{}必须是文件：{}", label, canonical.display()));
    }

    Ok(canonical)
}

fn has_supported_image_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP")
}

fn read_supported_ai_input_file_base64(
    raw_path: &str,
    label: &str,
) -> Result<String, String> {
    const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
    const MAX_PDF_BYTES: u64 = 8 * 1024 * 1024;

    let path = canonical_regular_file_path(raw_path, label)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("无法读取{}信息：{} ({})", label, path.display(), e))?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(format!("{}超过 {}MB，无法读取", label, MAX_IMAGE_BYTES / 1024 / 1024));
    }

    let bytes = std::fs::read(&path)
        .map_err(|e| format!("读取{}失败：{} ({})", label, path.display(), e))?;
    let is_image = has_supported_image_signature(&bytes);
    let is_pdf = bytes.starts_with(b"%PDF-");
    if !is_image && !is_pdf {
        return Err(format!("{}不是受支持的图片或 PDF 文件", label));
    }
    if is_pdf && metadata.len() > MAX_PDF_BYTES {
        return Err(format!("{}超过 {}MB，无法读取", label, MAX_PDF_BYTES / 1024 / 1024));
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn query_file_records(
    conn: &rusqlite::Connection,
    ids: &[String],
    sql: &str,
) -> Result<Vec<Vec<String>>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let query = sql.replace("{placeholders}", &placeholders);
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let column_count = stmt.column_count();
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), move |row| {
            let mut values = Vec::with_capacity(column_count);
            for index in 0..column_count {
                values.push(row.get::<_, String>(index)?);
            }
            Ok(values)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

fn assign_category_for_filepath(
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
        .ok_or_else(|| format!("Imported media not found for category assignment: {}", filepath))?;

    crud::set_media_category(&conn, &media_id, category_name).map_err(|e| e.to_string())
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  Additional imports for paste functionality
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

use base64;
use base64::Engine as _;
use chrono;
use image::ImageEncoder;

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use windows::core::HSTRING;
#[cfg(target_os = "windows")]
use windows::core::HRESULT;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
    DeleteObject, GetDIBits, GetObjectW, HBITMAP,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  å†…éƒ¨å·¥å…·ï¼šä»Ž AppHandle æ´¾ç“Ÿ DB è·¯å¾„
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn db_path(handle: &AppHandle) -> Result<String, String> {
    let data_dir = handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // 优先从 config.json 读取 library_root，拼接库目录 DB 路径
    let config_path = data_dir.join(".nocturne/config.json");
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<watcher::LibraryConfig>(&content) {
            return Ok(std::path::Path::new(&config.root_path)
                .join(".nocturne")
                .join("nocturne.db")
                .to_string_lossy()
                .to_string());
        }
    }

    // 无库配置时回落 AppData（首次初始化期间）
    Ok(data_dir.join("nocturne.db").to_string_lossy().to_string())
}

/// Get thumbnail directory (deprecated - new architecture uses .nocturne_meta/ per directory)
#[allow(dead_code)]
#[allow(dead_code)]
fn thumbs_dir(handle: &AppHandle) -> Result<String, String> {
    let root = library_root(handle)?;
    Ok(std::path::Path::new(&root)
        .join(".nocturne").join("thumbs")
        .to_string_lossy()
        .to_string())
}

/// èŽ·å–åº“æ ¹ç›®å½•è·¯å¾„
pub(super) fn library_root(handle: &AppHandle) -> Result<String, String> {
    // ä¼˜å…ˆä»Žé…ç½®è¯»å–
    let config_path = handle
        .path()
        .app_data_dir()
        .map(|p| p.join(".nocturne/config.json").to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get config path: {}", e))?;

    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<watcher::LibraryConfig>(&content) {
            return Ok(config.root_path);
        }
    }

    // å¦åˆ™è¿“å›žé»˜è®¤çš„ AppData ç›®å½•
    handle
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  å†…éƒ¨å·¥å…·ï¼šè·¯å¾„å®‰å…¨éªŒè¯
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// éªŒè¯æ–‡ä»¶è·¯å¾„åœ¨åº“æ ¹ç›®å½•èŒƒå›´å†…ï¼Œé˜²æ­¢è·¯å¾„ç©¿è¶Šå’Œè¶Šæƒæ“ä½œã€‚
fn normalize_path_for_boundary_check(path: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(path);
    if path.exists() {
        return path.canonicalize().ok();
    }

    let cleaned = path.to_string_lossy().replace('/', "\\");
    let cleaned_path = std::path::PathBuf::from(cleaned);
    if cleaned_path.exists() {
        return cleaned_path.canonicalize().ok();
    }

    None
}

fn same_or_descendant_path(candidate: &std::path::Path, root: &std::path::Path) -> bool {
    let candidate = candidate.canonicalize().unwrap_or_else(|_| candidate.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    #[cfg(windows)]
    let candidate_str = candidate.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    #[cfg(windows)]
    let root_str = root.to_string_lossy().replace('/', "\\").to_ascii_lowercase();

    #[cfg(not(windows))]
    let candidate_str = candidate.to_string_lossy().replace('\\', "/");
    #[cfg(not(windows))]
    let root_str = root.to_string_lossy().replace('\\', "/");

    if candidate_str == root_str {
        return true;
    }

    let mut root_with_sep = root_str;
    if !root_with_sep.ends_with(std::path::MAIN_SEPARATOR) {
        root_with_sep.push(std::path::MAIN_SEPARATOR);
    }

    candidate_str.starts_with(&root_with_sep)
}

fn validate_path_in_library(file_path: &str, library_root: &str) -> Result<(), String> {
    let candidate = normalize_path_for_boundary_check(file_path).unwrap_or_else(|| std::path::PathBuf::from(file_path));
    let root = normalize_path_for_boundary_check(library_root).unwrap_or_else(|| std::path::PathBuf::from(library_root));

    if !same_or_descendant_path(&candidate, &root) {
        let err = format!(
            "路径越界：不允许操作库目录外的文件（文件：{}，库根：{}）",
            file_path, library_root
        );
        eprintln!("[validate_path] {}", err);
        return Err(err);
    }
    Ok(())
}

fn validate_library_relative_folder(folder: &str) -> Result<String, String> {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return Err("目标文件夹不能为空".to_string());
    }

    let path = std::path::Path::new(trimmed);
    if path.is_absolute() {
        return Err("目标文件夹不能是绝对路径".to_string());
    }

    let has_component = path.components().try_fold(false, |_, component| {
        match component {
            std::path::Component::Normal(_) => Ok(true),
            _ => Err("目标文件夹不能包含路径穿越或盘符".to_string()),
        }
    })?;

    if !has_component {
        return Err("目标文件夹不能为空".to_string());
    }

    Ok(trimmed.to_string())
}

fn is_supported_import_file(path: &std::path::Path) -> bool {
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

fn find_meta_json_path(meta_dir: &std::path::Path, filename: &str) -> Option<std::path::PathBuf> {
    let direct_path = meta_dir.join(format!("{}.json", filename));
    if direct_path.exists() {
        return Some(direct_path);
    }

    let file_stem = std::path::Path::new(filename)
        .file_stem()
        .and_then(|segment| segment.to_str())
        .unwrap_or(filename);

    if file_stem == filename {
        return None;
    }

    let legacy_path = meta_dir.join(format!("{}.json", file_stem));
    if legacy_path.exists() {
        Some(legacy_path)
    } else {
        None
    }
}

fn update_meta_json_filename(meta_path: &std::path::Path, new_filename: &str) -> Result<String, String> {
    let content = std::fs::read_to_string(meta_path)
        .map_err(|e| format!("Failed to read meta JSON: {}", e))?;
    let mut meta = serde_json::from_str::<FileMetaJSON>(&content)
        .map_err(|e| format!("Failed to parse meta JSON: {}", e))?;
    meta.file_name = new_filename.to_string();
    serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("Failed to serialize meta JSON: {}", e))
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  Commands
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// æ‰«æç›®å½•å¹¶å¯¼å…¥æ–‡ä»¶åˆ°æ•°æ®åº“ã€‚
/// æœ‰è·¯å¾„å®ˆå«ï¼šç¦æ­¢æ‰«æåº“æ ¹ç›®å½•ä»¥å¤–çš„è·¯å¾„// --- v5.8: Multi-tier thumbnail commands ---
use std::sync::atomic::{AtomicBool, Ordering};

static REBUILD_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static REBUILD_RUNNING: AtomicBool = AtomicBool::new(false);
static STARTUP_BACKFILL_QUEUED: OnceLock<AtomicBool> = OnceLock::new();
static FOLDER_PATHS_UPDATED: OnceLock<AtomicBool> = OnceLock::new();

fn startup_backfill_once() -> &'static AtomicBool {
    STARTUP_BACKFILL_QUEUED.get_or_init(|| AtomicBool::new(false))
}

fn folder_paths_updated_once() -> &'static AtomicBool {
    FOLDER_PATHS_UPDATED.get_or_init(|| AtomicBool::new(false))
}

/// 为指定 item 生成 preview 档缩略图（2048px WebP）
#[tauri::command]
pub fn generate_preview_thumbnail_for_item(app: tauri::AppHandle, item_id: String) -> Result<String, String> {
    let db_path = db_path(&app).map_err(|e| format!("Failed to resolve DB path: {}", e))?;
    let conn = open_conn(&db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

    let file = crate::db::crud::get_media_file_by_id(&conn, &item_id)
        .map_err(|e| format!("Failed to get item: {}", e))?;

    let src = std::path::Path::new(&file.filepath);
    if !src.exists() {
        return Err(format!("Source file not found: {}", file.filepath));
    }

    let meta_dir = src.parent()
        .map(|p| p.join(".nocturne_meta"))
        .ok_or_else(|| "Cannot determine meta directory".to_string())?;
    std::fs::create_dir_all(&meta_dir).map_err(|e| format!("Failed to create meta dir: {}", e))?;

    let preview_filename = format!("{}_preview.webp",
        src.file_name().and_then(|s| s.to_str()).unwrap_or("preview"));
    let preview_dst = meta_dir.join(&preview_filename);

    crate::media::thumbnail::generate_preview_thumbnail(src, &preview_dst)
        .map_err(|e| format!("Failed to generate preview: {}", e))?;

    let preview_abs = preview_dst.to_string_lossy().to_string();

    crate::db::crud::update_thumbnail_preview_path(&conn, &item_id, &preview_abs)
        .map_err(|e| format!("Failed to update DB: {}", e))?;

    Ok(preview_abs)
}

/// 统计缺失 micro 缩略图的数量
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

/// 批量重建缺失的 micro 缩略图和 thumbhash
#[tauri::command]
pub fn rebuild_missing_thumbnails(app: tauri::AppHandle) -> Result<(), String> {
    let db_path = db_path(&app).map_err(|e| format!("Failed to resolve DB path: {}", e))?;
    let conn = open_conn(&db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT id, filename, filepath FROM media_files WHERE is_trashed = 0 AND thumbnail_micro_path IS NULL AND thumbnail_path IS NOT NULL"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let items: Vec<(String, String, String)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
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

                let meta_dir = src.parent()
                    .map(|p| p.join(".nocturne_meta"))
                    .unwrap_or_else(|| std::path::Path::new("").to_path_buf());

                let source_name_for_thumb = src.file_name().and_then(|s| s.to_str()).unwrap_or(filename);
                let micro_filename = format!("{}_micro.webp", source_name_for_thumb);
                let micro_dst = meta_dir.join(&micro_filename);
                let micro_path_opt =
                    crate::media::thumbnail::generate_micro_from_embedded_thumbnail(&src.to_string_lossy(), &micro_dst)
                    .or_else(|| {
                        if let Err(e) = crate::media::thumbnail::generate_micro_thumbnail(src, &micro_dst) {
                            log::warn!("[rebuild] Micro thumbnail failed for '{}': {}", filename, e);
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
                        &conn, &id, micro_path_opt.as_deref(), None, None, thumbhash_opt.as_deref(),
                    ) {
                        log::warn!("[rebuild] DB update failed for '{}': {}", filename, e);
                    }
                }

                current += 1;

                let _ = app.emit("thumbnail_rebuild_progress", serde_json::json!({
                    "current": current,
                    "total": total,
                    "current_file": filename,
                }));
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let _ = app.emit("thumbnail_rebuild_complete", serde_json::json!({
            "total": total,
        }));
        REBUILD_RUNNING.store(false, Ordering::Relaxed);
    });

    Ok(())
}

/// 取消正在进行的缩略图重建
#[tauri::command]
pub fn cancel_rebuild_thumbnails() {
    REBUILD_SHUTDOWN.store(true, Ordering::Relaxed);
    REBUILD_RUNNING.store(false, Ordering::Relaxed);
}
#[command]
pub async fn scan_directory(handle: AppHandle, path: String) -> Result<ScanResult, String> {
    eprintln!("[scan_directory] Starting scan for path: {}", path);

    // è·¯å¾„å®ˆå«ï¼šèŽ·å–åº“æ ¹ç›®å½•å¹¶éªŒè¯
    let library_root = library_root(&handle)?;
    eprintln!("[scan_directory] Library root: {}", library_root);

    // éªŒè¯æ‰«æè·¯å¾„å¿…é¡»åœ¨åº“æ ¹ç›®å½•èŒƒå›´å†…
    if !same_or_descendant_path(std::path::Path::new(&path), std::path::Path::new(&library_root)) {
        let err = format!("禁止扫描库目录以外的路径：{} (库根：{})", path, library_root);
        eprintln!("[scan_directory] Security check failed: {}", err);
        return Err(err);
    }
    eprintln!("[scan_directory] Security check passed");

    let db = match db_path(&handle) {
        Ok(d) => {
            eprintln!("[scan_directory] DB path: {}", d);
            d
        }
        Err(e) => {
            let err = format!("Failed to get db_path: {}", e);
            eprintln!("[scan_directory] Error: {}", err);
            return Err(err);
        }
    };

    // è®¾ç½®ç¼©ç•¥å›¾ç›®å½•çŽ¯å¢ƒå˜é‡ - ä½¿ç“¨åº“æ ¹ç›®å½•ä¸‹çš„ .nocturne/thumbs
    let thumbs = std::path::Path::new(&library_root)
        .join(".nocturne")
        .join("thumbs")
        .to_string_lossy()
        .to_string();
    eprintln!("[scan_directory] Thumbs dir: {}", thumbs);


    // èŽ·å–ç¼©ç•¥å›¾é˜Ÿåˆ—å¹¶æš‚åœå¤„ç†ï¼ˆæ‰¹é‡å¯¼å…¥æ—¶æš‚åœï¼‰
    let thumbnail_queue = {
        let state = handle.state::<AppState>();
        Arc::clone(&state.thumbnail_queue)
    };
    thumbnail_queue.pause_processor();
    eprintln!("[scan_directory] Thumbnail processor paused for batch import");

    // è®¾ç½® APP_DATA_DIR çŽ¯å¢ƒå˜é‡ä¾› scanner ä½¿ç“¨
    let _app_data_dir = handle.path().app_data_dir();

    eprintln!("[scan_directory] Calling scanner::scan_directory_with_progress");

    let h = handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        scanner::scan_directory_with_progress(&path, &db, &thumbs, |current, total, filename| {
            let _ = h.emit("scan_progress", serde_json::json!({
                "current": current,
                "total": total,
                "filename": filename,
            }));
        })
    })
    .await
    .map_err(|e| {
        let err = format!("Task join error: {}", e);
        eprintln!("[scan_directory] Task join failed: {}", err);
        err
        })?
        .map_err(|e| {
            let err = format!("scan_directory failed: {:?}", e);
            eprintln!("[scan_directory] Scan failed: {}", err);
            err
        });

    // æ‰«æå®ŒæˆåŽæ¢å¤ç¼©ç•¥å›¾å¤„ç†
    thumbnail_queue.wake_processor();
    eprintln!("[scan_directory] Thumbnail processor woken up");

    match &result {
        Ok(r) => {
            log::info!("[scan_directory] Scan completed: scanned={}, imported={}, skipped={}",
                r.scanned_count, r.imported_count, r.skipped_count);
            let _ = handle.emit("scan_complete", serde_json::json!({ "total": r.imported_count }));
        }
        Err(e) => log::error!("[scan_directory] Final error: {}", e),
    }

    result
}

/// åˆ†é¡µæŸ¥è¯¢åª’ä½“æ–‡ä»¶åˆ—è¡¨ã€‚
#[command]
pub async fn get_media_files(
    handle: AppHandle,
    page: i64,
    per_page: i64,
    filter: MediaFilter,
    cursor: Option<MediaCursor>,
) -> Result<MediaPage, String> {
    let safe_page = page.max(1);
    let safe_per_page = per_page.clamp(1, 200);

    log::debug!("[get_media_files] querying page={} perPage={} cursor={:?}", safe_page, safe_per_page, cursor.as_ref().map(|c| &c.id));

    let library_root = library_root(&handle).unwrap_or_default();
    log::debug!("[get_media_files] library_root={}", library_root);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let mut filter_with_root = filter.clone();
        filter_with_root.library_root_path = Some(library_root);
        let (items, total, next_cursor) =
            crud::query_media_files(&conn, safe_page, safe_per_page, &filter_with_root, cursor.as_ref(), safe_page > 1).map_err(|e| e.to_string())?;
        log::debug!("[get_media_files] result count={} next_cursor={}", items.len(), next_cursor.is_some());
        Ok(MediaPage {
            items,
            total,
            page,
            per_page,
            next_cursor,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
/// èŽ·å–å•ä¸ªåª’ä½“æ–‡ä»¶è¯¦æƒ…ï¼ˆå«æ ‡ç­¾ã€AI å…ƒæ•°æ®ï¼‰ã€‚
#[command]
pub async fn get_media_detail(
    handle: AppHandle,
    id: String,
) -> Result<Option<MediaDetail>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::get_media_detail(&conn, &id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn get_group_item_counts(
    handle: AppHandle,
    filter: MediaFilter,
    group_names: Vec<String>,
) -> Result<Vec<GroupItemCount>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::get_group_item_counts(&conn, &filter, &group_names).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn get_nav_item_counts(
    handle: AppHandle,
    nav_ids: Vec<String>,
    library_root: Option<String>,
) -> Result<Vec<NavItemCount>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::get_nav_item_counts(&conn, &nav_ids, library_root.as_deref()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn attachment_mime_type_from_path(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "psd" => "image/vnd.adobe.photoshop",
        "ai" => "application/postscript",
        _ => "application/octet-stream",
    };
    Some(mime.to_string())
}

fn encode_rgba_preview_data_url(width: u32, height: u32, rgba: &[u8]) -> Result<String, String> {
    let mut webp_data = Vec::new();
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut webp_data);
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("Failed to encode preview WebP: {}", e))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(webp_data);
    Ok(format!("data:image/webp;base64,{}", encoded))
}

fn read_pending_import_preview_data_url(path: &str) -> Result<String, String> {
    use image::imageops::FilterType;

    let path_buf = std::path::PathBuf::from(path);
    let ext = path_buf
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "preview_unavailable".to_string())?;

    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif") {
        return Err("preview_unavailable".to_string());
    }

    let metadata = std::fs::symlink_metadata(&path_buf).map_err(|_| "preview_unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err("preview_unavailable".to_string());
    }

    let file = std::fs::File::open(&path_buf).map_err(|_| "preview_unavailable".to_string())?;
    let reader = std::io::BufReader::new(file);
    let image = image::load(reader, image::ImageFormat::from_extension(&ext).ok_or_else(|| "preview_unavailable".to_string())?)
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
    encode_rgba_preview_data_url(rgba.width(), rgba.height(), rgba.as_raw()).map_err(|_| "preview_unavailable".to_string())
}

#[cfg(target_os = "windows")]
fn hbitmap_to_data_url(hbitmap: HBITMAP) -> Result<String, String> {
    let mut bitmap = BITMAP::default();
    let object_size = unsafe {
        GetObjectW(
            hbitmap,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut c_void),
        )
    };
    if object_size == 0 {
        return Err("Failed to read shell thumbnail bitmap".to_string());
    }

    let width = bitmap.bmWidth.max(1);
    let height = bitmap.bmHeight.abs().max(1);
    let mut pixels = vec![0u8; (width * height * 4) as usize];

    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };

    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.0.is_null() {
        return Err("Failed to create compatible DC for shell thumbnail".to_string());
    }

    let read_lines = unsafe {
        GetDIBits(
            dc,
            hbitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = DeleteDC(dc);
    }

    if read_lines == 0 {
        return Err("Failed to extract shell thumbnail pixels".to_string());
    }

    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        if pixel[3] == 0 {
            pixel[3] = 255;
        }
    }

    encode_rgba_preview_data_url(width as u32, height as u32, &pixels)
}

#[cfg(target_os = "windows")]
fn shell_thumbnail_preview_data_url(path: &str, size: u32) -> Result<Option<String>, String> {
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let initialized_com = if hr.is_ok() {
        true
    } else if hr == HRESULT(0x80010106u32 as i32) {
        false
    } else {
        return Err(format!("Failed to initialize COM for shell thumbnail: {}", hr));
    };

    let result = (|| {
        let item: IShellItemImageFactory = unsafe {
            SHCreateItemFromParsingName(&HSTRING::from(path), None)
                .map_err(|e| format!("Failed to create shell item: {}", e))?
        };
        let bitmap = unsafe {
            item.GetImage(
                windows::Win32::Foundation::SIZE {
                    cx: size as i32,
                    cy: size as i32,
                },
                SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY,
            )
            .map_err(|e| format!("Failed to get shell thumbnail: {}", e))?
        };

        let preview = hbitmap_to_data_url(bitmap);
        unsafe {
            let _ = DeleteObject(bitmap);
        }
        preview.map(Some)
    })();

    if initialized_com {
        unsafe {
            CoUninitialize();
        }
    }

    result
}

#[cfg(not(target_os = "windows"))]
fn shell_thumbnail_preview_data_url(_path: &str, _size: u32) -> Result<Option<String>, String> {
    Ok(None)
}

#[command]
pub async fn add_media_attachments(
    handle: AppHandle,
    media_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let db = db_path(&handle)?;
    let scope_paths = tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut registered_paths = Vec::with_capacity(paths.len());

        for raw_path in &paths {
            let path = canonical_regular_file_path(raw_path, "附件")?;
            let metadata = std::fs::metadata(&path)
                .map_err(|e| format!("读取附件信息失败：{} ({})", path.display(), e))?;
            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("附件文件名无效：{}", path.display()))?
                .to_string();
            let canonical_path = path.to_string_lossy().to_string();

            crud::add_media_attachment(
                &tx,
                &media_id,
                &canonical_path,
                &filename,
                Some(metadata.len() as i64),
                attachment_mime_type_from_path(&path).as_deref(),
            )
            .map_err(|e| e.to_string())?;
            registered_paths.push(canonical_path);
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok::<Vec<String>, String>(registered_paths)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Allow each attachment file in the asset protocol scope so it can be served
    // via convertFileSrc for preview in the UI.
    let scope = handle.asset_protocol_scope();
    for path in &scope_paths {
        if let Err(e) = scope.allow_file(std::path::Path::new(path)) {
            log::warn!("[add_media_attachments] Failed to allow attachment in asset scope: {} - {}", path, e);
        }
    }

    Ok(())
}

#[command]
pub async fn remove_media_attachment(
    handle: AppHandle,
    attachment_id: String,
) -> Result<(), String> {
    let db = db_path(&handle)?;
    let lib_root = library_root(&handle).ok();

    // Look up the attachment filepath before deletion, then delete.
    // If the file is outside the library root and no other attachment references
    // it, revoke its asset protocol scope entry so it can no longer be served.
    let revoke_path = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;

        // Determine whether to revoke the file from the asset scope after deletion.
        let revoke: Option<String> = if let Ok(filepath) = conn.query_row(
            "SELECT filepath FROM media_attachments WHERE id = ?",
            rusqlite::params![&attachment_id],
            |row| row.get::<_, String>(0),
        ) {
            // Check if the attachment file lives outside the current library root.
            let is_external = lib_root.as_ref().map(|root| {
                !std::path::Path::new(&filepath)
                    .starts_with(std::path::Path::new(root))
            }).unwrap_or(false);

            if is_external {
                // Only revoke when no other attachment row still references this path.
                let ref_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM media_attachments WHERE filepath = ? AND id != ?",
                    rusqlite::params![&filepath, &attachment_id],
                    |row| row.get(0),
                ).unwrap_or(1); // default to 1 (keep allowed) on DB error
                if ref_count == 0 { Some(filepath) } else { None }
            } else {
                None // inside library root; directory scope covers it
            }
        } else {
            None
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crud::remove_media_attachment(&tx, &attachment_id).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        Ok(revoke)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Revoke asset scope for external files that are no longer referenced.
    if let Some(filepath) = revoke_path {
        if let Err(e) = handle.asset_protocol_scope().forbid_file(std::path::Path::new(&filepath)) {
            log::warn!("[remove_media_attachment] Failed to revoke asset scope for {}: {}", filepath, e);
        }
    }

    Ok(())
}

#[command]
pub async fn get_attachment_preview_data(
    path: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    let preview_size = size.unwrap_or(320).clamp(96, 1024);
    tokio::task::spawn_blocking(move || shell_thumbnail_preview_data_url(&path, preview_size))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn read_media_file_as_base64(
    handle: AppHandle,
    media_id: String,
) -> Result<String, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let file = crud::get_media_file_by_id(&conn, &media_id)
            .map_err(|e| e.to_string())?;
        read_supported_ai_input_file_base64(&file.filepath, "媒体文件")
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn read_attachment_file_as_base64(
    handle: AppHandle,
    attachment_id: String,
) -> Result<String, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| format!("打开数据库失败：{}", e))?;
        let filepath: String = conn
            .query_row(
                "SELECT filepath FROM media_attachments WHERE id = ?",
                rusqlite::params![attachment_id],
                |row| row.get(0),
            )
            .map_err(|_| "未找到该附件，无法读取文件".to_string())?;

        let path = canonical_regular_file_path(&filepath, "附件")?;
        read_supported_ai_input_file_base64(path.to_string_lossy().as_ref(), "附件文件")
    })
    .await
    .map_err(|e| format!("任务执行失败：{}", e))?
}

#[command]
pub async fn read_attachment_preview(
    handle: AppHandle,
    attachment_id: String,
) -> Result<String, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let filepath: String = conn.query_row(
            "SELECT filepath FROM media_attachments WHERE id = ?",
            rusqlite::params![attachment_id],
            |row| row.get(0),
        ).map_err(|_| "preview_unavailable".to_string())?;

        let path = std::path::Path::new(&filepath);
        let metadata = std::fs::symlink_metadata(path).map_err(|_| "preview_unavailable".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            return Err("preview_unavailable".to_string());
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif") {
            if metadata.len() > 15 * 1024 * 1024 {
                return Err("preview_unavailable".to_string());
            }

            let img = image::open(path).map_err(|_| "preview_unavailable".to_string())?;
            let resized = if img.width().max(img.height()) > 800 {
                img.resize(800, 800, image::imageops::FilterType::Lanczos3)
            } else {
                img
            };
            let mut out = Vec::new();
            let rgba = resized.to_rgba8();
            let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            encoder.encode(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8).map_err(|_| "preview_unavailable".to_string())?;
            return Ok(format!("data:image/webp;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)));
        }

        match shell_thumbnail_preview_data_url(&filepath, 320).map_err(|_| "preview_unavailable".to_string())? {
            Some(preview) => Ok(preview),
            None => Err("preview_unavailable".to_string()),
        }
    })
    .await
    .map_err(|_| "preview_unavailable".to_string())?
}

/// æ’å…¥æˆ–æ›´æ–° AI å…ƒæ•°æ®ã€‚
#[command]
pub async fn update_ai_metadata(
    handle: AppHandle,
    id: String,
    prompt: String,
    model: String,
    platform: String,
) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crud::upsert_ai_metadata(&tx, &id, &prompt, &model, &platform)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// æ›´æ–°åª’ä½“æ–‡ä»¶çš„æ ‡ç­¾ï¼ˆå…¨é‡æ›¿æ¢ï¼‰ã€‚
#[command]
pub async fn update_tags(
    handle: AppHandle,
    id: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;

        // 使用事务保证原子性
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crud::update_media_tags(&tx, &id, &tags).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        log::info!("[update_tags] Database updated, now syncing JSON for {}", id);

        // 同步标签到侧边元数据 JSON 文件
        let file_info: Option<(String, String)> = conn
            .query_row(
                "SELECT filepath, filename FROM media_files WHERE id = ?",
                rusqlite::params![&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
            
        if let Some((filepath, filename)) = file_info {
            let file_path = std::path::Path::new(&filepath);
            let meta_dir = file_path.parent().unwrap_or(std::path::Path::new(".")).join(".nocturne_meta");

            // 优先新格式（{filename}.json），回退旧格式（{file_stem}.json）
            let new_path = meta_dir.join(format!("{}.json", filename));
            let meta_json_path = if new_path.exists() {
                new_path
            } else {
                let stem = std::path::Path::new(&filename)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&filename);
                meta_dir.join(format!("{}.json", stem))
            };

            if meta_json_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&meta_json_path) {
                    if let Ok(mut meta) = serde_json::from_str::<crate::models::FileMetaJSON>(&content) {
                        meta.tags = Some(tags);
                        if let Ok(updated_content) = serde_json::to_string_pretty(&meta) {
                            if let Err(e) = std::fs::write(&meta_json_path, updated_content) {
                                log::error!("[update_tags] Failed to write JSON: {}", e);
                            }
                        }
                    }
                }
            }
        }
        
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn rename_file(handle: AppHandle, id: String, new_name: String) -> Result<MediaFile, String> {
    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let current_file = crud::get_media_file_by_id(&conn, &id).map_err(|e| e.to_string())?;
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

        std::fs::rename(source_path, &target_path)
            .map_err(|e| format!("重命名文件失败: {}", e))?;

        let meta_dir = parent_dir.join(".nocturne_meta");
        let old_meta_path = find_meta_json_path(&meta_dir, &current_file.filename);
        let new_meta_path = meta_dir.join(format!("{}.json", sanitized_name));
        let mut wrote_new_meta = false;

        if let Some(existing_meta_path) = old_meta_path.as_ref() {
            match update_meta_json_filename(existing_meta_path, sanitized_name) {
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

        if let Err(error) = crud::rename_media_file(
            &conn,
            &id,
            sanitized_name,
            &target_path_str,
            modified_at,
        ) {
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

        crud::get_media_file_by_id(&conn, &id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// ä¸ºæŒ‡å®šåª’ä½“æ–‡ä»¶ç“Ÿæˆç¼©ç•¥å›¾ã€‚
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

/// å°†æ–‡ä»¶ç§»å…¥å›žæ“¶ç«™ï¼ˆè½¯åˆ é™¤ï¼‰ã€‚
#[command]
pub async fn move_to_trash(handle: AppHandle, id: String) -> Result<(), String> {
    eprintln!("[move_to_trash] Moving file to trash: {}", id);

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    // First get the file info
    let (source_path, filename) = tokio::task::spawn_blocking({
        let db_clone = db.clone();
        let id_clone = id.clone();
        move || {
            let conn = open_conn(&db_clone).map_err(|e| e.to_string())?;

            // Get the current file path
            let filepath: String = conn
                .query_row(
                    "SELECT filepath FROM media_files WHERE id = ?",
                    rusqlite::params![id_clone],
                    |r| r.get(0),
                )
                .map_err(|e| format!("Media file not found: {}", e))?;

            let filename = std::path::Path::new(&filepath)
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid file path")?
                .to_string();

            Ok((filepath, filename))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    eprintln!("[move_to_trash] Source path: {}, filename: {}", source_path, filename);
    validate_path_in_library(&source_path, &library_root)?;

    // Move the file to the trash folder
    let target_folder = validate_library_relative_folder("回收站")?;
    let target_path = std::path::Path::new(&library_root)
        .join(&target_folder)
        .join(&filename);

    let target_path_str = target_path.to_string_lossy().to_string();
    validate_path_in_library(&target_path_str, &library_root)?;
    eprintln!("[move_to_trash] Target path: {}", target_path_str);

    // Ensure target folder exists
    std::fs::create_dir_all(std::path::Path::new(&library_root).join(&target_folder))
        .map_err(|e| format!("Failed to create trash folder: {}", e))?;

    // Move the file physically
    tokio::task::spawn_blocking(move || {
        std::fs::rename(&source_path, &target_path)
            .map_err(|e| format!("Failed to move file to trash: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[move_to_trash] Physical move failed: {}", e);
        e
    })?;

    eprintln!("[move_to_trash] File moved to trash successfully");

    // Update database: update path and set is_trashed flag
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        let original_folder = conn
            .query_row(
                "SELECT COALESCE(source_folder, '') FROM media_files WHERE id = ?",
                rusqlite::params![id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| String::new());

        // Update the file path and is_trashed flag
        conn.execute(
            "UPDATE media_files SET filepath = ?, source_folder = ?, pre_trash_folder = ?, is_trashed = 1 WHERE id = ?",
            rusqlite::params![target_path_str, target_folder, original_folder, id],
        )
        .map_err(|e| format!("Failed to update database: {}", e))?;

        eprintln!("[move_to_trash] Database updated successfully");
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| {
        eprintln!("[move_to_trash] DB update failed: {}", e);
        e
    })?;

    Ok(())
}

#[command]
pub async fn batch_move_to_trash(
    handle: AppHandle,
    ids: Vec<String>,
) -> Result<BatchFileOperationResult, String> {
    if ids.is_empty() {
        return Ok(BatchFileOperationResult { succeeded: 0, failed: 0 });
    }

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let rows = query_file_records(
            &conn,
            &ids,
            "SELECT id, filepath, COALESCE(source_folder, '') FROM media_files WHERE id IN ({placeholders})",
        )?;
        let file_map: HashMap<String, (String, String)> = rows
            .into_iter()
            .filter_map(|row| {
                if row.len() == 3 {
                    Some((row[0].clone(), (row[1].clone(), row[2].clone())))
                } else {
                    None
                }
            })
            .collect();

        let target_folder = validate_library_relative_folder("回收站")?;
        std::fs::create_dir_all(std::path::Path::new(&library_root).join(&target_folder))
            .map_err(|e| format!("Failed to create trash folder: {}", e))?;

        let mut moved_items: Vec<(String, String, String)> = Vec::new();
        let mut failed = 0usize;

        for id in &ids {
            let Some((source_path, source_folder)) = file_map.get(id) else {
                failed += 1;
                continue;
            };

            if validate_path_in_library(source_path, &library_root).is_err() {
                failed += 1;
                continue;
            }

            let Some(filename) = std::path::Path::new(source_path)
                .file_name()
                .and_then(|name| name.to_str())
            else {
                failed += 1;
                continue;
            };

            let target_path = std::path::Path::new(&library_root)
                .join(&target_folder)
                .join(filename);
            let target_path_str = target_path.to_string_lossy().to_string();
            if validate_path_in_library(&target_path_str, &library_root).is_err() {
                failed += 1;
                continue;
            }

            match std::fs::rename(source_path, &target_path) {
                Ok(_) => moved_items.push((
                    id.clone(),
                    target_path_str,
                    source_folder.clone(),
                )),
                Err(error) => {
                    log::warn!("[batch_move_to_trash] Failed to move {}: {}", source_path, error);
                    failed += 1;
                }
            }
        }

        if !moved_items.is_empty() {
            let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (id, target_path, source_folder) in &moved_items {
                tx.execute(
                    "UPDATE media_files SET filepath = ?, source_folder = ?, pre_trash_folder = ?, is_trashed = 1 WHERE id = ?",
                    rusqlite::params![target_path, &target_folder, source_folder, id],
                )
                .map_err(|e| format!("Failed to update database: {}", e))?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(BatchFileOperationResult {
            succeeded: moved_items.len(),
            failed,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// ä»Žå›žæ“¶ç«™æ¢å¤æ–‡ä»¶ã€‚
#[command]
pub async fn restore_from_trash(handle: AppHandle, id: String) -> Result<(), String> {
    eprintln!("[restore_from_trash] Restoring file from trash: {}", id);

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    // Get the current trashed file info and determine original folder
    let (current_path, original_source_folder) = tokio::task::spawn_blocking({
        let db_clone = db.clone();
        let id_clone = id.clone();
        move || {
            let conn = open_conn(&db_clone).map_err(|e| e.to_string())?;

            // Get the current file path (in trash) and original source folder
            let mut stmt = conn.prepare(
                "SELECT filepath, COALESCE(pre_trash_folder, source_folder, '') FROM media_files WHERE id = ?",
            ).map_err(|e| e.to_string())?;

            let (filepath, source_folder): (String, String) = stmt.query_row([id_clone], |row| {
                Ok((row.get(0)?, row.get(1)?))
            }).map_err(|e| format!("Media file not found: {}", e))?;

            Ok((filepath, source_folder))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    eprintln!("[restore_from_trash] Current path: {}, original folder: {}", current_path, original_source_folder);
    validate_path_in_library(&current_path, &library_root)?;
    let original_source_folder = validate_library_relative_folder(&original_source_folder)?;

    // Determine target path based on original source folder
    let filename = std::path::Path::new(&current_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let target_path = std::path::Path::new(&library_root)
        .join(&original_source_folder)
        .join(&filename);

    let target_path_str = target_path.to_string_lossy().to_string();
    validate_path_in_library(&target_path_str, &library_root)?;
    eprintln!("[restore_from_trash] Target path: {}", target_path_str);

    // Ensure target folder exists
    std::fs::create_dir_all(std::path::Path::new(&library_root).join(&original_source_folder))
        .map_err(|e| format!("Failed to create target folder: {}", e))?;

    // Move the file back from trash
    tokio::task::spawn_blocking(move || {
        std::fs::rename(&current_path, &target_path)
            .map_err(|e| format!("Failed to move file from trash: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[restore_from_trash] Physical move failed: {}", e);
        e
    })?;

    eprintln!("[restore_from_trash] File moved from trash successfully");

    // Update database: update path and clear is_trashed flag
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        // Update the file path and clear is_trashed flag
        conn.execute(
            "UPDATE media_files SET filepath = ?, source_folder = ?, pre_trash_folder = NULL, is_trashed = 0 WHERE id = ?",
            rusqlite::params![target_path_str, original_source_folder, id],
        )
        .map_err(|e| format!("Failed to update database: {}", e))?;

        eprintln!("[restore_from_trash] Database updated successfully");
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| {
        eprintln!("[restore_from_trash] DB update failed: {}", e);
        e
    })?;

    Ok(())
}

#[command]
pub async fn batch_restore_from_trash(
    handle: AppHandle,
    ids: Vec<String>,
) -> Result<BatchFileOperationResult, String> {
    if ids.is_empty() {
        return Ok(BatchFileOperationResult { succeeded: 0, failed: 0 });
    }

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let rows = query_file_records(
            &conn,
            &ids,
            "SELECT id, filepath, COALESCE(pre_trash_folder, source_folder, '') FROM media_files WHERE id IN ({placeholders})",
        )?;
        let file_map: HashMap<String, (String, String)> = rows
            .into_iter()
            .filter_map(|row| {
                if row.len() == 3 {
                    Some((row[0].clone(), (row[1].clone(), row[2].clone())))
                } else {
                    None
                }
            })
            .collect();

        let mut restored_items: Vec<(String, String, String)> = Vec::new();
        let mut failed = 0usize;

        for id in &ids {
            let Some((current_path, source_folder)) = file_map.get(id) else {
                failed += 1;
                continue;
            };

            if validate_path_in_library(current_path, &library_root).is_err() {
                failed += 1;
                continue;
            }

            let source_folder = match validate_library_relative_folder(source_folder) {
                Ok(folder) => folder,
                Err(error) => {
                    log::warn!("[batch_restore_from_trash] Invalid source folder for {}: {}", id, error);
                    failed += 1;
                    continue;
                }
            };

            let Some(filename) = std::path::Path::new(current_path)
                .file_name()
                .and_then(|name| name.to_str())
            else {
                failed += 1;
                continue;
            };

            let target_dir = std::path::Path::new(&library_root).join(&source_folder);
            let target_path = target_dir.join(filename);
            let target_path_str = target_path.to_string_lossy().to_string();
            if validate_path_in_library(&target_path_str, &library_root).is_err() {
                failed += 1;
                continue;
            }

            if let Err(error) = std::fs::create_dir_all(&target_dir) {
                log::warn!(
                    "[batch_restore_from_trash] Failed to create target folder {}: {}",
                    target_dir.display(),
                    error
                );
                failed += 1;
                continue;
            }

            match std::fs::rename(current_path, &target_path) {
                Ok(_) => restored_items.push((
                    id.clone(),
                    target_path_str,
                    source_folder,
                )),
                Err(error) => {
                    log::warn!(
                        "[batch_restore_from_trash] Failed to restore {}: {}",
                        current_path,
                        error
                    );
                    failed += 1;
                }
            }
        }

        if !restored_items.is_empty() {
            let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (id, target_path, source_folder) in &restored_items {
                tx.execute(
                    "UPDATE media_files SET filepath = ?, source_folder = ?, pre_trash_folder = NULL, is_trashed = 0 WHERE id = ?",
                    rusqlite::params![target_path, source_folder, id],
                )
                .map_err(|e| format!("Failed to update database: {}", e))?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(BatchFileOperationResult {
            succeeded: restored_items.len(),
            failed,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// æ°¸ä¹…åˆ é™¤å›žæ“¶ç«™ä¸­çš„æ‰€æœ‰æ–‡ä»¶ï¼Œè¿“å›žè¢«åˆ é™¤çš„æ•°é‡ã€‚
#[command]
pub async fn empty_trash(handle: AppHandle) -> Result<i64, String> {
    eprintln!("[empty_trash] Emptying trash folder...");

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    // First get the file paths to delete
    let files_to_delete = tokio::task::spawn_blocking({
        let db_clone = db.clone();
        move || {
            let conn = open_conn(&db_clone).map_err(|e| e.to_string())?;

            // Get all files that are marked as trashed
            let mut stmt = conn.prepare(
                "SELECT id, filepath FROM media_files WHERE is_trashed = 1"
            ).map_err(|e| e.to_string())?;

            let rows: Vec<(String, String)> = stmt
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            Ok(rows)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    eprintln!("[empty_trash] Found {} trashed files to delete", files_to_delete.len());

    // Delete the physical files
    for (_, filepath) in &files_to_delete {
        if let Err(error) = validate_path_in_library(filepath, &library_root) {
            eprintln!("[empty_trash] Skipping out-of-library file {}: {}", filepath, error);
            continue;
        }
        eprintln!("[empty_trash] Deleting physical file: {}", filepath);
        if let Err(e) = std::fs::remove_file(filepath) {
            eprintln!("[empty_trash] Warning: Failed to delete physical file {}: {}", filepath, e);
        }
    }

    eprintln!("[empty_trash] Physical files deleted, now clearing database records...");

    // Now clear the database records
    let db = db_path(&handle)?;
    let deleted_count = tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::empty_trash(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    eprintln!("[empty_trash] Successfully emptied trash. {} records deleted.", deleted_count);
    Ok(deleted_count)
}

/// åˆå§‹åŒ–çµæ„Ÿåº“æ ¹ç›®å½•
///
/// æŽ¥æ“¶ç“¨æˆ·é€‰æ‹©çš„çˆ¶ç›®å½•è·¯å¾„ï¼ˆå¦‚ H:\ï¼‰ï¼Œ
/// åœ¨å…¶ä¸‹åˆ›å»º "NocturneGallery" æ–‡ä»¶å¤¹ï¼Œç„¶åŽåˆå§‹åŒ–å­ç»“æž„ã€‚
/// å¦‚æžœ NocturneGallery å·²å­˜åœ¨åˆ™ç›´æŽ¥ä½¿ç“¨ã€‚
#[command]
pub async fn init_library(handle: AppHandle, parent_path: String) -> Result<String, String> {
    println!("init_library called with path: {}", parent_path);
    eprintln!("[init_library] Parent path provided: {}", parent_path);

    // æž„å»º NocturneGallery å®Œæ•´è·¯å¾„
    let library_root = std::path::Path::new(&parent_path)
        .to_path_buf();

    let library_root_str = library_root
        .to_string_lossy()
        .to_string();

    eprintln!("[init_library] Library root will be: {}", library_root_str);

    // åˆ›å»ºç›®å½•ç»“æž„ï¼ˆå¦‚æžœå·²å­˜åœ¨åˆ™ç›´æŽ¥ä½¿ç“¨ï¼‰
    watcher::init_library_structure(&library_root_str)?;

    // æ‰§è¡Œæ–‡ä»¶å¤¹é‡å‘½åè¿ç§»ï¼ˆåª’ä½“åº“â†’çµæ„Ÿåº“ï¼Œé¡¹ç›®æ–‡ä»¶â†’ä½œå“é›†ï¼‰
    watcher::migrate_folder_names(&library_root_str)?;

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
    state.startup_backfill_shutdown.store(true, Ordering::Relaxed);

    let config_path = handle
        .path()
        .app_data_dir()
        .map(|p| p.join(".nocturne/config.json").to_string_lossy().to_string())
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

    let old_db_path = handle.path().app_data_dir()
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
        eprintln!("[init_library] Warning: Failed to init DB at new path: {}", e);
    }

    eprintln!("[init_library] Library initialized successfully at: {}", library_root_str);
    Ok(library_root_str)
}

/// èŽ·å–åº“æ ¹ç›®å½•è·¯å¾„
#[command]
pub async fn get_library_root(handle: AppHandle) -> Result<Option<String>, String> {
    let config_path = handle
        .path()
        .app_data_dir()
        .map(|p| p.join(".nocturne/config.json").to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get config path: {}", e))?;

    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<watcher::LibraryConfig>(&content) {
            // éªŒè¯è·¯å¾„æ˜¯å¦æœ‰æ•ˆ
            if watcher::is_valid_library_root(&config.root_path) {
                // æ‰§è¡Œæ–‡ä»¶å¤¹é‡å‘½åè¿ç§»ï¼ˆåª’ä½“åº“â†’çµæ„Ÿåº“ï¼Œé¡¹ç›®æ–‡ä»¶â†’ä½œå“é›†ï¼‰
                if let Err(e) = watcher::migrate_folder_names(&config.root_path) {
                    eprintln!("[get_library_root] Migration warning: {}", e);
                }

                // æ›´æ–°æ•°æ®åº“ä¸­çš„è·¯å¾„（启动期仅一次）
                if !folder_paths_updated_once().swap(true, Ordering::Relaxed) {
                    let db_path = db_path(&handle)?;
                    if let Err(e) = watcher::update_folder_paths_in_db(&db_path, &config.root_path) {
                        eprintln!("[get_library_root] Path update warning: {}", e);
                    }
                }

                return Ok(Some(config.root_path));
            }
        }
    }

    Ok(None)
}

/// è®¾ç½®åº“æ ¹ç›®å½•è·¯å¾„
#[command]
pub async fn set_library_root(handle: AppHandle, path: String) -> Result<(), String> {
    eprintln!("[set_library_root] Setting library root to: {}", path);

    // éªŒè¯è·¯å¾„æ˜¯å¦æœ‰æ•ˆ
    if !watcher::is_valid_library_root(&path) {
        return Err("Invalid library root: .nocturne directory not found".to_string());
    }

    let config = watcher::LibraryConfig {
        root_path: path.clone(),
        version: "1.0".to_string(),
    };

    let config_path = handle
        .path()
        .app_data_dir()
        .map(|p| p.join(".nocturne/config.json").to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get config path: {}", e))?;

    let config_json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, config_json)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    // Allow the new library root in the asset protocol scope so media files and
    // thumbnails under it can be served via convertFileSrc immediately.
    //
    // We intentionally do NOT forbid the old library root here because:
    //   1. The UI may still hold references to old-root thumbnails until the next
    //      media list refresh; forbidding would cause transient broken previews.
    //   2. tauri::scope::FsScope::forbid_directory has no guaranteed effect on
    //      already-opened asset requests in flight.
    //   3. The risk window is small: the old root remains readable only until the
    //      next app restart, after which the scope is rebuilt from the new config.
    // Residual documented in .audit/findings.md.
    if let Err(e) = handle.asset_protocol_scope().allow_directory(
        std::path::Path::new(&path),
        true,
    ) {
        log::warn!("[set_library_root] Failed to allow library root in asset scope: {}", e);
    }

    Ok(())
}

///èŽ·å–ç“¨æˆ·åå¥½è®¾ç½®
#[command]
pub async fn get_preference(
    handle: AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::get_preference(&conn, &key).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// è®¾ç½®ç“¨æˆ·åå¥½è®¾ç½®
#[command]
pub async fn set_preference(
    handle: AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::set_preference(&conn, &key, &value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

const ACTIVE_AI_CHAT_SESSION_PREF: &str = "ai_chat_active_session_id";

fn query_ai_chat_sessions(conn: &rusqlite::Connection) -> Result<Vec<AiChatSession>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
             FROM ai_chat_sessions s
             LEFT JOIN ai_chat_messages m ON m.session_id = s.id
             GROUP BY s.id
             HAVING message_count > 0
             ORDER BY s.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let sessions = stmt.query_map([], |row| {
        Ok(AiChatSession {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            message_count: row.get(4)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())?;
    Ok(sessions)
}

fn load_ai_chat_result(
    conn: &rusqlite::Connection,
    requested_session_id: Option<String>,
) -> Result<AiChatLoadResult, String> {
    let sessions = query_ai_chat_sessions(conn)?;
    let requested_session_id = requested_session_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let should_persist_active_session = requested_session_id.is_some();
    let preferred_session_id = requested_session_id
        .or_else(|| crud::get_preference(conn, ACTIVE_AI_CHAT_SESSION_PREF).ok().flatten());

    let active_session_id = preferred_session_id
        .filter(|id| sessions.iter().any(|session| session.id == *id))
        .or_else(|| sessions.first().map(|session| session.id.clone()));

    if should_persist_active_session {
        if let Some(session_id) = active_session_id.as_deref() {
            crud::set_preference(conn, ACTIVE_AI_CHAT_SESSION_PREF, session_id)
                .map_err(|e| e.to_string())?;
        }
    }

    let messages = if let Some(session_id) = active_session_id.as_deref() {
        let mut stmt = conn
            .prepare(
                "SELECT payload FROM ai_chat_messages
                 WHERE session_id = ?
                 ORDER BY created_at ASC, rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let loaded_messages = stmt.query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|payload| payload.ok())
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
            .collect();
        loaded_messages
    } else {
        Vec::new()
    };

    Ok(AiChatLoadResult {
        active_session_id,
        sessions,
        messages,
    })
}

#[command]
pub async fn load_ai_chat_session(
    handle: AppHandle,
    session_id: Option<String>,
) -> Result<AiChatLoadResult, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        load_ai_chat_result(&conn, session_id)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn save_ai_chat_session(
    handle: AppHandle,
    session_id: String,
    title: String,
    messages: Vec<serde_json::Value>,
) -> Result<AiChatSession, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let now = chrono::Local::now().timestamp_millis();
        let clean_title = title.trim();
        let session_title = if clean_title.is_empty() { "新对话" } else { clean_title };
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let created_at = tx
            .query_row(
                "SELECT created_at FROM ai_chat_sessions WHERE id = ?",
                [&session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(now);

        tx.execute(
            "INSERT INTO ai_chat_sessions (id, title, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
            rusqlite::params![session_id, session_title, created_at, now],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM ai_chat_messages WHERE session_id = ?",
            [&session_id],
        )
        .map_err(|e| e.to_string())?;

        let mut stored_message_ids = HashSet::new();
        for (index, message) in messages.iter().enumerate() {
            let raw_message_id = message
                .get("id")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}-{}", session_id, index));
            let base_message_id = format!("{}:{}", session_id, raw_message_id);
            let message_id = if stored_message_ids.insert(base_message_id.clone()) {
                base_message_id
            } else {
                let mut deduped_message_id = format!("{}:{}", base_message_id, index);
                while !stored_message_ids.insert(deduped_message_id.clone()) {
                    deduped_message_id = format!("{}:{}", base_message_id, stored_message_ids.len());
                }
                deduped_message_id
            };
            let role = message
                .get("role")
                .and_then(|value| value.as_str())
                .unwrap_or("assistant");
            let content = message
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let created_at = message
                .get("timestamp")
                .and_then(|value| value.as_i64())
                .unwrap_or(now + index as i64);
            let payload = serde_json::to_string(message).map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO ai_chat_messages (id, session_id, role, content, payload, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![message_id, session_id, role, content, payload, created_at],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.execute(
            "INSERT OR REPLACE INTO user_preferences (key, value) VALUES (?, ?)",
            rusqlite::params![ACTIVE_AI_CHAT_SESSION_PREF, session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        Ok(AiChatSession {
            id: session_id,
            title: session_title.to_string(),
            created_at,
            updated_at: now,
            message_count: messages.len() as i64,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn delete_ai_chat_session(
    handle: AppHandle,
    session_id: String,
) -> Result<AiChatLoadResult, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM ai_chat_sessions WHERE id = ?", [&session_id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM user_preferences WHERE key = ? AND value = ?",
            rusqlite::params![ACTIVE_AI_CHAT_SESSION_PREF, session_id],
        )
        .map_err(|e| e.to_string())?;
        load_ai_chat_result(&conn, None)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// æ‰«æåº“æ ¹ç›®å½•ä¸‹çš„æ‰€æœ‰å­æ–‡ä»¶å¤¹
#[command]
pub async fn scan_library(handle: AppHandle) -> Result<ScanResult, String> {
    let root = library_root(&handle)?;
    let db = db_path(&handle)?;

    eprintln!("[scan_library] Scanning entire library root: {}", root);

    // ç¼©ç•¥å›¾ç›®å½•ä½¿ç“¨åº“æ ¹ç›®å½•ä¸‹çš„ .nocturne/thumbsï¼Œä¸Ž scanner.rs ä¿æŒä¸€è‡´
    let thumbs = std::path::Path::new(&root).join(".nocturne").join("thumbs").to_string_lossy().to_string();
    eprintln!("[scan_library] Thumbs dir: {}", thumbs);

    let h = handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        scanner::scan_directory_with_progress(&root, &db, &thumbs, |current, total, filename| {
            let _ = h.emit("scan_progress", serde_json::json!({
                "current": current,
                "total": total,
                "filename": filename,
            }));
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("scan_library failed: {:?}", e))?;

    eprintln!("[scan_library] Scan completed: scanned={}, imported={}, skipped={}",
        result.scanned_count, result.imported_count, result.skipped_count);
    let _ = handle.emit("scan_complete", serde_json::json!({ "total": result.imported_count }));

    Ok(result)
}

/// æ¸…ç©ºæ‰€æœ‰åª’ä½“æ•°æ®ï¼ˆç“¨äºŽé‡æ–°åˆå§‹åŒ–ï¼‰ï¼Œè¿“å›žåˆ é™¤çš„æ–‡ä»¶æ•°é‡
#[command]
pub async fn clear_all_media(handle: AppHandle) -> Result<i64, String> {
    eprintln!("[clear_all_media] Starting to clear all media...");
    let db = db_path(&handle)?;
    let count = tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::clear_all_data(&mut conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("clear_all_data error: {}", e))?;

    eprintln!("[clear_all_media] Cleared {} media files", count);
    Ok(count)
}

/// é‡æ–°æ‰«æåº“ç›®å½•ï¼ˆå…ˆæ¸…ç©ºå†æ‰«æï¼‰
#[command]
pub async fn rescan_library(handle: AppHandle) -> Result<ScanResult, String> {
    eprintln!("[rescan_library] Starting rescan...");

    // å…ˆæ¸…ç©ºæ‰€æœ‰æ•°æ®
    let db = db_path(&handle)?;
    let count = tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::clear_all_data(&mut conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("clear_all_data error: {}", e))?;

    eprintln!("[rescan_library] Data cleared ({} files), now scanning...", count);

    // èŽ·å–åº“æ ¹ç›®å½•å¹¶æ‰«ææ•´ä¸ªç›®å½•
    let root = library_root(&handle)?;
    eprintln!("[rescan_library] Scanning entire library root: {}", root);

    let db = db_path(&handle)?;

    // ç¼©ç•¥å›¾ç›®å½•ä½¿ç“¨åº“æ ¹ç›®å½•ä¸‹çš„ .nocturne/thumbs
    let thumbs = std::path::Path::new(&root).join(".nocturne").join("thumbs").to_string_lossy().to_string();
    eprintln!("[rescan_library] Thumbs dir: {}", thumbs);

    let h = handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        scanner::scan_directory_with_progress(&root, &db, &thumbs, |current, total, filename| {
            let _ = h.emit("scan_progress", serde_json::json!({
                "current": current,
                "total": total,
                "filename": filename,
            }));
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("scan_directory failed: {:?}", e))?;

    eprintln!("[rescan_library] Scan completed: scanned={}, imported={}, skipped={}",
        result.scanned_count, result.imported_count, result.skipped_count);
    let _ = handle.emit("scan_complete", serde_json::json!({ "total": result.imported_count }));

    Ok(result)
}

/// å°†æ–‡ä»¶ç§»åŠ¨åˆ°ç›®æ ‡æ–‡ä»¶å¤¹ï¼ˆçµæ„Ÿåº“/é¡¹ç›®æ–‡ä»¶/å›žæ“¶ç«™ï¼‰
/// åŒç›˜ç§»åŠ¨ç“¨ renameï¼Œè·¨ç›˜ä¼šå¤±è´¥
#[command]
pub async fn move_file_to_folder(
    handle: AppHandle,
    file_id: String,
    source_path: String,
    target_folder: String,
) -> Result<(), String> {
    eprintln!("[move_file_to_folder] Moving file {} to folder {}", file_id, target_folder);

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
    let source_path = source_path_from_db;
    validate_path_in_library(&source_path, &library_root)?;
    let target_folder = validate_library_relative_folder(&target_folder)?;

    // æž„å»ºç›®æ ‡è·¯å¾„ï¼šlibrary_root + target_folder + filename
    let filename = std::path::Path::new(&source_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid source path")?
        .to_string();

    let target_path = std::path::Path::new(&library_root)
        .join(&target_folder)
        .join(&filename);

    let target_path_str = target_path.to_string_lossy().to_string();
    validate_path_in_library(&target_path_str, &library_root)?;
    eprintln!("[move_file_to_folder] Target path: {}", target_path_str);

    // ç¡®ä¿ç›®æ ‡æ–‡ä»¶å¤¹å­˜åœ¨
    let _ = handle.emit("file_move_progress", serde_json::json!({
        "current": 0,
        "total": 1,
        "filename": filename,
    }));
    std::fs::create_dir_all(std::path::Path::new(&library_root).join(&target_folder))
        .map_err(|e| format!("Failed to create target folder: {}", e))?;

    // åŒç›˜ç§»åŠ¨æ–‡ä»¶ï¼ˆrenameï¼‰
    tokio::task::spawn_blocking(move || {
        std::fs::rename(&source_path, &target_path)
            .map_err(|e| format!("Failed to move file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[move_file_to_folder] Move failed: {}", e);
        e
    })?;

    eprintln!("[move_file_to_folder] File moved successfully");

    // æ›´æ–°æ•°æ®åº“ä¸­çš„è·¯å¾„
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::update_media_file_path(&mut conn, &file_id, &target_path_str)
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  ç½‘é¡µä¹¦ç­¾ Commands
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// æ·»åŠ ç½‘é¡µä¹¦ç­¾
#[command]
pub async fn add_bookmark(
    handle: AppHandle,
    url: String,
    title: Option<String>,
    description: Option<String>,
    tags: Option<String>,
) -> Result<i64, String> {
    let url = validate_http_url(&url)?;
    eprintln!("[add_bookmark] Adding bookmark: {}", url);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::insert_bookmark(&conn, &url, title.as_deref(), description.as_deref(), tags.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// èŽ·å–æ‰€æœ‰ä¹¦ç­¾
#[command]
pub async fn get_bookmarks(handle: AppHandle) -> Result<Vec<crate::models::Bookmark>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::query_bookmarks(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// åˆ é™¤ä¹¦ç­¾
#[command]
pub async fn delete_bookmark(handle: AppHandle, id: i64) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::delete_bookmark(&conn, id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// æ›´æ–°ä¹¦ç­¾ä¿¡æ¯
#[command]
pub async fn update_bookmark(
    handle: AppHandle,
    id: i64,
    title: Option<String>,
    description: Option<String>,
    tags: Option<String>,
) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::update_bookmark(&conn, id, title.as_deref(), description.as_deref(), tags.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// ç“¨ç³»ç»Ÿé»˜è®¤æµè§ˆå™¨æ‰“å¼€ URL
#[command]
pub async fn open_url_in_browser(url: String) -> Result<(), String> {
    let url = validate_http_url(&url)?;
    eprintln!("[open_url_in_browser] Opening: {}", url);
    tokio::task::spawn_blocking(move || {
        open::that(&url).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// ä»Žå¤–éƒ¨æ‹–å…¥æ–‡ä»¶åˆ°åº“ç›®å½•ï¼ˆå¤åˆ¶æ–‡ä»¶å¹¶å¯¼å…¥æ•°æ®åº“ï¼‰
#[command]
pub async fn import_file_to_library(
    handle: AppHandle,
    source_path: String,
    target_folder: String,
    target_category: Option<String>,
) -> Result<(), String> {
    log::debug!("[import_file_to_library] Importing {} to {}", source_path, target_folder);

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
    let target_path = std::path::Path::new(&library_root)
        .join(&target_folder)
        .join(&filename);

    let target_path_str = target_path.to_string_lossy().to_string();
    log::debug!("[import_file_to_library] Target path: {}", target_path_str);

    // æ£€æŸ¥ç›®æ ‡æ–‡ä»¶æ˜¯å¦å·²å­˜åœ¨ï¼ˆå­˜åœ¨åˆ™è·³è¿‡ï¼‰
    if target_path.exists() {
        log::debug!("[import_file_to_library] File already exists, skipping: {}", target_path_str);
        let _ = handle.emit("import_skipped", serde_json::json!({
            "filename": filename,
            "targetFolder": target_folder,
            "reason": "existing-file",
        }));
        return Ok(());
    }

    let _ = handle.emit("import_progress", serde_json::json!({
        "current": 0,
        "total": 1,
        "filename": filename.clone(),
    }));

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
    assign_category_for_filepath(&db, &target_path_str, target_category.as_deref())
        .map_err(|e| {
            log::debug!("[import_file_to_library] Category assignment failed: {}", e);
            e
        })?;

    let _ = handle.emit("import_index_committed", serde_json::json!({
        "current": 1,
        "total": 1,
    }));

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

    let is_heavy = matches!(ext_lower.as_str(), "psd" | "psb" | "tiff" | "mp4" | "mov" | "avi" | "mkv" | "webm");
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
    }).await;
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

    if let Ok(_permit) = semaphore.acquire_owned().await {
        let id_for_enrich = file_id.clone();
        let target_p2_for_enrich = target_p2.clone();
        let db_p2_for_enrich = db_p2.clone();
        let root_p2_for_enrich = root_p2.clone();

        match tokio::task::spawn_blocking(move || {
            scanner::scan_single_file_enrich(&id_for_enrich, &target_p2_for_enrich, &db_p2_for_enrich, &root_p2_for_enrich)
        }).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::warn!("[import_file_to_library] Enrich failed for {}: {}", target_p2, e),
            Err(e) => log::warn!("[import_file_to_library] Enrich task join error for {}: {}", target_p2, e),
        }
    } else {
        log::warn!("[import_file_to_library] Failed to acquire enrich permit for {}", target_p2);
    }

    let _ = handle.emit("media_metadata_updated", serde_json::json!({ "id": file_id }));
    let _ = handle.emit("import_progress", serde_json::json!({
        "current": 1,
        "total": 1,
        "filename": filename.clone(),
    }));
    let _ = handle.emit("import_complete", serde_json::json!({ "total": 1 }));

    log::debug!("[import_file_to_library] Import copy complete, enrichment attempted");
    Ok(())
    }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  å³é“®èœå• Commands
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// æ°¸ä¹…åˆ é™¤æ–‡ä»¶ï¼ˆä»Žæ•°æ®åº“å’Œæ–‡ä»¶ç³»ç»Ÿï¼‰
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

        let _ = handle_for_task.emit("import_progress", serde_json::json!({
            "current": 0,
            "total": 1,
            "filename": "正在分析拖入项目",
        }));

        let library_root = library_root(&handle_for_task)?;
        let db = db_path(&handle_for_task)?;
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
                log::warn!("[import_paths_to_library] Source path does not exist: {}", raw_source_path);
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

            for entry in walkdir::WalkDir::new(&source_path).into_iter().filter_map(Result::ok) {
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
        let _ = handle_for_task.emit("import_progress", serde_json::json!({
            "current": 0,
            "total": total,
            "filename": "正在写入素材索引",
        }));

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

                    match scanner::scan_single_file_minimal_with_conn(&tx, &source_path_str, &target_path_str, &library_root) {
                        Ok(_) => {
                            let file_id = match media_id_by_filepath(&tx, &target_path_str) {
                                Ok(id) => id,
                                Err(e) => {
                                    log::error!("[bulk import] media id lookup failed for {}: {}", target_path_str, e);
                                    failed_count += 1;
                                    continue;
                                }
                            };

                            indexed_count += 1;
                            let _ = tx.execute(
                                "UPDATE media_files SET source_folder = ? WHERE id = ?",
                                rusqlite::params![target_category.as_deref(), file_id],
                            );
                            import_jobs.push((file_id, source_path.clone(), target_path.clone()));
                        }
                        Err(e) => {
                            log::error!("[bulk import] minimal scan failed for {}: {}", target_path_str, e);
                            failed_count += 1;
                        }
                    }
                }

                tx.commit().map_err(|e| format!("Transaction commit failed: {}", e))?;
                let _ = handle_for_task.emit("import_index_committed", serde_json::json!({
                    "current": indexed_count,
                    "total": total,
                }));
            }
        }

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

            if let Err(e) = scanner::scan_single_file_enrich(&file_id, &target_path_str, &db, &library_root) {
                log::warn!("[bulk import] Enrich failed for {}: {}", target_path_str, e);
            }

            imported_count += 1;
            let _ = handle_for_task.emit("media_metadata_updated", serde_json::json!({ "id": file_id }));
            let _ = handle_for_task.emit("import_progress", serde_json::json!({
                "current": imported_count,
                "total": total,
                "filename": progress_filename,
            }));
        }

        let _ = handle_for_task.emit("import_complete", serde_json::json!({ "total": imported_count }));

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
) -> Result<(), String> {
    eprintln!("[delete_file_permanently] Deleting file: {}", id);

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

        eprintln!("[delete_file_permanently] Removing physical file: {}", filepath);

        // åˆ é™¤ç‰©ç†æ–‡ä»¶
        // 删除物理文件
        std::fs::remove_file(&filepath)
            .map_err(|e| format!("Failed to delete file: {}", e))?;

        eprintln!("[delete_file_permanently] Deleting database record: {}", id);

        // 从数据库删除记录
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crud::delete_media_file(&tx, &id).map_err(|e| e.to_string())?;
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
) -> Result<BatchFileOperationResult, String> {
    if ids.is_empty() {
        return Ok(BatchFileOperationResult { succeeded: 0, failed: 0 });
    }

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
                crud::delete_media_file(&tx, id).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(BatchFileOperationResult {
            succeeded: deleted_ids.len(),
            failed,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// å¦å­˜ä¸º - æ‰“å¼€ç³»ç»Ÿä¿å­˜å¯¹è¯æ¡†å¹¶å¤åˆ¶æ–‡ä»¶
#[command]
pub async fn save_file_as(
    handle: AppHandle,
    source_path: String,
) -> Result<String, String> {
    eprintln!("[save_file_as] Saving file: {}", source_path);

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
                let file_path = handle_clone.dialog().file()
                    .set_title("另存为")
                    .set_file_name(&default_name)
                    .blocking_save_file();

                let result = match file_path {
                    Some(path) => {
                        // ä½¿ç“¨ into_path() æ–¹æ³•è½¬æ¢ FilePath ä¸º PathBuf
                        match path.into_path() {
                            Ok(path_buf) => {
                                match std::fs::copy(&source_path_clone, &path_buf) {
                                    Ok(_) => Ok(path_buf.to_string_lossy().to_string()),
                                    Err(e) => Err(format!("Failed to copy file: {}", e)),
                                }
                            }
                            Err(e) => Err(format!("Failed to convert path: {}", e)),
                        }
                    }
                    None => Err("用户取消".to_string()),
                };

                let _ = tx.send(result);
            })
            .map_err(|e| format!("Failed to run on main thread: {}", e))?;

        rx.recv().unwrap_or_else(|e| Err(format!("Channel error: {}", e)))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// å°† base64 å›¾ç‰‡æ•°æ®å†™å…¥ä¸´æ—¶æ–‡ä»¶ï¼Œè¿“å›žä¸´æ—¶æ–‡ä»¶è·¯å¾„
#[command]
pub async fn write_temp_file(base64_data: String) -> Result<String, String> {
    eprintln!("[write_temp_file] Writing base64 image to temp file");

    // Determine file extension from original data URL if available
    let extension = if base64_data.starts_with("data:image/") {
        let mime_part = &base64_data[..base64_data.find(';').unwrap_or(base64_data.len())];
        match mime_part.split('/').last() {
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
    let unique_filename = format!("nocturne_paste_{}_{}",
        chrono::Utc::now().timestamp_millis(),
        extension
    );
    let temp_path = temp_dir.join(unique_filename);
    let temp_path_str = temp_path.to_string_lossy().to_string();

    eprintln!("[write_temp_file] Creating temp file: {}", temp_path_str);

    // Write bytes to temp file
    std::fs::write(&temp_path, decoded_bytes)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    eprintln!("[write_temp_file] Temp file created successfully: {}", temp_path_str);
    Ok(temp_path_str)
}

/// ä»Žå›¾ç‰‡æ–‡ä»¶ä¸­æå–ä¸»è¦é¢œè‰²ï¼ˆæ“¯æŒç¼“å­˜ï¼‰
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
            target_path = target_root.join(format!("ai-generated-{}-{}.{}", timestamp, suffix, extension));
            suffix += 1;
        }

        let target_path_str = target_path.to_string_lossy().to_string();
        let filename = target_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("ai-generated.png")
            .to_string();

        let _ = handle_for_task.emit("import_progress", serde_json::json!({
            "current": 0,
            "total": 1,
            "filename": filename,
        }));

        std::fs::copy(&source_path_buf, &target_path)
            .map_err(|e| format!("Failed to save generated image: {}", e))?;

        scanner::scan_single_file(&target_path_str, &db, "", &library_root)
            .map_err(|e| format!("Failed to import generated image: {}", e))?;

        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let media_file = media_file_by_filepath(&conn, &target_path_str)?;
        crud::upsert_ai_metadata(
            &conn,
            &media_file.id,
            &trimmed_prompt,
            &model,
            "OpenAI-compatible",
        )
        .map_err(|e| e.to_string())?;

        let _ = handle_for_task.emit("import_progress", serde_json::json!({
            "current": 1,
            "total": 1,
            "filename": media_file.filename,
        }));
        let _ = handle_for_task.emit("import_complete", serde_json::json!({ "total": 1 }));
        let _ = handle_for_task.emit("media_metadata_updated", serde_json::json!({ "id": media_file.id }));

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
    eprintln!("[extract_colors] Extracting colors from: {} for media_id: {}", file_path, media_id);

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

    // 没有缓存，从图片提取（复用公共函数）
    let file_path_clone = file_path.clone();
    let top_colors: Vec<String> = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let img = image::open(&file_path_clone)
            .map_err(|e| format!("Failed to open image: {}", e))?;
        Ok(crate::media::thumbnail::extract_dominant_colors(&img))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!("[extract_colors] Extracted {} colors: {:?}", top_colors.len(), top_colors);

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
            eprintln!("[extract_colors] Cached colors to database for media_id: {}", media_id);
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
    eprintln!("[save_clipboard_image] Saving clipboard image: {}", file_name);

    // Get library root directory using the existing function
    let library_root = library_root(&handle)?;
    eprintln!("[save_clipboard_image] Library root: {}", library_root);

    // Determine target folder based on current context.
    let target_folder = target_folder.unwrap_or_else(|| "灵感库".to_string());
    let target_path = std::path::Path::new(&library_root)
        .join(&target_folder)
        .join(&file_name);

    let target_path_str = target_path.to_string_lossy().to_string();
    eprintln!("[save_clipboard_image] Target path: {}", target_path_str);

    // Ensure target folder exists
    let _ = handle.emit("import_progress", serde_json::json!({
        "current": 0,
        "total": 1,
        "filename": file_name.clone(),
    }));
    std::fs::create_dir_all(std::path::Path::new(&library_root).join(&target_folder))
        .map_err(|e| format!("Failed to create target folder: {}", e))?;

    // Write image bytes directly to the target file
    std::fs::write(&target_path, image_bytes)
        .map_err(|e| format!("Failed to write image file: {}", e))?;

    eprintln!("[save_clipboard_image] Image saved successfully: {}", target_path_str);

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

    assign_category_for_filepath(&db, &target_path_str, target_category.as_deref())
        .map_err(|e| {
            eprintln!("[save_clipboard_image] Category assignment failed: {}", e);
            e
        })?;

    eprintln!("[save_clipboard_image] File saved and scanned successfully: {}", target_path_str);
    let _ = handle.emit("import_progress", serde_json::json!({
        "current": 1,
        "total": 1,
        "filename": file_name,
    }));
    let _ = handle.emit("import_complete", serde_json::json!({ "total": 1 }));
    Ok(target_path_str)
}

/// æ£€æŸ¥æ–‡ä»¶æ˜¯å¦é‡å¤ï¼ˆSHA256 ç²¾ç¡®åŒ¹é… + pHash æ„ŸçŸ¥å“ˆå¸Œï¼‰
/// æ±‰æ˜Žè·ç¦»é˜ˆå€¼ â‰¤ 3ï¼ˆæžä¸¥æ ¼ï¼‰
#[command]
pub async fn check_duplicate(
    handle: AppHandle,
    file_path: String,
) -> Result<DuplicateCheckResult, String> {
    log::debug!("[check_duplicate] Checking duplicates for: {}", file_path);

    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        // ç¬¬ä¸€å±‚ï¼šSHA256 ç²¾ç¡®åŒ¹é…
        let sha256 = image_hash::compute_sha256(&file_path)?;
        if let Some(existing) = crud::find_by_sha256(&conn, &sha256).map_err(|e| e.to_string())? {
            let (source_folder, category_name) =
                crud::get_media_duplicate_placement(&conn, &existing.id).map_err(|e| e.to_string())?;
            let pending_preview = read_pending_import_preview_data_url(&file_path).ok();
            log::debug!("[check_duplicate] Exact duplicate found: {}", existing.filename);
            return Ok(DuplicateCheckResult {
                duplicate_type: Some("exact".to_string()),
                existing_item: Some(existing),
                similarity: 1.0,
                existing_placement: Some(DuplicatePlacement {
                    source_folder,
                    category_name,
                }),
                pending_preview,
            });
        }

        // ç¬¬äºŒå±‚ï¼špHash æ„ŸçŸ¥å“ˆå¸Œï¼ˆä»…å›¾ç‰‡ï¼‰
        let ext = std::path::Path::new(&file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let image_exts = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "avif"];
        if image_exts.contains(&ext.as_str()) {
            let has_existing_phash = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM media_files WHERE phash IS NOT NULL LIMIT 1)",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?;

            if !has_existing_phash {
                log::debug!("[check_duplicate] No existing pHash records; skipping similar check");
                return Ok(DuplicateCheckResult {
                    duplicate_type: None,
                    existing_item: None,
                    similarity: 0.0,
                    existing_placement: None,
                    pending_preview: None,
                });
            }

            let phash = image_hash::compute_phash(&file_path).map_err(|e| e.to_string())?;

            // æŸ¥æ‰¾æ±‰æ˜Žè·ç¦» â‰¤ 3 çš„è®°å½•
            let matches = crud::find_by_phash_threshold(&conn, phash, 3).map_err(|e| e.to_string())?;

            if let Some(existing) = matches.into_iter().next() {
                let (source_folder, category_name) =
                    crud::get_media_duplicate_placement(&conn, &existing.id).map_err(|e| e.to_string())?;
                let similarity = if let Some(existing_phash) = existing.phash {
                    image_hash::similarity_score(phash, existing_phash as u64) / 100.0
                } else {
                    0.0
                };
                let pending_preview = read_pending_import_preview_data_url(&file_path).ok();
                log::debug!("[check_duplicate] Similar duplicate found: {} (similarity: {:.2})", existing.filename, similarity);
                return Ok(DuplicateCheckResult {
                    duplicate_type: Some("similar".to_string()),
                    existing_item: Some(existing),
                    similarity,
                    existing_placement: Some(DuplicatePlacement {
                        source_folder,
                        category_name,
                    }),
                    pending_preview,
                });
            }
        }

        log::debug!("[check_duplicate] No duplicates found");
        Ok(DuplicateCheckResult {
            duplicate_type: None,
            existing_item: None,
            similarity: 0.0,
            existing_placement: None,
            pending_preview: None,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// èŽ·å–æ–‡ä»¶åŸºæœ¬ä¿¡æ¯ï¼ˆå¤§å°ï¼‰
#[command]
pub async fn get_file_info(path: String) -> Result<FileInfo, String> {
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

    Ok(FileInfo {
        size: metadata.len() as i64,
        is_dir: metadata.is_dir(),
    })
}

/// æ›¿æ¢å·²æœ‰æ–‡ä»¶ï¼ˆåˆ é™¤æ—§æ–‡ä»¶ï¼Œå¯¼å…¥æ–°æ–‡ä»¶ï¼‰
#[command]
pub async fn replace_file(
    handle: AppHandle,
    source_path: String,
    target_id: String,
) -> Result<(), String> {
    eprintln!("[replace_file] Replacing {} with {}", target_id, source_path);

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;
    let thumbs_dir = std::path::Path::new(&library_root)
        .join(".nocturne")
        .join("thumbs")
        .to_string_lossy()
        .to_string();




    // èŽ·å–ç›®æ ‡æ–‡ä»¶ä¿¡æ¯
    let (target_filepath, target_filename) = tokio::task::spawn_blocking({
        let db = db.clone();
        let target_id = target_id.clone();
        move || {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let detail = crud::get_media_detail(&conn, &target_id)
                .map_err(|e: anyhow::Error| e.to_string())?
                .ok_or_else(|| "Target file not found".to_string())?;
            let target_filename = detail.file.filename.clone();
            let target_filepath = detail.file.filepath.clone();
            Ok::<(String, String), String>((target_filepath, target_filename))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // 1. 复制新文件到临时路径（旧文件此时仍完整）
    let target_dir = std::path::Path::new(&target_filepath)
        .parent()
        .ok_or_else(|| "Invalid target path".to_string())?;
    let dest_path = target_dir.join(&target_filename);
    let tmp_path = target_dir.join(format!("{}.tmp", target_filename));

    if let Err(e) = std::fs::copy(&source_path, &tmp_path) {
        // 复制失败：清理可能已部分写入的 .tmp，旧文件完整保留
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to copy new file to tmp: {}", e));
    }
    eprintln!("[replace_file] Copied new file to tmp: {}", tmp_path.display());

    // 2. 原子性重命名 .tmp 为最终路径（在大多数平台上原子性覆盖旧文件）
    if let Err(e) = std::fs::rename(&tmp_path, &dest_path) {
        // rename 失败：旧文件仍完整，清理 .tmp
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to rename tmp file to destination: {}", e));
    }
    eprintln!("[replace_file] Renamed tmp to final path: {}", dest_path.display());
    let dest_path_str = dest_path.to_string_lossy().to_string();

    // 3. 在数据库事务中删除旧记录并导入新记录
    let db_clone = db_path(&handle)?;
    let dest_path_str_tx = dest_path_str.clone();
    let target_id_tx = target_id.clone();
    let library_root_clone = library_root.clone();
    let thumbs_dir_tx = thumbs_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db_clone).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 删除旧记录（事务内）
        crud::delete_media_file(&tx, &target_id_tx).map_err(|e| e.to_string())?;
        eprintln!("[replace_file] Deleted old DB record: {}", target_id_tx);

        // 导入新文件（同一事务内）
        scanner::scan_single_file_with_conn(&tx, &dest_path_str_tx, &thumbs_dir_tx, &library_root_clone)
            .map_err(|e| e.to_string())?;
        eprintln!("[replace_file] Imported new file in transaction: {}", dest_path_str_tx);

        tx.commit().map_err(|e| e.to_string())?;
        eprintln!("[replace_file] Transaction committed");
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // 文件系统与数据库均已一致：新文件就位，旧记录已替换为新记录。
    Ok(())
}

/// 检测系统中是否安装了 ffmpeg（执行 ffmpeg -version）
/// 返回 true 表示可用，false 表示未安装或不在 PATH 中
#[command]
pub fn check_ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}


/// è¡¥å……è®¡ç®—å·²æœ‰å›¾ç‰‡çš„ sha256 å’Œ phashï¼ˆåŽå°æ‰¹é‡å¤„ç†ï¼‰
#[command]
pub async fn backfill_file_hashes(handle: AppHandle) -> Result<String, String> {
    eprintln!("[backfill_file_hashes] Starting hash backfill");

    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        let mut total_processed = 0;
        let mut total_errors = 0;

        loop {
            let batch = crud::backfill_hashes_batch(&conn, 50).map_err(|e| e.to_string())?;
            if batch.is_empty() {
                break;
            }

            eprintln!("[backfill_file_hashes] Processing batch of {} files", batch.len());

            for (id, filepath) in batch {
                match (image_hash::compute_sha256(&filepath), image_hash::compute_phash(&filepath)) {
                    (Ok(sha256), Ok(phash)) => {
                        if let Err(e) = crud::update_file_hashes(&conn, &id, &sha256, phash as i64) {
                            eprintln!("[backfill_file_hashes] Failed to update hashes for {}: {}", id, e);
                            total_errors += 1;
                        }
                    }
                    (Err(e), _) | (_, Err(e)) => {
                        eprintln!("[backfill_file_hashes] Failed to compute hash for {}: {}", filepath, e);
                        total_errors += 1;
                    }
                }
                total_processed += 1;
            }
        }

        let remaining = crud::count_missing_hashes(&conn).unwrap_or(-1);
        eprintln!("[backfill_file_hashes] Done. Processed: {}, Errors: {}, Remaining: {}", total_processed, total_errors, remaining);
        Ok(format!("Processed: {}, Errors: {}, Remaining: {}", total_processed, total_errors, remaining))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// é‡æ–°ç“Ÿæˆæ‰€æœ‰ç¼©ç•¥å›¾
/// 1. æ¸…ç©º thumbs ç›®å½•
/// 2. æ¸…ç©ºæ•°æ®åº“ä¸­çš„ thumbnail_path
/// 3. ä¸ºæ‰€æœ‰å›¾ç‰‡æ–‡ä»¶é‡æ–°ç“Ÿæˆç¼©ç•¥å›¾å¹¶æ·»åŠ åˆ°é˜Ÿåˆ—
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

    eprintln!("[regenerate_all_thumbnails] Cleared {} thumbnail files", thumbs_cleared);

    // æ­¥éª¤ 2: æ¸…ç©ºæ•°æ®åº“ä¸­çš„ thumbnail_path
    let db_cleared = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<usize, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let count = crud::clear_all_thumbnail_paths(&conn).map_err(|e| e.to_string())?;
            Ok(count)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!("[regenerate_all_thumbnails] Cleared {} thumbnail paths from DB", db_cleared);

    // æ­¥éª¤ 3: æŸ¥è¯¢æ‰€æœ‰å›¾ç‰‡æ–‡ä»¶
    let image_files = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<Vec<(String, String)>, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let files = crud::query_media_files_for_regenerate(&conn).map_err(|e| e.to_string())?;
            Ok(files)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let total_files = image_files.len();
    eprintln!("[regenerate_all_thumbnails] Found {} image files to regenerate", total_files);

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

fn micro_backfill_scope_is_priority(
    source_folder: Option<&str>,
    active_nav: Option<&str>,
) -> bool {
    matches!(source_folder.map(str::trim), Some("灵感库")) || matches!(active_nav.map(str::trim), Some("library"))
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
    let source_folder = source_folder.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let active_nav = active_nav.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let library_root_filter = library_root(handle).ok().map(|root| format!("{}%", root));
    let files = tokio::task::spawn_blocking(move || -> Result<Vec<(String, String, Option<String>, Option<String>)>, String> {
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

    for (media_id, _filepath, thumbnail_path, thumbnail_micro_path) in files.into_iter().take(total_to_process) {
        if shutdown.load(Ordering::Relaxed) {
            log::warn!("[startup_backfill] cancelled by shutdown signal");
            break;
        }

        let thumbnail_path = if let Some(path) = thumbnail_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            path
        } else {
            processed += 1;
            continue;
        };

        let thumbnail_path_buf = std::path::PathBuf::from(thumbnail_path);
        if !thumbnail_path_buf.is_file() {
            log::warn!("[startup_backfill] thumbnail_path missing or invalid: {}", thumbnail_path);
            processed += 1;
            continue;
        }

        let thumbnail_micro_path_buf = thumbnail_micro_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from);

        let micro_needs_regen = match thumbnail_micro_path_buf.as_ref() {
            None => true,
            Some(existing_micro_path) => match image::image_dimensions(existing_micro_path) {
                Ok((width, height)) => width.max(height) < 512,
                Err(_) => true,
            },
        };

        if !micro_needs_regen {
            processed += 1;
            continue;
        }

        let thumbnail_filename = match thumbnail_path_buf.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => {
                processed += 1;
                continue;
            }
        };
        let micro_filename = if let Some(stripped) = thumbnail_filename.strip_suffix("_thumb.jpg") {
            format!("{}_micro.webp", stripped)
        } else if let Some(stripped) = thumbnail_filename.strip_suffix("_thumb.webp") {
            format!("{}_micro.webp", stripped)
        } else if thumbnail_filename.ends_with("_micro.webp") {
            thumbnail_filename.to_string()
        } else {
            processed += 1;
            continue;
        };

        let micro_dst = thumbnail_micro_path_buf.unwrap_or_else(|| thumbnail_path_buf.with_file_name(micro_filename));
        let db_path_for_task = db_path.clone();
        let media_id_for_task = media_id.clone();
        let thumbnail_src_for_task = thumbnail_path_buf.clone();
        let micro_dst_for_task = micro_dst.clone();

        let _ = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            if let Some(parent) = micro_dst_for_task.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            let micro_path_owned = if micro_dst_for_task.exists() {
                Some(micro_dst_for_task.to_string_lossy().to_string())
            } else {
                let generated = crate::media::thumbnail::generate_micro_thumbnail(&thumbnail_src_for_task, &micro_dst_for_task)
                    .map(|_| micro_dst_for_task.exists())
                    .unwrap_or(false);
                if generated {
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
            let _ = app.emit("startup_backfill_progress", serde_json::json!({
                "current": processed,
                "total": total,
            }));
        }

        if processed >= total_to_process {
            break;
        }
    }

    let remaining = total.saturating_sub(processed);
    let _ = app.emit("startup_backfill_complete", serde_json::json!({
        "processed": processed,
        "remaining": remaining,
    }));
    log::info!("[startup_backfill] done, processed={}, remaining={}", processed, remaining);
    Ok(format!("processed={}, remaining={}", processed, remaining))
}

/// å¼ºåˆ¶æ¸…ç©ºç¼©ç•¥å›¾ç›®å½•å’Œæ•°æ®åº“å­—æ®µ
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

    eprintln!("[force_clear_thumbnails] Cleared {} thumbnail files", thumbs_cleared);

    // æ­¥éª¤ 2: æ¸…ç©ºæ•°æ®åº“ä¸­çš„ thumbnail_path å’Œ color_dominant
    let db_cleared = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<(usize, usize), String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;

            // æ¸…ç©º thumbnail_path
            let thumb_count = conn.execute(
                "UPDATE media_files SET thumbnail_path = NULL",
                [],
            ).map_err(|e| e.to_string())?;

            // æ¸…ç©º color_dominant
            let color_count = conn.execute(
                "UPDATE media_files SET color_dominant = NULL",
                [],
            ).map_err(|e| e.to_string())?;

            Ok((thumb_count, color_count))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    eprintln!("[force_clear_thumbnails] Cleared {} thumbnail paths and {} color records from DB", db_cleared.0, db_cleared.1);

    let message = format!(
        "已清空缩略图数据\n文件: {} 个\n数据库: {} 条缩略图记录, {} 条颜色记录",
        thumbs_cleared, db_cleared.0, db_cleared.1
    );

    Ok(message)
}

/// ç´§æ€¥ä¿®å¤ï¼šæ¸…ç†ä¸åœ¨åº“æ ¹ç›®å½•ä¸‹çš„é“™è¯¯è®°å½•
#[command]
pub async fn emergency_cleanup_invalid_files(handle: AppHandle) -> Result<String, String> {
    eprintln!("[emergency_cleanup] Starting emergency cleanup of invalid files");

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    // èŽ·å–æ‰€æœ‰æ–‡ä»¶è®°å½•
    let files_to_check = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<Vec<(String, String)>, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT id, filepath FROM media_files")
                .map_err(|e| e.to_string())?;
            let files: Vec<(String, String)> = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            Ok(files)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let total_files = files_to_check.len();
    eprintln!("[emergency_cleanup] Total files in database: {}", total_files);

    // æ‰¾å‡ºä¸åœ¨åº“æ ¹ç›®å½•ä¸‹çš„æ–‡ä»¶
    let mut invalid_ids = Vec::new();
    let mut valid_count = 0;

    for (id, filepath) in files_to_check {
        // æ£€æŸ¥æ–‡ä»¶è·¯å¾„æ˜¯å¦åœ¨åº“æ ¹ç›®å½•ä¸‹ï¼ˆæ“¯æŒ Windows è·¯å¾„ï¼‰
        let is_valid = same_or_descendant_path(
            std::path::Path::new(&filepath),
            std::path::Path::new(&library_root),
        );
        if is_valid {
            valid_count += 1;
        } else {
            eprintln!("[emergency_cleanup] Invalid file path: {} (id: {})", filepath, id);
            invalid_ids.push(id);
        }
    }

    let invalid_count = invalid_ids.len();
    eprintln!("[emergency_cleanup] Found {} valid files, {} invalid files", valid_count, invalid_count);

    // åˆ é™¤æ— æ•ˆè®°å½•
    if !invalid_ids.is_empty() {
        let deleted = tokio::task::spawn_blocking({
            let db = db.clone();
            let invalid_ids = invalid_ids.clone();
            move || -> Result<usize, String> {
                let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
                let tx = conn.transaction().map_err(|e| e.to_string())?;

                let mut count = 0;
                for id in invalid_ids {
                    // åˆ é™¤å…³è“çš„æ ‡ç­¾
                    tx.execute("DELETE FROM media_tags WHERE media_id = ?", [&id])
                        .map_err(|e| e.to_string())?;
                    // åˆ é™¤å…³è“çš„ AI å…ƒæ•°æ®
                    tx.execute("DELETE FROM ai_metadata WHERE media_id = ?", [&id])
                        .map_err(|e| e.to_string())?;
                    // åˆ é™¤åª’ä½“æ–‡ä»¶è®°å½•
                    tx.execute("DELETE FROM media_files WHERE id = ?", [&id])
                        .map_err(|e| e.to_string())?;
                    count += 1;
                }

                tx.commit().map_err(|e| e.to_string())?;
                Ok(count)
            }
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

        eprintln!("[emergency_cleanup] Deleted {} invalid records", deleted);
    }

    let message = format!(
        "紧急清理完成\n总记录: {}\n有效: {}\n无效已删除: {}",
        total_files, valid_count, invalid_count
    );

    Ok(message)
}

/// èŽ·å–æ•°æ®åº“ä¸­çš„æ‰€æœ‰æ–‡ä»¶è·¯å¾„ï¼ˆç“¨äºŽè¯Šæ–­ï¼‰
#[command]
pub async fn get_all_file_paths(handle: AppHandle) -> Result<Vec<(String, String)>, String> {
    eprintln!("[get_all_file_paths] Getting all file paths from database");

    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, filepath FROM media_files ORDER BY filepath")
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

/// ä¿®å¤ç²˜è´´å¯¼å…¥çš„æ–‡ä»¶åï¼ˆæŠ¥å‘Šæ— æ³•è¿˜åŽŸçš„ nocturne_paste_* æ–‡ä»¶ï¼‰
/// ç“±äºŽå‰ªè´´æ¿å…ƒæ•°æ®å·²ä¸¢å¤±ï¼Œæ— æ³•è‡ªåŠ¨è¿˜åŽŸåŽŸå§‹æ–‡ä»¶åï¼Œæ­¤å‘½ä»¤ç“¨äºŽç»Ÿè®¡å’ŒæŠ¥å‘Š
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

fn repair_missing_dimensions_for_library_root(
    conn: &rusqlite::Connection,
    library_root: &str,
) -> Result<u32, anyhow::Error> {
    let root = library_root.trim_end_matches(['\\', '/']);
    let root_like = format!("{}{}%", root, std::path::MAIN_SEPARATOR);
    let mut stmt = conn.prepare(
        "SELECT id, filepath
         FROM media_files
         WHERE filetype = 'image'
           AND (width IS NULL OR height IS NULL OR width <= 0 OR height <= 0)
           AND filepath LIKE ?1
         ORDER BY imported_at ASC, id ASC"
    )?;

    let items: Vec<(String, String)> = stmt
        .query_map([root_like], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let total = items.len();
    eprintln!("[repair_missing_dimensions] Found {} images with missing dimensions", total);

    if total == 0 {
        return Ok(0);
    }

    let mut repaired = 0u32;
    for (id, filepath) in items {
        match image::image_dimensions(&filepath) {
            Ok((width, height)) => {
                if let Err(e) = conn.execute(
                    "UPDATE media_files SET width = ?, height = ? WHERE id = ?",
                    rusqlite::params![width as i64, height as i64, id],
                ) {
                    eprintln!("[repair_missing_dimensions] Failed to update {}: {}", id, e);
                } else {
                    repaired += 1;
                    eprintln!("[repair_missing_dimensions] Repaired {}: {}x{}", id, width, height);
                }
            }
            Err(e) => {
                eprintln!("[repair_missing_dimensions] Failed to read dimensions for {}: {}", filepath, e);
            }
        }
    }

    eprintln!("[repair_missing_dimensions] Repair completed: {}/{} fixed", repaired, total);
    Ok(repaired)
}

/// 修复缺失的图片尺寸信息（width/height）
#[command]
pub async fn repair_missing_dimensions(handle: AppHandle) -> Result<u32, String> {
    eprintln!("[repair_missing_dimensions] Starting dimension repair...");

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        repair_missing_dimensions_for_library_root(&conn, &library_root).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 更新媒体文件的尺寸信息
#[command]
pub async fn update_media_dimensions(
    handle: AppHandle,
    id: String,
    width: i32,
    height: i32,
) -> Result<(), String> {
    eprintln!("[update_media_dimensions] Updating dimensions for {}: {}x{}", id, width, height);

    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE media_files SET width = ?, height = ? WHERE id = ?",
            rusqlite::params![width as i64, height as i64, id],
        )
        .map_err(|e| format!("Failed to update dimensions: {}", e))?;

        eprintln!("[update_media_dimensions] Dimensions updated successfully for {}", id);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 在系统文件管理器中显示文件（定位到文件所在文件夹并选中该文件）
#[command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    eprintln!("[show_in_folder] Revealing: {}", path);
    let path = validate_existing_local_path(&path)?;

    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            // Windows 文件管理器：/select,<path> 必须紧跟逗号，中间无空格
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed to open Finder: {}", e))?;
        }
        #[cfg(target_os = "linux")]
        {
            let parent = path
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_else(|| path.clone());
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {}", e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn open_path(path: String) -> Result<(), String> {
    let path = validate_existing_local_path(&path)?;
    tokio::task::spawn_blocking(move || {
        open::that(path).map_err(|e| format!("Failed to open path: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
