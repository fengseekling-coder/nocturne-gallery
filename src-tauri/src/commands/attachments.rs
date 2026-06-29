//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
use crate::commands::{db_path, library_root, read_supported_ai_input_file_base64, shell_thumbnail_preview_data_url, validate_existing_local_path};
use crate::db::open_conn;
use base64::Engine;
use tauri::{command, AppHandle, Manager};
pub fn canonical_regular_file_path(raw_path: &str, label: &str) -> Result<std::path::PathBuf, String> {
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

pub fn attachment_mime_type_from_path(path: &std::path::Path) -> Option<String> {
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

            crate::db::crud::add_media_attachment(
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
            log::warn!(
                "[add_media_attachments] Failed to allow attachment in asset scope: {} - {}",
                path,
                e
            );
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
            let is_external = lib_root
                .as_ref()
                .map(|root| {
                    !std::path::Path::new(&filepath).starts_with(std::path::Path::new(root))
                })
                .unwrap_or(false);

            if is_external {
                // Only revoke when no other attachment row still references this path.
                let ref_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM media_attachments WHERE filepath = ? AND id != ?",
                        rusqlite::params![&filepath, &attachment_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(1); // default to 1 (keep allowed) on DB error
                if ref_count == 0 {
                    Some(filepath)
                } else {
                    None
                }
            } else {
                None // inside library root; directory scope covers it
            }
        } else {
            None
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crate::db::crud::remove_media_attachment(&tx, &attachment_id).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        Ok(revoke)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Revoke asset scope for external files that are no longer referenced.
    if let Some(filepath) = revoke_path {
        if let Err(e) = handle
            .asset_protocol_scope()
            .forbid_file(std::path::Path::new(&filepath))
        {
            log::warn!(
                "[remove_media_attachment] Failed to revoke asset scope for {}: {}",
                filepath,
                e
            );
        }
    }

    Ok(())
}

#[command]
pub async fn get_attachment_preview_data(
    handle: AppHandle,
    path: String,
    size: Option<u32>,
    filename: Option<String>,
) -> Result<Option<String>, String> {
    let preview_size = size.unwrap_or(320).clamp(96, 1024);
    let library_root = library_root(&handle).unwrap_or_default();
    let name = filename;
    // 路径守卫（B 类）：附件预览可能读取库外文件，做存在性 + 规范化校验（拒绝 `..` 穿越），不强制库内。
    let path = validate_existing_local_path(&path)?
        .to_string_lossy()
        .to_string();
    tokio::task::spawn_blocking(move || {
        shell_thumbnail_preview_data_url(&path, preview_size, &library_root, name.as_deref())
    })
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
        let file = crate::db::crud::get_media_file_by_id(&conn, &media_id).map_err(|e| e.to_string())?;
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
    let library_root = library_root(&handle).unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let filepath: String = conn
            .query_row(
                "SELECT filepath FROM media_attachments WHERE id = ?",
                rusqlite::params![attachment_id],
                |row| row.get(0),
            )
            .map_err(|_| "preview_unavailable".to_string())?;

        let path = std::path::Path::new(&filepath);
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "preview_unavailable".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            return Err("preview_unavailable".to_string());
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif"
        ) {
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
            encoder
                .encode(
                    &rgba,
                    rgba.width(),
                    rgba.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|_| "preview_unavailable".to_string())?;
            return Ok(format!(
                "data:image/webp;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(out)
            ));
        }

        let filename_hint = path.file_name().and_then(|n| n.to_str());
        match shell_thumbnail_preview_data_url(&filepath, 320, &library_root, filename_hint)
            .map_err(|_| "preview_unavailable".to_string())?
        {
            Some(preview) => Ok(preview),
            None => Err("preview_unavailable".to_string()),
        }
    })
    .await
    .map_err(|_| "preview_unavailable".to_string())?
}
