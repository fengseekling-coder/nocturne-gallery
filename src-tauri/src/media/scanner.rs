use anyhow::{Context, Result};
use chrono::Utc;
use rayon::prelude::*;
use walkdir::WalkDir;

use crate::db::{crud, open_conn};
use crate::media::hash as image_hash;
use crate::models::{FileMetaJSON, MediaFile, ScanResult};

use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Semaphore;

const FAST_DIMENSION_MAX_BYTES: i64 = 2 * 1024 * 1024;

/// 普通图片处理并发限制（JPG, PNG, WebP 等）
///
/// 上限按系统逻辑核数 - 1 自动设定（保留 1 个核给 UI/IPC），下限 4 上限 12。
/// 之前固定 4 在 8+ 核机器上闲着 50%+ CPU；遇到大批量导入（>50 张高分辨率图）时，
/// 用户能看到 fallback 占满屏幕等几十秒——CPU 没饱和但 worker 不够。
pub static LIGHT_ENRICH_SEMAPHORE: Lazy<Arc<Semaphore>> = Lazy::new(|| {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let n = cores.saturating_sub(1).clamp(4, 12);
    Arc::new(Semaphore::new(n))
});
/// 重量级文件处理并发限制（PSD, 视频, TIFF 等）
pub static HEAVY_ENRICH_SEMAPHORE: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));
pub static IMPORT_COPY_SEMAPHORE: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(2)));

const _3D_EXTS: &[&str] = &["obj", "fbx", "glb", "gltf", "blend", "stl"];
fn classify_extension(ext: &str) -> Option<&'static str> {
    crate::media::design_source::classify_extension(ext)
}

// ─────────────────────────────────────────────
//  并行扫描中间结果
// ─────────────────────────────────────────────

/// 并行处理阶段产出的中间结果（包含完整的 MediaFile，DB 写入在串行阶段完成）
struct ProcessedEntry {
    media_file: MediaFile,
    /// 原始文件名（用于日志和 on_new 回调）
    filename: String,
    /// 是否来自 JSON 元数据恢复路径（需要 insert_or_replace 而非 insert_ignore）
    from_json_restore: bool,
    /// 待写入数据库的标签列表（仅 JSON 恢复路径有值）
    tags_to_write: Option<Vec<String>>,
    /// 待写入数据库的 AI 提示词（仅 JSON 恢复路径有值）
    prompt_to_write: Option<String>,
}

/// 递归扫描目录，将新文件写入数据库，返回扫描统计。
/// 不再使用全局 thumbs_dir，缩略图存入各素材所在目录的 .nocturne_meta/
pub fn scan_directory(path: &str, db_path: &str, thumbs_dir: &str) -> Result<ScanResult> {
    scan_directory_inner(path, db_path, thumbs_dir, &mut |_| {})
}

/// 带进度回调的目录扫描版本。
/// on_new(filename) 仅在成功 INSERT 新文件时调用（跳过已有文件）。
/// 外部负责维护 current/total，见 scan_directory_with_progress。
///
/// 实现分三阶段：
///   Phase 1 — 串行：收集文件路径列表（仅文件系统元数据，极快）
///   Phase 2 — 并行：rayon par_iter 每文件独立处理（SHA256、图片解码、pHash、缩略图、颜色）
///   Phase 3 — 串行：DB INSERT（WAL 模式下低竞争，毫秒级）
fn scan_directory_inner(
    path: &str,
    db_path: &str,
    _thumbs_dir: &str,
    on_new: &mut dyn FnMut(&str),
) -> Result<ScanResult> {
    eprintln!("[scanner] Opening DB at: {}", db_path);
    let conn = open_conn(db_path).context("Failed to open DB in scan_directory")?;
    eprintln!("[scanner] DB opened successfully");

    let root_path = std::path::Path::new(path);

    // ── Phase 1: 收集候选文件（串行，只读文件系统元数据）──
    let entries: Vec<walkdir::DirEntry> = WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            if !e.file_type().is_file() {
                return false;
            }
            let p = e.path();
            if p.components().any(|c| c.as_os_str() == ".nocturne") {
                return false;
            }
            if p.components().any(|c| c.as_os_str() == ".nocturne_meta") {
                return false;
            }
            p.extension()
                .and_then(|x| x.to_str())
                .map(|ext| classify_extension(ext).is_some())
                .unwrap_or(false)
        })
        .collect();

    let scanned_count = entries.len() as i64;
    eprintln!(
        "[scanner] Phase 1 complete: {} candidate files",
        scanned_count
    );

    // ── Phase 2: 并行处理（CPU/IO 密集：哈希、解码、缩略图、颜色）──
    let root_str = root_path.to_string_lossy().to_string();

    let processed: Vec<ProcessedEntry> = entries
        .into_par_iter()
        .filter_map(|entry| process_file_entry_parallel(&entry, std::path::Path::new(&root_str)))
        .collect();

    eprintln!(
        "[scanner] Phase 2 complete: {} entries processed",
        processed.len()
    );

    // ── Phase 3: 串行 DB INSERT（WAL 模式，写入轻量）──
    let mut imported_count: i64 = 0;
    let mut skipped_count: i64 = 0;

    for entry in processed {
        if entry.from_json_restore {
            match crud::insert_or_replace_media_file(&conn, &entry.media_file) {
                Ok(()) => {
                    imported_count += 1;
                    on_new(&entry.filename);
                    eprintln!("[scanner] Restored from JSON meta: {}", entry.filename);
                    if let Some(ref tags) = entry.tags_to_write {
                        if !tags.is_empty() {
                            if let Err(e) =
                                crud::update_media_tags(&conn, &entry.media_file.id, tags)
                            {
                                eprintln!(
                                    "[scanner] Failed to write tags for {}: {}",
                                    entry.filename, e
                                );
                            }
                        }
                    }
                    if let Some(ref prompt) = entry.prompt_to_write {
                        if !prompt.is_empty() {
                            if let Err(e) = crud::upsert_ai_metadata(
                                &conn,
                                &entry.media_file.id,
                                prompt,
                                "",
                                "",
                            ) {
                                eprintln!(
                                    "[scanner] Failed to write ai_metadata for {}: {}",
                                    entry.filename, e
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[scanner] Failed to restore from JSON meta for {}: {}",
                        entry.filename, e
                    );
                    skipped_count += 1;
                }
            }
        } else {
            match crud::insert_or_restore_media_file(&conn, &entry.media_file) {
                Ok(true) => {
                    imported_count += 1;
                    on_new(&entry.filename);
                    eprintln!("[scanner] Imported: {}", entry.filename);
                }
                Ok(false) => {
                    skipped_count += 1;
                    eprintln!("[scanner] Skipped (already exists): {}", entry.filename);
                }
                Err(e) => {
                    eprintln!(
                        "[scanner] Failed to insert {}: {}",
                        entry.media_file.filepath, e
                    );
                    skipped_count += 1;
                }
            }
        }
    }

    eprintln!(
        "[scanner] Phase 3 complete: imported={}, skipped={}",
        imported_count, skipped_count
    );

    Ok(ScanResult {
        scanned_count,
        imported_count,
        skipped_count,
    })
}

// ─────────────────────────────────────────────
//  并行处理单个文件（在 rayon 线程池中执行）
// ─────────────────────────────────────────────

/// 对单个文件执行完整的 CPU/IO 处理流程（不含 DB 写入）：
/// - 读取文件字节，一次性计算 SHA256
/// - 图片类型：从内存解码（避免二次读盘），计算 pHash、生成缩略图、提取颜色
/// - 视频类型：调用 ffmpeg 提取帧
/// - 文档/3D 等：仅计算 SHA256
/// - 返回填充完整字段的 ProcessedEntry，Phase 3 直接 INSERT 无需后续 UPDATE
fn process_file_entry_parallel(
    entry: &walkdir::DirEntry,
    root_path: &std::path::Path,
) -> Option<ProcessedEntry> {
    let file_path = entry.path();

    let ext = file_path.extension().and_then(|e| e.to_str())?.to_string();
    let filetype = classify_extension(&ext)?;

    let metadata = std::fs::metadata(file_path).ok()?;
    let file_size = metadata.len() as i64;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let created_at = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified_at);
    let imported_at = Utc::now().timestamp();
    let mime_type = mime_guess::from_path(file_path)
        .first()
        .map(|m| m.to_string());

    let (width, height) = if filetype == "image" && file_size <= FAST_DIMENSION_MAX_BYTES {
        match image::image_dimensions(file_path) {
            Ok((w, h)) => (Some(w as i32), Some(h as i32)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    let filename = file_path.file_name()?.to_str()?.to_string();
    let filepath = file_path.to_string_lossy().to_string();

    let source_folder = file_path
        .strip_prefix(root_path)
        .ok()
        .and_then(|p| p.components().next())
        .and_then(|c| c.as_os_str().to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let id = uuid::Uuid::new_v4().to_string();

    let meta_dir = file_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(".nocturne_meta");

    // ── 快速路径：JSON 元数据已存在且完整 ──
    let loaded_meta =
        load_and_migrate_meta_json(file_path, &meta_dir, &filename).and_then(|meta| {
            let thumb_check = file_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join(&meta.thumbnail);
            let has_thumbnail = !meta.thumbnail.is_empty() && thumb_check.exists();
            let has_colors = meta
                .color_dominant
                .as_deref()
                .is_some_and(|c| !c.is_empty());
            if has_thumbnail && (has_colors || filetype == "video") {
                Some(meta)
            } else {
                None
            }
        });

    if let Some(ref meta) = loaded_meta {
        let thumb_abs = file_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(&meta.thumbnail)
            .to_string_lossy()
            .to_string();
        let media_file = MediaFile {
            id,
            filename: filename.clone(),
            filepath,
            filetype: filetype.to_string(),
            mime_type,
            width,
            height,
            file_size,
            created_at,
            modified_at,
            imported_at,
            thumbnail_path: Some(thumb_abs),
            thumbnail_micro_path: None,
            thumbnail_preview_path: None,
            thumbhash: None,
            color_dominant: meta.color_dominant.clone(),
            is_trashed: false,
            source_folder,
            sha256: meta.sha256.clone(),
            phash: meta.phash,
        };
        return Some(ProcessedEntry {
            media_file,
            filename,
            from_json_restore: true,
            tags_to_write: meta.tags.clone(),
            prompt_to_write: meta.prompt_text.clone(),
        });
    }

    // ── 慢速路径：计算所有元数据 ──
    let ext_lower = ext.to_lowercase();

    let (sha256, phash, thumbnail_path, color_dominant, decoded_width, decoded_height) = if filetype
        == "image"
    {
        if ext_lower == "svg" {
            // SVG：直接复制原文件作为缩略图，不解码
            let sha = image_hash::compute_sha256(&filepath).ok();
            let (thumb, _colors) = generate_thumbnail_and_colors_no_db(
                &id, None, file_path, &meta_dir, &filename, &sha, &None,
            );
            (sha, None, thumb, None, None, None)
        } else {
            // 光栅图：一次读取 → SHA256 + 解码 → pHash + 缩略图 + 颜色
            match std::fs::read(file_path) {
                Ok(bytes) => {
                    let sha = Some(image_hash::compute_sha256_from_bytes(&bytes));
                    match image::load_from_memory(&bytes) {
                        Ok(img) => {
                            let ph = image_hash::compute_phash_from_image(&img)
                                .ok()
                                .map(|p| p as i64);
                            let width = Some(img.width() as i32);
                            let height = Some(img.height() as i32);
                            let (thumb, colors) = generate_thumbnail_and_colors_no_db(
                                &id,
                                Some(&img),
                                file_path,
                                &meta_dir,
                                &filename,
                                &sha,
                                &ph,
                            );
                            (sha, ph, thumb, colors, width, height)
                        }
                        Err(e) => {
                            log::warn!("[scanner] Failed to decode image {}: {}", filename, e);
                            (sha, None, None, None, None, None)
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[scanner] Failed to read file {}: {}", filename, e);
                    (None, None, None, None, None, None)
                }
            }
        }
    } else if filetype == "video" {
        let sha = image_hash::compute_sha256(&filepath).ok();
        let thumb = crate::media::thumbnail::generate_video_thumbnail(&id, &filepath, "").ok();
        (sha, None, thumb, None, None, None)
    } else if filetype == "design" && matches!(ext_lower.as_str(), "psd" | "psb") {
        let sha = image_hash::compute_sha256_streaming(&filepath).ok();
        let thumb = extract_psd_thumbnail_to_file(&id, &filepath, file_path, &meta_dir, &filename);
        (sha, None, thumb, None, None, None)
    } else {
        let sha = image_hash::compute_sha256_streaming(&filepath).ok();
        (sha, None, None, None, None, None)
    };

    let width = width.or(decoded_width);
    let height = height.or(decoded_height);

    let media_file = MediaFile {
        id,
        filename: filename.clone(),
        filepath,
        filetype: filetype.to_string(),
        mime_type,
        width,
        height,
        file_size,
        created_at,
        modified_at,
        imported_at,
        thumbnail_path,
        thumbnail_micro_path: None,
        thumbnail_preview_path: None,
        thumbhash: None,
        color_dominant,
        is_trashed: false,
        source_folder,
        sha256,
        phash,
    };

    Some(ProcessedEntry {
        media_file,
        filename,
        from_json_restore: false,
        tags_to_write: None,
        prompt_to_write: None,
    })
}

/// 从 PSD 文件提取嵌入 JPEG 缩略图并保存到 .nocturne_meta/{filename}_thumb.jpg。
/// 成功返回缩略图绝对路径；失败（无内嵌缩略图）返回 None 并记录 warn 日志。
fn extract_psd_thumbnail_to_file(
    _media_id: &str,
    filepath: &str,
    _file_path: &std::path::Path,
    meta_dir: &std::path::Path,
    filename: &str,
) -> Option<String> {
    if let Err(e) = std::fs::create_dir_all(meta_dir) {
        log::warn!(
            "[scanner] Failed to create .nocturne_meta for {}: {}",
            filename,
            e
        );
        return None;
    }

    match crate::media::thumbnail::extract_psd_thumbnail_jpeg(filepath) {
        Ok(jpeg_bytes) => {
            let thumb_filename = format!("{}_thumb.jpg", filename);
            let thumb_path = meta_dir.join(&thumb_filename);
            if let Err(e) = std::fs::write(&thumb_path, &jpeg_bytes) {
                log::warn!(
                    "[scanner] Failed to write PSD thumbnail for {}: {}",
                    filename,
                    e
                );
                return None;
            }
            // 写 meta JSON（无颜色数据，PSD 嵌入缩略图通常很小不适合采色）
            let meta = crate::models::FileMetaJSON {
                file_name: filename.to_string(),
                sha256: None,
                phash: None,
                color_dominant: None,
                thumbnail: format!(".nocturne_meta/{}", thumb_filename),
                tags: None,
                prompt_text: None,
            };
            let _ = write_meta_json(meta_dir, filename, &meta);
            let abs = thumb_path.to_string_lossy().to_string();
            eprintln!("[scanner] PSD embedded thumbnail extracted: {}", abs);
            Some(abs)
        }
        Err(e) => {
            log::warn!(
                "[scanner] No embedded thumbnail in PSD '{}': {}",
                filename,
                e
            );
            None
        }
    }
}

/// 生成缩略图文件 + 提取颜色，仅做文件系统操作，不写 DB。
/// preloaded_img: 已解码的光栅图（SVG/无法解码时传 None）
/// 返回 (thumbnail_abs_path, color_dominant_json)
fn generate_thumbnail_and_colors_no_db(
    _media_id: &str,
    preloaded_img: Option<&image::DynamicImage>,
    file_path: &std::path::Path,
    meta_dir: &std::path::Path,
    filename: &str,
    sha256: &Option<String>,
    phash: &Option<i64>,
) -> (Option<String>, Option<String>) {
    if let Err(e) = std::fs::create_dir_all(meta_dir) {
        log::warn!(
            "[scanner] Failed to create .nocturne_meta for {}: {}",
            filename,
            e
        );
        return (None, None);
    }

    let ext_lower = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let thumb_filename = format!("{}_thumb.jpg", filename);
    let thumb_path = meta_dir.join(&thumb_filename);

    if ext_lower == "svg" {
        // SVG：复制原文件（保持与 generate_thumbnail_and_meta 一致的命名约定）
        if std::fs::copy(file_path, &thumb_path).is_err() {
            return (None, None);
        }
        let thumb_abs = thumb_path.to_string_lossy().to_string();
        let meta = FileMetaJSON {
            file_name: filename.to_string(),
            sha256: sha256.clone(),
            phash: *phash,
            color_dominant: None,
            thumbnail: format!(".nocturne_meta/{}", thumb_filename),
            tags: None,
            prompt_text: None,
        };
        let _ = write_meta_json(meta_dir, filename, &meta);
        return (Some(thumb_abs), None);
    }

    // 光栅图：需要 preloaded_img
    let img = match preloaded_img {
        Some(i) => i,
        None => return (None, None),
    };

    // 等比缩放到 800px
    let thumb = img.resize(800, 800, image::imageops::FilterType::Lanczos3);

    let Ok(out_file) = std::fs::File::create(&thumb_path) else {
        log::warn!("[scanner] Failed to create thumb file for {}", filename);
        return (None, None);
    };
    let mut buf = std::io::BufWriter::new(out_file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90);
    if thumb.write_with_encoder(encoder).is_err() {
        log::warn!("[scanner] Failed to encode thumb for {}", filename);
        return (None, None);
    }

    let thumb_abs = thumb_path.to_string_lossy().to_string();

    // 提取主色调
    let colors = crate::media::thumbnail::extract_dominant_color_from_image(img);
    let colors_json = serde_json::to_string(&colors).ok();

    // 写入 .nocturne_meta/{filename}.json
    let meta = FileMetaJSON {
        file_name: filename.to_string(),
        sha256: sha256.clone(),
        phash: *phash,
        color_dominant: colors_json.clone(),
        thumbnail: format!(".nocturne_meta/{}", thumb_filename),
        tags: None,
        prompt_text: None,
    };
    let _ = write_meta_json(meta_dir, filename, &meta);

    (Some(thumb_abs), colors_json)
}

/// Phase 1：仅读取 OS 元数据 + 图片宽高（从文件头），立即 INSERT 到 DB。
/// read_path: 当前文件所在路径（源路径，用于读取元数据）
/// record_path: 最终存入 DB 的路径（目标路径，库内路径）
/// 返回新生成的 file id，供 Phase 2 使用。
pub fn scan_single_file_minimal(
    read_path: &str,
    record_path: &str,
    db_path: &str,
    library_root: &str,
) -> Result<String> {
    let conn = open_conn(db_path).context("Failed to open DB in scan_minimal")?;
    let file_read_path = std::path::Path::new(read_path);
    let file_record_path = std::path::Path::new(record_path);
    let root_path = std::path::Path::new(library_root);

    let ext = file_record_path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| anyhow::anyhow!("No extension"))?
        .to_string();
    let filetype = classify_extension(&ext)
        .ok_or_else(|| anyhow::anyhow!("Unsupported file type: {}", ext))?;

    let metadata = std::fs::metadata(file_read_path).context("Failed to read file metadata")?;
    let file_size = metadata.len() as i64;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let created_at = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified_at);
    let imported_at = Utc::now().timestamp();

    let mime_type = mime_guess::from_path(file_record_path)
        .first()
        .map(|m| m.to_string());

    // 读取原图真实宽高，用于 Masonry 按原始比例预留高度
    // 这里必须记录源图尺寸，而不是缩略图尺寸或近似值。
    let (width, height) = if filetype == "image" && file_size <= FAST_DIMENSION_MAX_BYTES {
        image::image_dimensions(file_read_path)
            .map(|(w, h)| (Some(w as i32), Some(h as i32)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    let filename = file_record_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();

    let source_folder = file_record_path
        .strip_prefix(root_path)
        .ok()
        .and_then(|p| p.components().next())
        .and_then(|c| c.as_os_str().to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let media_file = MediaFile {
        id: id.clone(),
        filename: filename.clone(),
        filepath: record_path.to_string(),
        filetype: filetype.to_string(),
        mime_type,
        width,
        height,
        file_size,
        created_at,
        modified_at,
        imported_at,
        thumbnail_path: None,
        thumbnail_micro_path: None,
        thumbnail_preview_path: None,
        thumbhash: None,
        color_dominant: None,
        is_trashed: false,
        source_folder,
        sha256: None,
        phash: None,
    };

    crud::insert_or_restore_media_file(&conn, &media_file)?;

    let parent_dir = file_record_path
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let meta_dir = parent_dir.join(".nocturne_meta");

    if filetype == "image" {
        std::fs::create_dir_all(&meta_dir).context("Failed to create .nocturne_meta")?;
        let micro_dst = meta_dir.join(format!("{}_micro.webp", filename));
        if !micro_dst.exists() {
            if let Ok(img) = image::open(file_read_path) {
                let _ =
                    crate::media::thumbnail::generate_micro_thumbnail_from_image(&img, &micro_dst);
            } else {
                let _ =
                    crate::media::thumbnail::generate_micro_thumbnail(file_read_path, &micro_dst);
            }
        }
        if micro_dst.exists() {
            crate::media::thumbnail::update_multi_tier_thumbnails(
                &conn,
                &id,
                Some(&micro_dst.to_string_lossy()),
                None,
                None,
                None,
            )?;
        }
    } else if filetype == "design" || filetype == "document" {
        let ext_l = ext.to_lowercase();
        if crate::media::design_source::needs_source_preview_for_filetype_and_ext(filetype, &ext_l)
        {
            let read_fp = if file_read_path.is_file() {
                read_path.to_string()
            } else if let Some(p) = crate::media::path_util::resolve_media_file_on_disk(
                record_path,
                Some(library_root),
                Some(&filename),
            ) {
                p.to_string_lossy().to_string()
            } else {
                String::new()
            };
            if !read_fp.is_empty() {
                let _ = crate::media::design_source::ensure_source_preview_thumbnails(
                    &id, &read_fp, &filename, &meta_dir, db_path, filetype, &ext_l,
                );
            }
        }
    }

    Ok(id)
}

/// Phase 1 的事务版本：使用已有连接，用于批量快速入库。
pub fn scan_single_file_minimal_with_conn(
    conn: &rusqlite::Connection,
    read_path: &str,
    record_path: &str,
    library_root: &str,
    generate_micro: bool,
) -> Result<String> {
    let file_read_path = std::path::Path::new(read_path);
    let file_record_path = std::path::Path::new(record_path);
    let root_path = std::path::Path::new(library_root);

    let ext = file_record_path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| anyhow::anyhow!("No extension"))?
        .to_string();
    let filetype = classify_extension(&ext)
        .ok_or_else(|| anyhow::anyhow!("Unsupported file type: {}", ext))?;

    let metadata = std::fs::metadata(file_read_path).context("Failed to read file metadata")?;
    let file_size = metadata.len() as i64;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let created_at = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified_at);
    let imported_at = Utc::now().timestamp();

    let mime_type = mime_guess::from_path(file_record_path)
        .first()
        .map(|m| m.to_string());

    // 读取原图真实宽高，用于 Masonry 按原始比例预留高度
    // 这里必须记录源图尺寸，而不是缩略图尺寸或近似值。
    let (width, height) = if filetype == "image" && file_size <= FAST_DIMENSION_MAX_BYTES {
        image::image_dimensions(file_read_path)
            .map(|(w, h)| (Some(w as i32), Some(h as i32)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    let filename = file_record_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();

    let source_folder = file_record_path
        .strip_prefix(root_path)
        .ok()
        .and_then(|p| p.components().next())
        .and_then(|c| c.as_os_str().to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let media_file = MediaFile {
        id: id.clone(),
        filename: filename.clone(),
        filepath: record_path.to_string(),
        filetype: filetype.to_string(),
        mime_type,
        width,
        height,
        file_size,
        created_at,
        modified_at,
        imported_at,
        thumbnail_path: None,
        thumbnail_micro_path: None,
        thumbnail_preview_path: None,
        thumbhash: None,
        color_dominant: None,
        is_trashed: false,
        source_folder,
        sha256: None,
        phash: None,
    };

    crud::insert_or_restore_media_file(conn, &media_file)?;

    if generate_micro && filetype == "image" {
        let parent_dir = file_record_path
            .parent()
            .unwrap_or(std::path::Path::new("."));
        let meta_dir = parent_dir.join(".nocturne_meta");
        std::fs::create_dir_all(&meta_dir).context("Failed to create .nocturne_meta")?;
        let micro_dst = meta_dir.join(format!("{}_micro.webp", filename));
        if !micro_dst.exists() {
            if let Ok(img) = image::open(file_read_path) {
                let _ =
                    crate::media::thumbnail::generate_micro_thumbnail_from_image(&img, &micro_dst);
            } else {
                let _ =
                    crate::media::thumbnail::generate_micro_thumbnail(file_read_path, &micro_dst);
            }
        }
        if micro_dst.exists() {
            crate::media::thumbnail::update_multi_tier_thumbnails(
                conn,
                &id,
                Some(&micro_dst.to_string_lossy()),
                None,
                None,
                None,
            )?;
        }
    }

    Ok(id)
}

/// 库内文件已复制完成后，确保图片 micro 缩略图存在并写入 DB（批量导入 Phase 1 可能只有源路径或目标尚未落盘）。
pub fn ensure_image_micro_thumbnail_for_file(
    conn: &rusqlite::Connection,
    id: &str,
    filepath: &str,
) -> Result<()> {
    let file_path = std::path::Path::new(filepath);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let filetype = classify_extension(&ext).unwrap_or("document");
    if filetype != "image" || !file_path.is_file() {
        return Ok(());
    }

    let filename = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let meta_dir = file_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(".nocturne_meta");
    std::fs::create_dir_all(&meta_dir).context("Failed to create .nocturne_meta")?;
    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let (width, height) = if file_size <= FAST_DIMENSION_MAX_BYTES {
        image::image_dimensions(file_path)
            .map(|(w, h)| (Some(w as i32), Some(h as i32)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    let mut w = width;
    let mut h = height;
    let micro_dst = meta_dir.join(format!("{}_micro.webp", filename));
    if !micro_dst.exists() {
        if let Ok(img) = image::open(file_path) {
            w = w.or(Some(img.width() as i32));
            h = h.or(Some(img.height() as i32));
            let _ = crate::media::thumbnail::generate_micro_thumbnail_from_image(&img, &micro_dst);
        } else {
            let _ = crate::media::thumbnail::generate_micro_thumbnail(file_path, &micro_dst);
        }
    }
    if w.is_some() && h.is_some() {
        let _ = conn.execute(
            "UPDATE media_files SET width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE id = ?",
            rusqlite::params![w, h, id],
        );
    }
    if micro_dst.exists() {
        crate::media::thumbnail::update_multi_tier_thumbnails(
            conn,
            id,
            Some(&micro_dst.to_string_lossy()),
            None,
            None,
            None,
        )?;
    }
    Ok(())
}

/// Phase 2：对已有 DB 记录补全 SHA256 + pHash + 缩略图 + 颜色。
/// 必须在 Phase 1 的 INSERT 完成后调用（id 已存在于 DB）。
pub fn scan_single_file_enrich(
    id: &str,
    filepath: &str,
    db_path: &str,
    _library_root: &str,
) -> Result<()> {
    let file_path = std::path::Path::new(filepath);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let filetype = classify_extension(&ext).unwrap_or("document");

    let meta_dir = file_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(".nocturne_meta");

    let (sha256, phash) = compute_hashes(filepath, filetype);

    let mut color_dominant: Option<String> = None;

    if filetype == "image" {
        let filename = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let ext_lower = ext.to_lowercase();

        if ext_lower == "svg" {
            // SVG 不解码，走老路径（fs::copy）
            let _ = generate_thumbnail_and_meta(
                id,
                filepath,
                &filename,
                &meta_dir,
                db_path,
                &sha256,
                &phash,
                &mut color_dominant,
            );
        } else {
            // ── 单读管线 ──
            // 之前 enrich 会把同一原图 image::open 三次（thumbnail+micro+thumbhash），
            // 4MB PNG 单次解码 1.5s+，单文件 ~5s 纯解码。改为一次解码全部 artifact 共用同一 DynamicImage，
            // 单文件 ~1.5-2s decode，整批吞吐约 3× 提升。
            let _ = enrich_image_single_read(
                id,
                filepath,
                &filename,
                &meta_dir,
                db_path,
                &sha256,
                phash,
                &mut color_dominant,
            );
        }
    } else if filetype == "video" {
        let filename = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // 视频走原 generate_thumbnail_and_meta（内部委托给 ffmpeg），
        // 然后用 ffmpeg 抽帧得到的 jpg 作为 micro/preview/thumbhash 源（避免再次走视频解码）
        if let Ok(thumb_path) = generate_thumbnail_and_meta(
            id,
            filepath,
            &filename,
            &meta_dir,
            db_path,
            &sha256,
            &phash,
            &mut color_dominant,
        ) {
            let src_path = std::path::Path::new(&thumb_path);
            let meta_dir_path = src_path
                .parent()
                .unwrap_or_else(|| file_path.parent().unwrap_or(std::path::Path::new("")))
                .to_path_buf();
            let micro_filename = format!("{}_micro.webp", filename);
            let micro_dst = meta_dir_path.join(&micro_filename);
            let micro_path_opt =
                crate::media::thumbnail::generate_micro_thumbnail(src_path, &micro_dst)
                    .ok()
                    .and_then(|_| {
                        micro_dst
                            .exists()
                            .then(|| micro_dst.to_string_lossy().to_string())
                    });
            let preview_filename = format!("{}_preview.webp", filename);
            let preview_dst = meta_dir_path.join(&preview_filename);
            let preview_path_opt =
                crate::media::thumbnail::generate_preview_thumbnail(src_path, &preview_dst)
                    .ok()
                    .and_then(|_| {
                        preview_dst
                            .exists()
                            .then(|| preview_dst.to_string_lossy().to_string())
                    });
            let thumbhash_opt = crate::media::thumbnail::generate_thumbhash(src_path)
                .ok()
                .filter(|h| !h.is_empty());
            if let Ok(conn2) = open_conn(db_path) {
                let _ = crate::media::thumbnail::update_multi_tier_thumbnails(
                    &conn2,
                    id,
                    micro_path_opt.as_deref(),
                    Some(&thumb_path),
                    preview_path_opt.as_deref(),
                    thumbhash_opt.as_deref(),
                );
            }
        }
    } else if filetype == "design" || filetype == "document" {
        let ext_l = ext.to_lowercase();
        if crate::media::design_source::needs_source_preview_for_filetype_and_ext(filetype, &ext_l)
        {
            let filename = file_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let disk = crate::media::path_util::resolve_media_file_on_disk(
                filepath,
                Some(_library_root),
                Some(&filename),
            )
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| filepath.to_string());
            let _ = crate::media::design_source::ensure_source_preview_thumbnails(
                id, &disk, &filename, &meta_dir, db_path, filetype, &ext_l,
            );
        }
        if let Ok(conn) = open_conn(db_path) {
            let _ = conn.execute(
                "UPDATE media_files SET sha256 = ? WHERE id = ?",
                rusqlite::params![sha256, id],
            );
        }
        return Ok(());
    }

    // 更新 sha256 + phash
    if let Ok(conn) = open_conn(db_path) {
        let _ = conn.execute(
            "UPDATE media_files SET sha256 = ?, phash = ? WHERE id = ?",
            rusqlite::params![sha256, phash, id],
        );

        // ── 新增：Sidecar 元数据扫描 ──
        let base_path = file_path.with_extension("");

        // 1. 尝试读取 .json
        let json_sidecar = file_path.with_extension(format!("{}.json", ext)); // 或者直接 .json
        let alt_json = base_path.with_extension("json");
        let sidecar_to_check = if json_sidecar.exists() {
            Some(json_sidecar)
        } else if alt_json.exists() {
            Some(alt_json)
        } else {
            None
        };

        if let Some(json_path) = sidecar_to_check {
            if let Ok(content) = std::fs::read_to_string(json_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    let mut tags = Vec::new();
                    if let Some(t_arr) = val.get("tags").and_then(|v| v.as_array()) {
                        for t in t_arr {
                            if let Some(s) = t.as_str() {
                                tags.push(s.to_string());
                            }
                        }
                    }
                    let prompt = val
                        .get("prompt")
                        .and_then(|v| v.as_str())
                        .or_else(|| val.get("description").and_then(|v| v.as_str()));

                    if !tags.is_empty() {
                        let _ = crate::db::crud::add_media_tags(&conn, id, &tags);
                    }
                    if let Some(p) = prompt {
                        let _ = crate::db::crud::update_ai_prompt_text(&conn, id, p);
                    }
                }
            }
        } else {
            // 2. 尝试读取 .txt (作为纯 Prompt)
            let txt_sidecar = base_path.with_extension("txt");
            if txt_sidecar.exists() {
                if let Ok(content) = std::fs::read_to_string(txt_sidecar) {
                    let trimmed = content.trim();
                    if !trimmed.is_empty() && trimmed.len() < 2000 {
                        let _ = crate::db::crud::update_ai_prompt_text(&conn, id, trimmed);
                    }
                }
            }
        }
    }

    Ok(())
}

/// 扫描单个文件并导入数据库（用于外部拖入/粘贴导入）
/// 不再使用全局 thumbs_dir，缩略图存入各素材所在目录的 .nocturne_meta/
/// library_root: 库根目录路径，用于提取 source_folder
pub fn scan_single_file(
    filepath: &str,
    db_path: &str,
    _thumbs_dir: &str,
    library_root: &str,
) -> Result<()> {
    eprintln!("[scanner] scan_single_file: {}", filepath);

    let conn = open_conn(db_path).context("Failed to open DB in scan_single_file")?;

    let file_path = std::path::Path::new(filepath);
    let root_path = std::path::Path::new(library_root);

    // 取扩展名并分类
    let ext = match file_path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_string(),
        None => return Err(anyhow::anyhow!("No extension")),
    };

    let filetype = match classify_extension(&ext) {
        Some(t) => t,
        None => return Err(anyhow::anyhow!("Unsupported file type: {}", ext)),
    };

    // 读取文件系统元数据
    let metadata = std::fs::metadata(file_path).context("Failed to read file metadata")?;

    let file_size = metadata.len() as i64;

    // 修改时间 → Unix 时间戳（秒）
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // 创建时间
    let created_at = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified_at);

    // 当前导入时间
    let imported_at = Utc::now().timestamp();

    // MIME 类型猜测
    let mime_type = mime_guess::from_path(file_path)
        .first()
        .map(|m| m.to_string());

    // 图片宽高
    let (width, height) = if filetype == "image" && file_size <= FAST_DIMENSION_MAX_BYTES {
        match image::image_dimensions(file_path) {
            Ok((w, h)) => (Some(w as i32), Some(h as i32)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let filename_for_log = filename.clone();

    let id = uuid::Uuid::new_v4().to_string();

    // 提取来源文件夹名（相对于库根的第一级子文件夹）
    let source_folder = file_path
        .strip_prefix(root_path)
        .ok()
        .and_then(|p| p.components().next())
        .and_then(|c| c.as_os_str().to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // ── 尝试读取已有的 .nocturne_meta/{filename}.json ──
    let meta_dir = file_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(".nocturne_meta");
    // 读取 JSON（优先新格式，自动迁移旧格式），验证完整性
    let loaded_meta: Option<crate::models::FileMetaJSON> =
        load_and_migrate_meta_json(file_path, &meta_dir, &filename_for_log).and_then(|meta| {
            let thumb_abs_check = file_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join(&meta.thumbnail);
            let has_thumbnail = !meta.thumbnail.is_empty() && thumb_abs_check.exists();
            let has_colors = meta
                .color_dominant
                .as_deref()
                .is_some_and(|c| !c.is_empty());
            // 视频文件不含颜色数据，只要缩略图存在即视为元数据完整
            if has_thumbnail && (has_colors || filetype == "video") {
                eprintln!("[scanner] JSON meta complete for {}", filename_for_log);
                Some(meta)
            } else {
                eprintln!(
                    "[scanner] JSON meta incomplete for {} (thumb_exists={}, has_colors={})",
                    filename_for_log, has_thumbnail, has_colors
                );
                None
            }
        });

    let (sha256, phash, thumbnail_path, color_dominant) = if let Some(ref meta) = loaded_meta {
        let thumb_abs = file_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(&meta.thumbnail)
            .to_string_lossy()
            .to_string();
        (
            meta.sha256.clone(),
            meta.phash,
            Some(thumb_abs),
            meta.color_dominant.clone(),
        )
    } else {
        let (sha, ph) = compute_hashes(filepath, filetype);
        (sha, ph, None, None)
    };

    let mut media_file = MediaFile {
        id: id.clone(),
        filename,
        filepath: filepath.to_string(),
        filetype: filetype.to_string(),
        mime_type,
        width,
        height,
        file_size,
        created_at,
        modified_at,
        imported_at,
        thumbnail_path,
        thumbnail_micro_path: None,
        thumbnail_preview_path: None,
        thumbhash: None,
        color_dominant,
        is_trashed: false,
        source_folder,
        sha256,
        phash,
    };

    if let Some(ref meta) = loaded_meta {
        // ── JSON 恢复路径：INSERT OR REPLACE，跳过缩略图生成 ──
        crud::insert_or_replace_media_file(&conn, &media_file)
            .context("Failed to restore media_file from JSON meta")?;
        eprintln!("[scanner] Restored from JSON meta: {}", filename_for_log);

        // v5.9: JSON 恢复的旧素材可能缺少 micro/preview + thumbhash（旧版未生成），
        // 检查并补生成，避免前端降级到 800px main 档导致翻页卡顿。
        if filetype == "image" || filetype == "video" {
            let src_path = std::path::Path::new(filepath);
            let micro_filename = format!("{}_micro.webp", filename_for_log);
            let micro_dst = meta_dir.join(&micro_filename);
            let micro_path_opt = if micro_dst.exists() {
                Some(micro_dst.to_string_lossy().to_string())
            } else {
                // 优先从 EXIF 提取嵌入缩略图（不解码原图，<1ms）
                crate::media::thumbnail::generate_micro_from_embedded_thumbnail(
                    filepath, &micro_dst,
                )
                .or_else(|| {
                    // 嵌入缩略图不可用→回退到标准 micro 生成
                    crate::media::thumbnail::generate_micro_thumbnail(src_path, &micro_dst)
                        .ok()
                        .and_then(|_| {
                            micro_dst
                                .exists()
                                .then(|| micro_dst.to_string_lossy().to_string())
                        })
                })
            };
            let preview_filename = format!("{}_preview.webp", filename_for_log);
            let preview_dst = meta_dir.join(&preview_filename);
            let preview_path_opt = if preview_dst.exists() {
                Some(preview_dst.to_string_lossy().to_string())
            } else {
                crate::media::thumbnail::generate_preview_thumbnail(src_path, &preview_dst)
                    .ok()
                    .and_then(|_| {
                        preview_dst
                            .exists()
                            .then(|| preview_dst.to_string_lossy().to_string())
                    })
            };

            // thumbhash 始终生成，不依赖 micro 成功与否
            let thumbhash_opt = crate::media::thumbnail::generate_thumbhash(src_path).ok();

            if micro_path_opt.is_some() || preview_path_opt.is_some() || thumbhash_opt.is_some() {
                if let Err(e) = crate::media::thumbnail::update_multi_tier_thumbnails(
                    &conn,
                    &media_file.id,
                    micro_path_opt.as_deref(),
                    None,
                    preview_path_opt.as_deref(),
                    thumbhash_opt.as_deref(),
                ) {
                    log::warn!(
                        "[scanner] Failed to update micro/preview/thumbhash for restored '{}': {}",
                        filename_for_log,
                        e
                    );
                }
            }
        }

        // 写入 tags → tags 表 + media_tags 关联表
        if let Some(ref tags) = meta.tags {
            if !tags.is_empty() {
                if let Err(e) = crud::update_media_tags(&conn, &media_file.id, tags) {
                    eprintln!(
                        "[scanner] Failed to write tags for {}: {}",
                        filename_for_log, e
                    );
                }
            }
        }

        // 写入 prompt_text → ai_metadata 表
        if let Some(ref prompt) = meta.prompt_text {
            if !prompt.is_empty() {
                if let Err(e) = crud::upsert_ai_metadata(&conn, &media_file.id, prompt, "", "") {
                    eprintln!(
                        "[scanner] Failed to write ai_metadata for {}: {}",
                        filename_for_log, e
                    );
                }
            }
        }
    } else {
        // ── 正常导入路径：INSERT OR IGNORE + 完整处理流程 ──
        match crud::insert_or_restore_media_file(&conn, &media_file) {
            Ok(true) => {
                eprintln!(
                    "[scanner] {}: {}",
                    if media_file.is_trashed {
                        "Restored from trash"
                    } else {
                        "Imported"
                    },
                    filename_for_log
                );
                if filetype == "image" || filetype == "video" {
                    eprintln!(
                        "[scanner] Processing {} (full pipeline): {}",
                        filetype, filename_for_log
                    );
                    let id_for_thumb = media_file.id.clone();
                    let filepath_for_thumb = media_file.filepath.clone();
                    match generate_thumbnail_and_meta(
                        &id_for_thumb,
                        &filepath_for_thumb,
                        &filename_for_log,
                        &meta_dir,
                        db_path,
                        &media_file.sha256,
                        &media_file.phash,
                        &mut media_file.color_dominant,
                    ) {
                        Ok(thumb_path) => {
                            eprintln!("[scanner] Full pipeline completed for: {}", thumb_path);

                            // ── v5.8: 生成 micro + thumbhash（同步，不生成 preview） ──
                            let src_path = std::path::Path::new(&filepath_for_thumb);
                            let meta_dir_path = std::path::Path::new(&thumb_path)
                                .parent()
                                .unwrap_or_else(|| {
                                    src_path.parent().unwrap_or(std::path::Path::new(""))
                                })
                                .to_path_buf();

                            // Micro thumbnail
                            let micro_filename = format!("{}_micro.webp", filename_for_log);
                            let micro_dst = meta_dir_path.join(&micro_filename);
                            let micro_path_opt = if let Err(e) =
                                crate::media::thumbnail::generate_micro_thumbnail(
                                    src_path, &micro_dst,
                                ) {
                                log::warn!(
                                    "[scanner] Micro thumbnail generation failed for '{}': {}",
                                    filename_for_log,
                                    e
                                );
                                None
                            } else if micro_dst.exists() {
                                Some(micro_dst.to_string_lossy().to_string())
                            } else {
                                None // 原图 < 256px，跳过
                            };

                            // ThumbHash
                            let thumbhash_opt =
                                match crate::media::thumbnail::generate_thumbhash(src_path) {
                                    Ok(hash) if !hash.is_empty() => Some(hash),
                                    Ok(_) => None,
                                    Err(e) => {
                                        log::warn!(
                                            "[scanner] ThumbHash generation failed for '{}': {}",
                                            filename_for_log,
                                            e
                                        );
                                        None
                                    }
                                };

                            // 更新 DB 多档路径
                            if micro_path_opt.is_some() || thumbhash_opt.is_some() {
                                if let Ok(conn2) = open_conn(db_path) {
                                    let _ = crate::media::thumbnail::update_multi_tier_thumbnails(
                                        &conn2,
                                        &id_for_thumb,
                                        micro_path_opt.as_deref(),
                                        Some(&thumb_path),
                                        None,
                                        thumbhash_opt.as_deref(),
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            // 缩略图生成失败：DB 记录已存在且 thumbnail_path = NULL。
                            // 下次扫描时 load_and_migrate_meta_json 会因 .json 缺失
                            // 再次进入此分支，自动补生成缩略图。文件本身有效，不回滚。
                            log::warn!("[scanner] Thumbnail pipeline failed for '{}': {}. \
                                DB record retained with thumbnail_path=NULL; will retry on next scan.",
                                filename_for_log, e);
                        }
                    }
                }
            }
            Ok(false) => {
                eprintln!(
                    "[scanner] File already exists, skipping: {}",
                    filename_for_log
                );
            }
            Err(e) => {
                return Err(e).context("Failed to insert file");
            }
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────
//  辅助函数
// ─────────────────────────────────────────────

/// 统计目录中有多少新文件（filepath 不在 DB 中的支持格式文件）。
/// 先将 DB 所有路径加载到 HashSet，再做 O(1) 判断，避免每文件一次 SELECT。
fn count_new_files(path: &str, db_path: &str) -> i64 {
    let conn = match open_conn(db_path) {
        Ok(c) => c,
        Err(_) => return 0,
    };
    // 加载现有路径到 HashSet
    let existing: std::collections::HashSet<String> = conn
        .prepare("SELECT filepath FROM media_files")
        .ok()
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let p = e.path();
            !p.components().any(|c| c.as_os_str() == ".nocturne")
                && !p.components().any(|c| c.as_os_str() == ".nocturne_meta")
        })
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|ext| classify_extension(ext).is_some())
                .unwrap_or(false)
        })
        .filter(|e| !existing.contains(&*e.path().to_string_lossy()))
        .count() as i64
}

/// 带进度回调的目录扫描。
/// on_progress(current, total, filename) — 仅对新增文件调用，total 由预扫描确定。
pub fn scan_directory_with_progress<F>(
    path: &str,
    db_path: &str,
    thumbs_dir: &str,
    mut on_progress: F,
) -> Result<ScanResult>
where
    F: FnMut(i64, i64, &str),
{
    let total = count_new_files(path, db_path);
    let mut current = 0i64;
    scan_directory_inner(path, db_path, thumbs_dir, &mut |filename| {
        current += 1;
        on_progress(current, total, filename);
    })
}

/// Scan already-copied import paths into the library with progress callbacks.
/// Used by the current batch import flow after files have been copied into the library root.
/// on_progress(current, total, filename)
pub fn scan_imported_files_with_progress<F>(
    paths: &[String],
    db_path: &str,
    library_root: &str,
    target_category: Option<&str>,
    mut on_progress: F,
) -> Result<ScanResult>
where
    F: FnMut(i64, i64, &str),
{
    let total = paths.len() as i64;
    let mut imported_count = 0i64;
    let mut skipped_count = 0i64;

    // 若指定了分组，扫描完后统一更新 source_folder（scan_single_file 从路径推导，不感知用户指定分组）
    let conn = if target_category.is_some() {
        open_conn(db_path).ok()
    } else {
        None
    };

    for (i, filepath) in paths.iter().enumerate() {
        let filename = std::path::Path::new(filepath)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(filepath.as_str());

        on_progress(i as i64 + 1, total, filename);

        match scan_single_file(filepath, db_path, "", library_root) {
            Ok(()) => {
                imported_count += 1;
                // 覆写 source_folder 为用户指定分组
                if let (Some(ref c), Some(ref conn)) = (target_category, &conn) {
                    if let Err(e) = conn.execute(
                        "UPDATE media_files SET source_folder = ? WHERE filepath = ?",
                        rusqlite::params![c, filepath],
                    ) {
                        log::warn!(
                            "[scanner] Failed to update source_folder for '{}': {}",
                            filename,
                            e
                        );
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[scanner] scan_imported_files: failed for '{}': {}",
                    filename,
                    e
                );
                skipped_count += 1;
            }
        }
    }

    Ok(ScanResult {
        scanned_count: total,
        imported_count,
        skipped_count,
    })
}

/// 计算文件哈希（SHA256 + pHash）
fn compute_hashes(filepath: &str, filetype: &str) -> (Option<String>, Option<i64>) {
    let sha = if filetype == "image" {
        image_hash::compute_sha256(filepath).ok()
    } else {
        image_hash::compute_sha256_streaming(filepath).ok()
    };
    let ph = if filetype == "image" {
        image_hash::compute_phash(filepath).ok().map(|p| p as i64)
    } else {
        None
    };
    eprintln!(
        "[scanner] Hashes computed for: sha256={}, phash={}",
        sha.as_deref().unwrap_or("failed"),
        ph.map_or("not_applicable".to_string(), |p| p.to_string())
    );
    (sha, ph)
}

/// 读取 .nocturne_meta/{filename}.json 元数据文件
fn read_meta_json(path: &std::path::Path) -> Result<FileMetaJSON> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read meta JSON: {}", path.display()))?;
    let meta: FileMetaJSON = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse meta JSON: {}", path.display()))?;
    Ok(meta)
}

/// 加载元数据 JSON：优先新格式（{filename}.json，filename 含扩展名），
/// 若旧格式（{file_stem}.json）存在则自动迁移缩略图并更新 JSON，删除旧文件。
/// 返回原始 FileMetaJSON（不做完整性检查，由调用方判断）。
fn load_and_migrate_meta_json(
    file_path: &std::path::Path,
    meta_dir: &std::path::Path,
    filename: &str,
) -> Option<FileMetaJSON> {
    let new_json_path = meta_dir.join(format!("{}.json", filename));

    // 新格式存在，直接读取
    if new_json_path.exists() {
        return read_meta_json(&new_json_path).ok();
    }

    // 旧格式回退：{file_stem}.json（文件名不含扩展名）
    let file_stem = std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);

    if file_stem == filename {
        return None; // 无扩展名，无旧格式可回退
    }

    let old_json_path = meta_dir.join(format!("{}.json", file_stem));
    if !old_json_path.exists() {
        return None;
    }

    eprintln!(
        "[scanner] Old-format JSON found for {}, migrating...",
        filename
    );

    let mut meta = match read_meta_json(&old_json_path) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[scanner] Failed to read old JSON: {}", e);
            return None;
        }
    };

    // 迁移缩略图：{file_stem}_thumb.jpg → {filename}_thumb.jpg
    let new_thumb_rel = format!(".nocturne_meta/{}_thumb.jpg", filename);
    let old_thumb_abs = file_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(format!(".nocturne_meta/{}_thumb.jpg", file_stem));
    let new_thumb_abs = meta_dir.join(format!("{}_thumb.jpg", filename));

    if old_thumb_abs.exists() && !new_thumb_abs.exists() {
        if let Err(e) = std::fs::copy(&old_thumb_abs, &new_thumb_abs) {
            eprintln!("[scanner] Failed to copy thumbnail during migration: {}", e);
        } else {
            let _ = std::fs::remove_file(&old_thumb_abs);
        }
    } else if old_thumb_abs.exists() {
        let _ = std::fs::remove_file(&old_thumb_abs);
    }

    // 更新 meta 字段为新格式
    meta.file_name = filename.to_string();
    meta.thumbnail = new_thumb_rel;

    // 写入新格式 JSON
    if let Err(e) = write_meta_json(meta_dir, filename, &meta) {
        eprintln!("[scanner] Failed to write migrated JSON: {}", e);
        return None;
    }

    // 删除旧 JSON
    let _ = std::fs::remove_file(&old_json_path);
    eprintln!(
        "[scanner] Migration complete: {} → {}.json",
        file_stem, filename
    );

    Some(meta)
}

/// 写入 .nocturne_meta/{filename}.json 元数据文件
fn write_meta_json(meta_dir: &std::path::Path, filename: &str, meta: &FileMetaJSON) -> Result<()> {
    std::fs::create_dir_all(meta_dir).with_context(|| {
        format!(
            "Failed to create .nocturne_meta directory: {}",
            meta_dir.display()
        )
    })?;
    let json_path = meta_dir.join(format!("{}.json", filename));
    let content = serde_json::to_string_pretty(meta).context("Failed to serialize meta JSON")?;
    std::fs::write(&json_path, content)
        .with_context(|| format!("Failed to write meta JSON: {}", json_path.display()))?;
    Ok(())
}

/// 生成缩略图并写入 .nocturne_meta 元数据 JSON
/// 返回缩略图绝对路径
/// 图片 enrich 单读管线：image::open 一次，所有图像产物（main/micro/thumbhash/colors）共享同一 DynamicImage。
///
/// 对比旧路径（generate_thumbnail_and_meta + 单独 generate_micro_thumbnail + generate_thumbhash 各自 image::open）：
///   - 解码次数：3 次 → 1 次
///   - 主缩略图缩放：Lanczos3 → DynamicImage::thumbnail（更快）
///   - DB 更新：3 次 → 1 次（update_multi_tier_thumbnails 单次写入）
#[allow(clippy::too_many_arguments)]
fn enrich_image_single_read(
    id: &str,
    filepath: &str,
    filename: &str,
    meta_dir: &std::path::Path,
    db_path: &str,
    sha256: &Option<String>,
    phash: Option<i64>,
    color_dominant: &mut Option<String>,
) -> Result<()> {
    std::fs::create_dir_all(meta_dir).with_context(|| {
        format!(
            "Failed to create .nocturne_meta directory: {}",
            meta_dir.display()
        )
    })?;

    // 一次性解码原图
    let img =
        image::open(filepath).with_context(|| format!("Failed to open image: {}", filepath))?;

    // 1) 主缩略图 800px JPEG Q90（用 thumbnail() 而非 Lanczos3 resize，~2× 更快）
    let thumb_filename = format!("{}_thumb.jpg", filename);
    let thumb_path = meta_dir.join(&thumb_filename);
    let main_thumb = img.thumbnail(800, 800);
    let main_path_str = match std::fs::File::create(&thumb_path) {
        Ok(file) => {
            let mut buf = std::io::BufWriter::new(file);
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90);
            if main_thumb.write_with_encoder(encoder).is_ok() {
                Some(thumb_path.to_string_lossy().to_string())
            } else {
                log::warn!("[enrich] Failed to encode main thumbnail for {}", filename);
                None
            }
        }
        Err(e) => {
            log::warn!(
                "[enrich] Failed to create main thumbnail file for {}: {}",
                filename,
                e
            );
            None
        }
    };
    drop(main_thumb);

    // 2) Micro 256px WebP Q70（共享同一 img）
    let micro_filename = format!("{}_micro.webp", filename);
    let micro_dst = meta_dir.join(&micro_filename);
    let micro_path_str =
        crate::media::thumbnail::generate_micro_thumbnail_from_image(&img, &micro_dst)
            .ok()
            .and_then(|_| {
                micro_dst
                    .exists()
                    .then(|| micro_dst.to_string_lossy().to_string())
            });

    // 3) Thumbhash（共享同一 img）
    let thumbhash_str = crate::media::thumbnail::generate_thumbhash_from_image(&img)
        .ok()
        .filter(|h| !h.is_empty());

    // 4) 主色调（共享同一 img）
    if color_dominant.is_none() || color_dominant.as_deref().unwrap_or_default().is_empty() {
        let colors = crate::media::thumbnail::extract_dominant_color_from_image(&img);
        *color_dominant = serde_json::to_string(&colors).ok();
    }

    // 5) Preview 2048px WebP（共享同一 img）
    let preview_filename = format!("{}_preview.webp", filename);
    let preview_dst = meta_dir.join(&preview_filename);
    let preview_path_str =
        crate::media::thumbnail::generate_preview_thumbnail_from_image(&img, &preview_dst)
            .ok()
            .and_then(|_| {
                preview_dst
                    .exists()
                    .then(|| preview_dst.to_string_lossy().to_string())
            });

    // 6) 主色调（共享同一 img）
    if color_dominant.is_none() || color_dominant.as_deref().unwrap_or_default().is_empty() {
        let colors = crate::media::thumbnail::extract_dominant_color_from_image(&img);
        *color_dominant = serde_json::to_string(&colors).ok();
    }

    // 7) DB 一次性写入所有缩略图档位
    if let Ok(conn) = open_conn(db_path) {
        let _ = crate::media::thumbnail::update_multi_tier_thumbnails(
            &conn,
            id,
            micro_path_str.as_deref(),
            main_path_str.as_deref(),
            preview_path_str.as_deref(),
            thumbhash_str.as_deref(),
        );
        if let Some(ref cd) = color_dominant {
            let _ = conn.execute(
                "UPDATE media_files SET color_dominant = ? WHERE id = ?",
                rusqlite::params![cd, id],
            );
        }
    }

    // 8) 写 .nocturne_meta/{filename}.json（仅当主缩略图成功时）
    if main_path_str.is_some() {
        let meta = FileMetaJSON {
            file_name: filename.to_string(),
            sha256: sha256.clone(),
            phash,
            color_dominant: color_dominant.clone(),
            thumbnail: format!(".nocturne_meta/{}", thumb_filename),
            tags: None,
            prompt_text: None,
        };
        let _ = write_meta_json(meta_dir, filename, &meta);
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn generate_thumbnail_and_meta(
    media_id: &str,
    filepath: &str,
    filename: &str,
    meta_dir: &std::path::Path,
    db_path: &str,
    sha256: &Option<String>,
    phash: &Option<i64>,
    color_dominant: &mut Option<String>,
) -> Result<String> {
    // 确保 .nocturne_meta 目录存在
    std::fs::create_dir_all(meta_dir).with_context(|| {
        format!(
            "Failed to create .nocturne_meta directory: {}",
            meta_dir.display()
        )
    })?;

    // 缩略图文件名：{filename}_thumb.jpg
    let thumb_filename = format!("{}_thumb.jpg", filename);
    let thumb_path = meta_dir.join(&thumb_filename);

    // 生成缩略图
    let ext = std::path::Path::new(filepath)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    if matches!(ext.as_deref(), Some("svg")) {
        // SVG 直接复制
        std::fs::copy(filepath, &thumb_path)
            .with_context(|| "Failed to copy SVG thumbnail".to_string())?;
    } else if matches!(
        ext.as_deref(),
        Some("mp4") | Some("mov") | Some("avi") | Some("mkv") | Some("webm")
    ) {
        // 视频：用 ffmpeg 提取第一帧（generate_video_thumbnail 内部写 DB + JSON，直接返回）
        return crate::media::thumbnail::generate_video_thumbnail(media_id, filepath, db_path);
    } else {
        // 使用 image crate 生成缩略图
        let img =
            image::open(filepath).with_context(|| format!("Failed to open image: {}", filepath))?;
        let thumb = img.resize(800, 800, image::imageops::FilterType::Lanczos3);

        let output_file = std::fs::File::create(&thumb_path).with_context(|| {
            format!("Failed to create thumbnail file: {}", thumb_path.display())
        })?;
        let mut buf_writer = std::io::BufWriter::new(output_file);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf_writer, 90);
        thumb
            .write_with_encoder(encoder)
            .with_context(|| format!("Failed to save thumbnail: {}", thumb_path.display()))?;

        // 提取主色调（如果未从已有 JSON 中读取到）
        if color_dominant.is_none() || color_dominant.as_deref().unwrap_or_default().is_empty() {
            let colors = crate::media::thumbnail::extract_dominant_color_from_image(&img);
            let colors_json = serde_json::to_string(&colors)
                .with_context(|| "Failed to serialize extracted colors")?;
            eprintln!("[scanner] Extracted dominant color for: {}", filename);

            // 写入数据库
            if !db_path.is_empty() {
                if let Ok(conn) = open_conn(db_path) {
                    let _ = conn.execute(
                        "UPDATE media_files SET color_dominant = ? WHERE id = ?",
                        rusqlite::params![colors_json, media_id],
                    );
                }
            }

            // 用于写入 JSON
            *color_dominant = Some(colors_json);
        }
    }

    let thumb_abs = thumb_path.to_string_lossy().to_string();

    // 更新数据库中的缩略图路径
    if !db_path.is_empty() {
        if let Ok(conn) = open_conn(db_path) {
            let _ = crud::update_thumbnail_path(&conn, media_id, &thumb_abs);
        }
    }

    // 写入 .nocturne_meta/{filename}.json
    let meta = FileMetaJSON {
        file_name: filename.to_string(),
        sha256: sha256.clone(),
        phash: *phash,
        color_dominant: color_dominant.clone(),
        thumbnail: format!(".nocturne_meta/{}", thumb_filename),
        tags: None,
        prompt_text: None,
    };
    write_meta_json(meta_dir, filename, &meta)?;

    eprintln!("[scanner] Generated thumbnail and meta for: {}", filename);
    Ok(thumb_abs)
}

/// 扫描单个文件并使用已有连接导入数据库（用于事务内调用）
pub fn scan_single_file_with_conn(
    conn: &rusqlite::Connection,
    filepath: &str,
    _thumbs_dir: &str,
    library_root: &str,
) -> Result<()> {
    eprintln!("[scanner] scan_single_file_with_conn: {}", filepath);

    let file_path = std::path::Path::new(filepath);
    let root_path = std::path::Path::new(library_root);

    // 取扩展名并分类
    let ext = match file_path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_string(),
        None => return Err(anyhow::anyhow!("No extension")),
    };

    let filetype = match classify_extension(&ext) {
        Some(t) => t,
        None => return Err(anyhow::anyhow!("Unsupported file type: {}", ext)),
    };

    // 读取文件系统元数据
    let metadata = std::fs::metadata(file_path).context("Failed to read file metadata")?;

    let file_size = metadata.len() as i64;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let created_at = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified_at);
    let imported_at = Utc::now().timestamp();

    let mime_type = mime_guess::from_path(file_path)
        .first()
        .map(|m| m.to_string());

    let (width, height) = if filetype == "image" && file_size <= FAST_DIMENSION_MAX_BYTES {
        match image::image_dimensions(file_path) {
            Ok((w, h)) => (Some(w as i32), Some(h as i32)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let filename_for_log = filename.clone();

    // 提取来源文件夹名
    let source_folder = file_path
        .strip_prefix(root_path)
        .ok()
        .and_then(|p| p.components().next())
        .and_then(|c| c.as_os_str().to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // ── 尝试读取已有的 .nocturne_meta/{filename}.json ──
    let meta_dir = file_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(".nocturne_meta");
    // 读取 JSON（优先新格式，自动迁移旧格式），验证完整性
    let loaded_meta: Option<crate::models::FileMetaJSON> =
        load_and_migrate_meta_json(file_path, &meta_dir, &filename_for_log).and_then(|meta| {
            let thumb_abs_check = file_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join(&meta.thumbnail);
            let has_thumbnail = !meta.thumbnail.is_empty() && thumb_abs_check.exists();
            let has_colors = meta
                .color_dominant
                .as_deref()
                .is_some_and(|c| !c.is_empty());
            // 视频文件不含颜色数据，只要缩略图存在即视为元数据完整
            if has_thumbnail && (has_colors || filetype == "video") {
                eprintln!("[scanner] JSON meta complete for {}", filename_for_log);
                Some(meta)
            } else {
                eprintln!(
                    "[scanner] JSON meta incomplete for {} (thumb_exists={}, has_colors={})",
                    filename_for_log, has_thumbnail, has_colors
                );
                None
            }
        });

    let (sha256, phash, thumbnail_path, color_dominant) = if let Some(ref meta) = loaded_meta {
        let thumb_abs = file_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(&meta.thumbnail)
            .to_string_lossy()
            .to_string();
        (
            meta.sha256.clone(),
            meta.phash,
            Some(thumb_abs),
            meta.color_dominant.clone(),
        )
    } else {
        let (sha, ph) = compute_hashes(filepath, filetype);
        (sha, ph, None, None)
    };

    let id = uuid::Uuid::new_v4().to_string();

    let mut media_file = MediaFile {
        id: id.clone(),
        filename,
        filepath: filepath.to_string(),
        filetype: filetype.to_string(),
        mime_type,
        width,
        height,
        file_size,
        created_at,
        modified_at,
        imported_at,
        thumbnail_path,
        thumbnail_micro_path: None,
        thumbnail_preview_path: None,
        thumbhash: None,
        color_dominant,
        is_trashed: false,
        source_folder,
        sha256,
        phash,
    };

    if let Some(ref meta) = loaded_meta {
        // ── JSON 恢复路径：INSERT OR REPLACE，跳过缩略图生成 ──
        crud::insert_or_replace_media_file(conn, &media_file)
            .context("Failed to restore media_file from JSON meta")?;
        eprintln!("[scanner] Restored from JSON meta: {}", filename_for_log);

        // 写入 tags → tags 表 + media_tags 关联表
        if let Some(ref tags) = meta.tags {
            if !tags.is_empty() {
                if let Err(e) = crud::update_media_tags(conn, &media_file.id, tags) {
                    eprintln!(
                        "[scanner] Failed to write tags for {}: {}",
                        filename_for_log, e
                    );
                }
            }
        }

        // 写入 prompt_text → ai_metadata 表
        if let Some(ref prompt) = meta.prompt_text {
            if !prompt.is_empty() {
                if let Err(e) = crud::upsert_ai_metadata(conn, &media_file.id, prompt, "", "") {
                    eprintln!(
                        "[scanner] Failed to write ai_metadata for {}: {}",
                        filename_for_log, e
                    );
                }
            }
        }
    } else {
        // ── 正常导入路径：INSERT OR IGNORE + 完整处理流程 ──
        match crud::insert_or_restore_media_file(conn, &media_file) {
            Ok(true) => {
                eprintln!(
                    "[scanner] {}: {}",
                    if media_file.is_trashed {
                        "Restored from trash"
                    } else {
                        "Imported"
                    },
                    filename_for_log
                );
                if filetype == "image" || filetype == "video" {
                    eprintln!(
                        "[scanner] Processing {} (full pipeline): {}",
                        filetype, filename_for_log
                    );
                    let id_for_thumb = media_file.id.clone();
                    let filepath_for_thumb = media_file.filepath.clone();
                    match generate_thumbnail_and_meta(
                        &id_for_thumb,
                        &filepath_for_thumb,
                        &filename_for_log,
                        &meta_dir,
                        "", // 使用已有连接时不更新 DB 缩略图路径
                        &media_file.sha256,
                        &media_file.phash,
                        &mut media_file.color_dominant,
                    ) {
                        Ok(thumb_path) => {
                            eprintln!("[scanner] Full pipeline completed for: {}", thumb_path);

                            // ── v5.8: 生成 micro + thumbhash（同步，不生成 preview） ──
                            let src_path = std::path::Path::new(&filepath_for_thumb);
                            let meta_dir_path = std::path::Path::new(&thumb_path)
                                .parent()
                                .unwrap_or_else(|| {
                                    src_path.parent().unwrap_or(std::path::Path::new(""))
                                })
                                .to_path_buf();

                            // Micro thumbnail
                            let micro_filename = format!("{}_micro.webp", filename_for_log);
                            let micro_dst = meta_dir_path.join(&micro_filename);
                            let micro_path_opt = if let Err(e) =
                                crate::media::thumbnail::generate_micro_thumbnail(
                                    src_path, &micro_dst,
                                ) {
                                log::warn!(
                                    "[scanner] Micro thumbnail generation failed for '{}': {}",
                                    filename_for_log,
                                    e
                                );
                                None
                            } else if micro_dst.exists() {
                                Some(micro_dst.to_string_lossy().to_string())
                            } else {
                                None // 原图 < 256px，跳过
                            };

                            // ThumbHash
                            let thumbhash_opt =
                                match crate::media::thumbnail::generate_thumbhash(src_path) {
                                    Ok(hash) if !hash.is_empty() => Some(hash),
                                    Ok(_) => None,
                                    Err(e) => {
                                        log::warn!(
                                            "[scanner] ThumbHash generation failed for '{}': {}",
                                            filename_for_log,
                                            e
                                        );
                                        None
                                    }
                                };

                            // 更新 DB 多档路径（conn 已存在，直接用 crud）
                            if micro_path_opt.is_some() || thumbhash_opt.is_some() {
                                let _ = crate::media::thumbnail::update_multi_tier_thumbnails(
                                    conn,
                                    &id_for_thumb,
                                    micro_path_opt.as_deref(),
                                    Some(&thumb_path),
                                    None,
                                    thumbhash_opt.as_deref(),
                                );
                            }
                        }
                        Err(e) => {
                            // 缩略图生成失败：DB 记录已存在且 thumbnail_path = NULL。
                            // 下次扫描时 load_and_migrate_meta_json 会因 .json 缺失
                            // 再次进入此分支，自动补生成缩略图。文件本身有效，不回滚。
                            log::warn!("[scanner] Thumbnail pipeline failed for '{}': {}. \
                                DB record retained with thumbnail_path=NULL; will retry on next scan.",
                                filename_for_log, e);
                        }
                    }
                }
            }
            Ok(false) => {
                eprintln!(
                    "[scanner] File already exists, skipping: {}",
                    filename_for_log
                );
            }
            Err(e) => {
                return Err(e).context("Failed to insert file");
            }
        }
    }

    Ok(())
}
