//! 专业设计/文档源文件：统一扩展名与缩略图策略（PSD 内嵌 + 全类型 Quick Look 回退）。

use std::path::Path;

/// 需要系统/内嵌预览的设计类扩展名（小写，不含点）
pub const DESIGN_SOURCE_EXTS: &[&str] = &[
    "psd", "psb", "ai", "sketch", "fig", "xd", "indd", "afdesign", "afphoto",
];

/// 可用 Quick Look / Shell 预览的文档类（含 design 未列出的 pdf 等）
pub const DOCUMENT_PREVIEW_EXTS: &[&str] = &["pdf", "eps"];

/// 与 scanner 一致的扩展名 → filetype（供 library_sync / commands 共用，避免 PSD 被标成 document）
pub fn classify_extension(ext: &str) -> Option<&'static str> {
    const IMAGE_EXTS: &[&str] = &[
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "avif", "heic", "svg",
    ];
    const VIDEO_EXTS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "flv"];
    const _3D_EXTS: &[&str] = &["obj", "fbx", "glb", "gltf", "blend", "stl"];
    const ARCHIVE_EXTS: &[&str] = &["zip", "rar"];

    let lower = ext.to_ascii_lowercase();
    let lower = lower.as_str();
    if IMAGE_EXTS.contains(&lower) {
        return Some("image");
    }
    if VIDEO_EXTS.contains(&lower) {
        return Some("video");
    }
    if _3D_EXTS.contains(&lower) {
        return Some("3d");
    }
    if is_design_source_ext(lower) {
        return Some("design");
    }
    if is_document_preview_ext(lower) || ARCHIVE_EXTS.contains(&lower) {
        return Some("document");
    }
    None
}

pub fn ext_lower_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn is_psd_family_ext(ext: &str) -> bool {
    matches!(ext, "psd" | "psb")
}

pub fn is_design_source_ext(ext: &str) -> bool {
    DESIGN_SOURCE_EXTS.contains(&ext)
}

pub fn is_document_preview_ext(ext: &str) -> bool {
    DOCUMENT_PREVIEW_EXTS.contains(&ext)
}

/// 是否应走「源文件预览」管线（非普通光栅图）
pub fn needs_source_preview_for_ext(ext: &str) -> bool {
    is_design_source_ext(ext) || is_document_preview_ext(ext)
}

pub fn needs_source_preview_for_filetype_and_ext(filetype: &str, ext: &str) -> bool {
    if filetype == "design" {
        return true;
    }
    if filetype == "document" && needs_source_preview_for_ext(ext) {
        return true;
    }
    needs_source_preview_for_ext(ext)
}

/// 磁盘上是否已有可用于网格的 WebP 档（micro 或 standard webp）
pub fn has_modern_webp_tiers(
    micro: Option<&str>,
    standard: Option<&str>,
    preview: Option<&str>,
) -> bool {
    if micro.map(|p| !p.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    if let Some(p) = standard {
        let t = p.trim();
        if !t.is_empty() && t.to_ascii_lowercase().ends_with(".webp") {
            return true;
        }
    }
    if let Some(p) = preview {
        let t = p.trim();
        if !t.is_empty() && t.to_ascii_lowercase().ends_with(".webp") {
            return true;
        }
    }
    false
}

/// 从源文件同目录 `.nocturne_meta` 发现已生成的 WebP/JPEG 缩略图（绝对路径）。
pub fn discover_existing_sidecar_tiers(
    source_file: &Path,
    filename: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let parent = source_file.parent().unwrap_or_else(|| Path::new("."));
    let meta_dir = parent.join(".nocturne_meta");
    if !meta_dir.is_dir() {
        return (None, None, None);
    }

    let micro = meta_dir.join(format!("{}_micro.webp", filename));
    let thumb_webp = meta_dir.join(format!("{}_thumb.webp", filename));
    let thumb_jpg = meta_dir.join(format!("{}_thumb.jpg", filename));
    let preview = meta_dir.join(format!("{}_preview.webp", filename));

    let micro_p = micro.is_file().then(|| micro.to_string_lossy().to_string());
    let std_p = if thumb_webp.is_file() {
        Some(thumb_webp.to_string_lossy().to_string())
    } else if thumb_jpg.is_file() {
        Some(thumb_jpg.to_string_lossy().to_string())
    } else {
        None
    };
    let prev_p = preview
        .is_file()
        .then(|| preview.to_string_lossy().to_string());

    (micro_p, std_p, prev_p)
}

/// 若 DB 缺缩略图路径但磁盘 sidecar 已有，写回 DB。
pub fn hydrate_db_thumbnails_from_sidecar(
    conn: &rusqlite::Connection,
    media_id: &str,
    source_file: &Path,
    filename: &str,
) -> bool {
    let file = match crate::db::crud::get_media_file_by_id(conn, media_id) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let db_has_tiers = has_modern_webp_tiers(
        file.thumbnail_micro_path.as_deref(),
        file.thumbnail_path.as_deref(),
        file.thumbnail_preview_path.as_deref(),
    );
    if db_has_tiers {
        let micro_ok = file
            .thumbnail_micro_path
            .as_ref()
            .map(|p| Path::new(p.trim()).is_file())
            .unwrap_or(false);
        let std_ok = file
            .thumbnail_path
            .as_ref()
            .map(|p| Path::new(p.trim()).is_file())
            .unwrap_or(false);
        if micro_ok || std_ok {
            return false;
        }
    }

    let disk_name = source_file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(filename);
    let (micro, standard, preview) = discover_existing_sidecar_tiers(source_file, disk_name);
    if micro.is_none() && standard.is_none() && preview.is_none() {
        return false;
    }

    if crate::media::thumbnail::update_multi_tier_thumbnails(
        conn,
        media_id,
        micro.as_deref(),
        standard.as_deref(),
        preview.as_deref(),
        None,
    )
    .is_ok()
    {
        log::info!(
            "[design_source] Hydrated DB thumbnails for {} from sidecar",
            filename
        );
        true
    } else {
        false
    }
}

/// 启动同步：为 design/document 条目从 sidecar 回填缺失的缩略图路径。
pub fn hydrate_all_design_sidecar_thumbnails_in_db(
    library_root: &str,
    db_path: &str,
) -> Result<u64, String> {
    let root = library_root.trim();
    if root.is_empty() {
        return Ok(0);
    }
    let conn = crate::db::open_conn(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, filepath, filename, filetype, COALESCE(source_folder, '')
             FROM media_files
             WHERE COALESCE(is_trashed, 0) = 0
               AND filetype IN ('design', 'document')",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut updated = 0u64;
    let mut scanned = 0u64;
    for (id, filepath, filename, filetype, source_folder) in rows {
        let ext = Path::new(&filepath)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if filetype != "design" && filetype != "document" && !needs_source_preview_for_ext(&ext) {
            continue;
        }
        scanned += 1;
        let folder_hint = source_folder.trim();
        let folder_opt = if folder_hint.is_empty() {
            None
        } else {
            Some(folder_hint)
        };
        let resolved = crate::media::path_util::resolve_media_file_on_disk_with_folder_hint(
            &filepath,
            Some(root),
            Some(&filename),
            folder_opt,
        );
        let Some(source) = resolved else {
            continue;
        };
        let disk_path = source.to_string_lossy().to_string();
        if disk_path != filepath {
            let _ =
                crate::media::library_sync::apply_repaired_media_path(&conn, &id, &disk_path, root);
        }
        if hydrate_db_thumbnails_from_sidecar(&conn, &id, &source, &filename) {
            updated += 1;
        }
    }
    eprintln!(
        "[library_sync] design sidecar scan: entries={} hydrated={}",
        scanned, updated
    );
    Ok(updated)
}

/// 统一生成/补全源文件缩略图；返回 standard 路径（若有）
pub fn ensure_source_preview_thumbnails(
    media_id: &str,
    disk_path: &str,
    filename: &str,
    meta_dir: &Path,
    db_path: &str,
    filetype: &str,
    ext: &str,
) -> Option<String> {
    if !needs_source_preview_for_filetype_and_ext(filetype, ext) {
        return None;
    }

    if is_psd_family_ext(ext) {
        return crate::media::thumbnail::ensure_psd_design_thumbnails(
            media_id, disk_path, filename, meta_dir, db_path,
        );
    }

    if let Some(bytes) = crate::media::os_preview::fetch_os_preview_bytes(disk_path, 512) {
        return crate::media::thumbnail::ensure_design_preview_from_raster_bytes(
            media_id, disk_path, filename, meta_dir, db_path, &bytes,
        );
    }

    log::warn!(
        "[design_source] No preview for {} (ext={}, type={})",
        filename,
        ext,
        filetype
    );
    None
}
