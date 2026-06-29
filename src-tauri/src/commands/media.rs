//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
#[cfg(target_os = "windows")] use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY};
#[cfg(target_os = "windows")] use windows::Win32::Graphics::Gdi::{BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits, GetObjectW, HBITMAP};
#[cfg(target_os = "windows")] use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
#[cfg(target_os = "windows")] use windows::core::{HRESULT, HSTRING};
#[cfg(target_os = "windows")] use std::ffi::c_void;
use crate::commands::library::{read_pending_import_preview_data_url, resolve_under_library_root};
use crate::commands::{canonical_regular_file_path, db_path, library_root, validate_existing_local_path};
use crate::db::open_conn;
use crate::media::{hash as image_hash, scanner};
use crate::models::{
    DuplicateCheckResult, DuplicatePlacement, FileInfo, GroupItemCount, MediaCursor, MediaDetail, MediaFilter, MediaPage, NavItemCount, ScanResult,
};
use crate::AppState;
use base64::Engine;
use image::ImageEncoder;
use rusqlite::OptionalExtension;
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, Manager};

/// Check if the first bytes of a file match known image format magic numbers.
fn has_supported_image_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\xff\xd8\xff") // JPEG
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n") // PNG
        || bytes.starts_with(b"GIF87a") // GIF87a
        || bytes.starts_with(b"GIF89a") // GIF89a
        || bytes.starts_with(b"RIFF") // WEBP
        || bytes.starts_with(b"\x00\x00\x01\x00") // ICO
        || bytes.starts_with(b"BM") // BMP
        || bytes.starts_with(b"II*\x00") // TIFF le
        || bytes.starts_with(b"MM\x00*") // TIFF be
}

pub fn read_supported_ai_input_file_base64(raw_path: &str, label: &str) -> Result<String, String> {
    const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
    const MAX_PDF_BYTES: u64 = 8 * 1024 * 1024;

    let path = canonical_regular_file_path(raw_path, label)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("无法读取{}信息：{} ({})", label, path.display(), e))?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "{}超过 {}MB，无法读取",
            label,
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }

    let bytes = std::fs::read(&path)
        .map_err(|e| format!("读取{}失败：{} ({})", label, path.display(), e))?;
    let is_image = has_supported_image_signature(&bytes);
    let is_pdf = bytes.starts_with(b"%PDF-");
    if !is_image && !is_pdf {
        return Err(format!("{}不是受支持的图片或 PDF 文件", label));
    }
    if is_pdf && metadata.len() > MAX_PDF_BYTES {
        return Err(format!(
            "{}超过 {}MB，无法读取",
            label,
            MAX_PDF_BYTES / 1024 / 1024
        ));
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[command]
pub async fn scan_directory(handle: AppHandle, path: String) -> Result<ScanResult, String> {
    eprintln!("[scan_directory] Starting scan for path: {}", path);

    // è·¯å¾„å®ˆå«ï¼šèŽ·å–åº“æ ¹ç›®å½•å¹¶éªŒè¯
    let library_root = library_root(&handle)?;
    eprintln!("[scan_directory] Library root: {}", library_root);

    // 路径守卫（A 类）：扫描路径必须等于库根或位于库根之内（统一入口，已规范化）。
    let resolved = resolve_under_library_root(&path, &library_root).map_err(|e| {
        eprintln!("[scan_directory] Security check failed: {}", e);
        e
    })?;
    let path = resolved.to_string_lossy().to_string();
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
            let _ = h.emit(
                "scan_progress",
                serde_json::json!({
                    "current": current,
                    "total": total,
                    "filename": filename,
                }),
            );
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
            log::info!(
                "[scan_directory] Scan completed: scanned={}, imported={}, skipped={}",
                r.scanned_count,
                r.imported_count,
                r.skipped_count
            );
            let _ = handle.emit(
                "scan_complete",
                serde_json::json!({ "total": r.imported_count }),
            );
        }
        Err(e) => log::error!("[scan_directory] Final error: {}", e),
    }

    result
}

/// 分页查询媒体文件列表。
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

    log::debug!(
        "[get_media_files] querying page={} perPage={} cursor={:?}",
        safe_page,
        safe_per_page,
        cursor.as_ref().map(|c| &c.id)
    );

    let library_root = library_root(&handle).unwrap_or_default();
    log::debug!("[get_media_files] library_root={}", library_root);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let mut filter_with_root = filter.clone();
        filter_with_root.library_root_path = Some(library_root);
        let (items, total, next_cursor) = crate::db::crud::query_media_files(
            &conn,
            safe_page,
            safe_per_page,
            &filter_with_root,
            cursor.as_ref(),
            safe_page > 1,
        )
        .map_err(|e| e.to_string())?;
        log::debug!(
            "[get_media_files] result count={} next_cursor={}",
            items.len(),
            next_cursor.is_some()
        );
        Ok(MediaPage {
            items,
            total,
            page,
            per_page: safe_per_page,
            next_cursor,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取单个媒体文件详情（含标签、AI 元数据）。
#[command]
pub async fn get_media_detail(
    handle: AppHandle,
    id: String,
) -> Result<Option<MediaDetail>, String> {
    let library_root = library_root(&handle).unwrap_or_default();
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let root_opt = if library_root.trim().is_empty() {
            None
        } else {
            Some(library_root.as_str())
        };
        crate::db::crud::get_media_detail(&conn, &id, root_opt).map_err(|e| e.to_string())
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
    let library_root = library_root(&handle).unwrap_or_default();
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let mut filter_with_root = filter;
        filter_with_root.library_root_path = Some(library_root);
        crate::db::crud::get_group_item_counts(&conn, &filter_with_root, &group_names)
            .map_err(|e| e.to_string())
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
        crate::db::crud::get_nav_item_counts(&conn, &nav_ids, library_root.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub fn encode_rgba_preview_data_url(width: u32, height: u32, rgba: &[u8]) -> Result<String, String> {
    let mut webp_data = Vec::new();
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut webp_data);
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("Failed to encode preview WebP: {}", e))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(webp_data);
    Ok(format!("data:image/webp;base64,{}", encoded))
}

/// Convert a Windows HBITMAP to a base64 data URL (Windows only).
#[cfg(target_os = "windows")]
pub fn hbitmap_to_data_url(hbitmap: HBITMAP) -> Result<String, String> {
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

/// Cross-platform wrapper: delegates to the platform-specific implementation.
#[cfg(not(target_os = "windows"))]
pub fn shell_thumbnail_preview_data_url(
    path: &str,
    size: u32,
    library_root: &str,
    filename_hint: Option<&str>,
) -> Result<Option<String>, String> {
    shell_thumbnail_preview_data_url_v1(path, size, library_root, filename_hint)
}

#[cfg(target_os = "windows")]
pub fn shell_thumbnail_preview_data_url(
    path: &str,
    size: u32,
    _library_root: &str,
    _filename_hint: Option<&str>,
) -> Result<Option<String>, String> {
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let initialized_com = if hr.is_ok() {
        true
    } else if hr == HRESULT(0x80010106u32 as i32) {
        false
    } else {
        return Err(format!(
            "Failed to initialize COM for shell thumbnail: {}",
            hr
        ));
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

pub fn shell_thumbnail_preview_data_url_v1(
    path: &str,
    size: u32,
    library_root: &str,
    filename_hint: Option<&str>,
) -> Result<Option<String>, String> {
    let preview_size = size.clamp(96, 1024);
    let root_opt = library_root.trim();
    let root = if root_opt.is_empty() {
        None
    } else {
        Some(root_opt)
    };
    match crate::media::os_preview::fetch_os_preview_bytes_with_hints(
        path,
        root,
        filename_hint,
        preview_size,
    ) {
        Some(bytes) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(Some(format!("data:image/png;base64,{}", encoded)))
        }
        None => Ok(None),
    }
}

/// 跨平台占位:Windows 上由 `shell_thumbnail_preview_data_url` 提供真实实现,
/// macOS/Linux 上保留空函数以维持 lib.rs 注册的命令签名稳定。
#[allow(dead_code)]
pub fn shell_thumbnail_preview_data_url_v2(
    _path: &str,
    _size: u32,
    _library_root: &str,
    _filename_hint: Option<&str>,
) -> Result<Option<String>, String> {
    Ok(None)
}

pub fn design_preview_already_complete(file: &crate::models::MediaFile) -> bool {
    crate::media::design_source::has_modern_webp_tiers(
        file.thumbnail_micro_path.as_deref(),
        file.thumbnail_path.as_deref(),
        file.thumbnail_preview_path.as_deref(),
    )
}

/// 插入或更新 AI 元数据。
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
        crate::db::crud::upsert_ai_metadata(&tx, &id, &prompt, &model, &platform)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 更新媒体文件的标签（全量替换）。
#[command]
pub async fn update_tags(handle: AppHandle, id: String, tags: Vec<String>) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;

        // 使用事务保证原子性
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crate::db::crud::update_media_tags(&tx, &id, &tags).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        log::info!(
            "[update_tags] Database updated, now syncing JSON for {}",
            id
        );

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
            let meta_dir = file_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join(".nocturne_meta");

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
                    if let Ok(mut meta) =
                        serde_json::from_str::<crate::models::FileMetaJSON>(&content)
                    {
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

/// 检查文件是否重复（SHA256 精确匹配 + pHash 感知哈希）
/// 汉明距离阈值 ≤ 3（极严格）
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
        if let Some(existing) = crate::db::crud::find_by_sha256(&conn, &sha256).map_err(|e| e.to_string())? {
            let (source_folder, category_name) =
                crate::db::crud::get_media_duplicate_placement(&conn, &existing.id)
                    .map_err(|e| e.to_string())?;
            let pending_preview = read_pending_import_preview_data_url(&file_path).ok();
            log::debug!(
                "[check_duplicate] Exact duplicate found: {}",
                existing.filename
            );
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
            let matches =
                crate::db::crud::find_by_phash_threshold(&conn, phash, 3).map_err(|e| e.to_string())?;

            if let Some(existing) = matches.into_iter().next() {
                let (source_folder, category_name) =
                    crate::db::crud::get_media_duplicate_placement(&conn, &existing.id)
                        .map_err(|e| e.to_string())?;
                let similarity = if let Some(existing_phash) = existing.phash {
                    image_hash::similarity_score(phash, existing_phash as u64) / 100.0
                } else {
                    0.0
                };
                let pending_preview = read_pending_import_preview_data_url(&file_path).ok();
                log::debug!(
                    "[check_duplicate] Similar duplicate found: {} (similarity: {:.2})",
                    existing.filename,
                    similarity
                );
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

/// 获取文件基本信息（大小）
#[command]
pub async fn get_file_info(path: String) -> Result<FileInfo, String> {
    // 路径守卫（B 类）：可能读取外部附件，做存在性 + 规范化校验（拒绝 `..` 穿越），不强制库内。
    let path = validate_existing_local_path(&path)?;
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;

    Ok(FileInfo {
        size: metadata.len() as i64,
        is_dir: metadata.is_dir(),
    })
}

/// 替换已有文件（删除旧文件，导入新文件）
#[command]
pub async fn replace_file(
    handle: AppHandle,
    source_path: String,
    target_id: String,
) -> Result<(), String> {
    eprintln!(
        "[replace_file] Replacing {} with {}",
        target_id, source_path
    );

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;
    // 路径守卫（B 类）：替换用的源文件可来自库外（合法导入），做存在性 + 规范化校验。
    let source_path = validate_existing_local_path(&source_path)?
        .to_string_lossy()
        .to_string();
    let thumbs_dir = std::path::Path::new(&library_root)
        .join(".nocturne")
        .join("thumbs")
        .to_string_lossy()
        .to_string();

    // èŽ·å–ç›®æ ‡æ–‡ä»¶ä¿¡æ¯
    let library_root_for_detail = library_root.clone();
    let (target_filepath, target_filename) = tokio::task::spawn_blocking({
        let db = db.clone();
        let target_id = target_id.clone();
        let root = library_root_for_detail;
        move || {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let root_opt = if root.trim().is_empty() {
                None
            } else {
                Some(root.as_str())
            };
            let detail = crate::db::crud::get_media_detail(&conn, &target_id, root_opt)
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
    // 路径守卫（A 类）：被替换的目标文件必须落在库根之内。
    let dest_path = resolve_under_library_root(&dest_path.to_string_lossy(), &library_root)?;
    let tmp_path = target_dir.join(format!("{}.tmp", target_filename));

    if let Err(e) = std::fs::copy(&source_path, &tmp_path) {
        // 复制失败：清理可能已部分写入的 .tmp，旧文件完整保留
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to copy new file to tmp: {}", e));
    }
    eprintln!(
        "[replace_file] Copied new file to tmp: {}",
        tmp_path.display()
    );

    // 2. 原子性重命名 .tmp 为最终路径（在大多数平台上原子性覆盖旧文件）
    if let Err(e) = std::fs::rename(&tmp_path, &dest_path) {
        // rename 失败：旧文件仍完整，清理 .tmp
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to rename tmp file to destination: {}", e));
    }
    eprintln!(
        "[replace_file] Renamed tmp to final path: {}",
        dest_path.display()
    );
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
        crate::db::crud::delete_media_file(&tx, &target_id_tx).map_err(|e| e.to_string())?;
        eprintln!("[replace_file] Deleted old DB record: {}", target_id_tx);

        // 导入新文件（同一事务内）
        scanner::scan_single_file_with_conn(
            &tx,
            &dest_path_str_tx,
            &thumbs_dir_tx,
            &library_root_clone,
        )
        .map_err(|e| e.to_string())?;
        eprintln!(
            "[replace_file] Imported new file in transaction: {}",
            dest_path_str_tx
        );

        tx.commit().map_err(|e| e.to_string())?;
        eprintln!("[replace_file] Transaction committed");
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // 文件系统与数据库均已一致：新文件就位，旧记录已替换为新记录。
    Ok(())
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
         ORDER BY imported_at ASC, id ASC",
    )?;

    let items: Vec<(String, String)> = stmt
        .query_map([root_like], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let total = items.len();
    eprintln!(
        "[repair_missing_dimensions] Found {} images with missing dimensions",
        total
    );

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
                    eprintln!(
                        "[repair_missing_dimensions] Repaired {}: {}x{}",
                        id, width, height
                    );
                }
            }
            Err(e) => {
                eprintln!(
                    "[repair_missing_dimensions] Failed to read dimensions for {}: {}",
                    filepath, e
                );
            }
        }
    }

    eprintln!(
        "[repair_missing_dimensions] Repair completed: {}/{} fixed",
        repaired, total
    );
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

/// 从库内原图读取宽高（仅 header，供 Masonry 布局；不依赖 micro 缩略图像素）
#[command]
pub async fn probe_image_dimensions(
    handle: AppHandle,
    id: String,
) -> Result<Option<(i32, i32)>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT filepath, filetype FROM media_files WHERE id = ?",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((filepath, filetype)) = row else {
            return Ok(None);
        };
        if filetype != "image" {
            return Ok(None);
        }
        let path = std::path::Path::new(&filepath);
        if !path.is_file() {
            return Ok(None);
        }
        match image::image_dimensions(path) {
            Ok((w, h)) if w > 0 && h > 0 => Ok(Some((w as i32, h as i32))),
            _ => Ok(None),
        }
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
    eprintln!(
        "[update_media_dimensions] Updating dimensions for {}: {}x{}",
        id, width, height
    );

    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE media_files SET width = ?, height = ? WHERE id = ?",
            rusqlite::params![width as i64, height as i64, id],
        )
        .map_err(|e| format!("Failed to update dimensions: {}", e))?;

        eprintln!(
            "[update_media_dimensions] Dimensions updated successfully for {}",
            id
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
