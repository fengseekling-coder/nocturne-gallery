//! 主媒体文件与其附属数据（.nocturne_meta、库内附件）的移动与删除须保持一致。

use crate::models::FileMetaJSON;
use rusqlite::{params, Connection};

pub fn find_meta_json_path(
    meta_dir: &std::path::Path,
    filename: &str,
) -> Option<std::path::PathBuf> {
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

pub fn update_meta_json_filename(
    meta_path: &std::path::Path,
    new_filename: &str,
) -> Result<String, String> {
    let content = std::fs::read_to_string(meta_path)
        .map_err(|e| format!("Failed to read meta JSON: {}", e))?;
    let mut meta = serde_json::from_str::<FileMetaJSON>(&content)
        .map_err(|e| format!("Failed to parse meta JSON: {}", e))?;
    meta.file_name = new_filename.to_string();
    serde_json::to_string_pretty(&meta).map_err(|e| format!("Failed to serialize meta JSON: {}", e))
}

/// 主文件移动后，搬迁同目录 `.nocturne_meta` 下的 JSON 与 micro/preview 缩略图。
pub fn relocate_sidecar_meta_after_move(
    old_filepath: &str,
    new_filepath: &str,
    old_filename: &str,
    new_filename: &str,
) {
    let old_path = std::path::Path::new(old_filepath);
    let new_path = std::path::Path::new(new_filepath);
    let Some(old_parent) = old_path.parent() else {
        return;
    };
    let Some(new_parent) = new_path.parent() else {
        return;
    };
    let old_meta_dir = old_parent.join(".nocturne_meta");
    let new_meta_dir = new_parent.join(".nocturne_meta");
    if old_meta_dir == new_meta_dir && old_filename == new_filename {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&new_meta_dir) {
        log::warn!(
            "[media_bundle] Failed to create meta dir {}: {}",
            new_meta_dir.display(),
            e
        );
        return;
    }
    if let Some(old_meta) = find_meta_json_path(&old_meta_dir, old_filename) {
        let new_meta = new_meta_dir.join(format!("{}.json", new_filename));
        if old_meta != new_meta {
            if let Ok(updated) = update_meta_json_filename(&old_meta, new_filename) {
                let _ = std::fs::write(&new_meta, updated);
                let _ = std::fs::remove_file(&old_meta);
            } else if let Err(e) = std::fs::rename(&old_meta, &new_meta) {
                log::warn!(
                    "[media_bundle] Failed to move meta {} -> {}: {}",
                    old_meta.display(),
                    new_meta.display(),
                    e
                );
            }
        }
    }
    for entry in [
        format!("{}_micro.webp", old_filename),
        format!("{}_preview.webp", old_filename),
    ] {
        let old_thumb = old_meta_dir.join(&entry);
        if !old_thumb.is_file() {
            continue;
        }
        let new_stem = if entry.contains("_micro") {
            format!("{}_micro.webp", new_filename)
        } else {
            format!("{}_preview.webp", new_filename)
        };
        let new_thumb = new_meta_dir.join(new_stem);
        if old_thumb != new_thumb {
            if let Err(e) = std::fs::rename(&old_thumb, &new_thumb) {
                log::warn!(
                    "[media_bundle] Failed to move thumb {}: {}",
                    old_thumb.display(),
                    e
                );
            }
        }
    }
}

fn remap_path_on_disk(
    old_path: &str,
    old_dir: &str,
    new_dir: &str,
    old_name: &str,
    new_name: &str,
) -> Option<String> {
    let trimmed = old_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = std::path::Path::new(trimmed);
    if !path.exists() {
        return None;
    }
    if let Ok(stripped) = path.strip_prefix(old_dir) {
        let suffix = stripped.to_string_lossy();
        let new_base = std::path::Path::new(new_dir);
        return Some(new_base.join(suffix.as_ref()).to_string_lossy().to_string());
    }
    if path.file_name().and_then(|n| n.to_str()) == Some(old_name) {
        return Some(
            std::path::Path::new(new_dir)
                .join(new_name)
                .to_string_lossy()
                .to_string(),
        );
    }
    None
}

/// 根据 sidecar 新位置，同步 DB 中的 thumbnail_* 字段。
pub fn sync_thumbnail_paths_in_db(
    conn: &Connection,
    media_id: &str,
    old_filepath: &str,
    new_filepath: &str,
    old_filename: &str,
    new_filename: &str,
) {
    let Ok(file) = crate::db::crud::get_media_file_by_id(conn, media_id) else {
        return;
    };
    let old_parent = std::path::Path::new(old_filepath)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
    let new_parent = std::path::Path::new(new_filepath)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
    let (Some(old_dir), Some(new_dir)) = (old_parent, new_parent) else {
        return;
    };

    let thumb = file
        .thumbnail_path
        .as_deref()
        .and_then(|p| remap_path_on_disk(p, &old_dir, &new_dir, old_filename, new_filename));
    let micro = file
        .thumbnail_micro_path
        .as_deref()
        .and_then(|p| remap_path_on_disk(p, &old_dir, &new_dir, old_filename, new_filename));
    let preview = file
        .thumbnail_preview_path
        .as_deref()
        .and_then(|p| remap_path_on_disk(p, &old_dir, &new_dir, old_filename, new_filename));

    if thumb.is_none() && micro.is_none() && preview.is_none() {
        return;
    }

    let _ = conn.execute(
        "UPDATE media_files SET
            thumbnail_path = COALESCE(?1, thumbnail_path),
            thumbnail_micro_path = COALESCE(?2, thumbnail_micro_path),
            thumbnail_preview_path = COALESCE(?3, thumbnail_preview_path)
         WHERE id = ?4",
        params![thumb, micro, preview, media_id],
    );
}

fn attachment_dir_for_media(main_filepath: &str, media_id: &str) -> std::path::PathBuf {
    std::path::Path::new(main_filepath)
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join(".nocturne_attachments")
        .join(media_id)
}

fn unique_path_in_dir(dir: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(filename);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    for n in 1..=10_000 {
        candidate = dir.join(format!("{} ({}){}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(filename)
}

fn move_file_within_library(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("源文件不存在或不是文件：{}", source.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目标目录：{}", e))?;
    }
    if target.exists() {
        return Err(format!("目标路径已存在：{}", target.display()));
    }
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            std::fs::copy(source, target).map_err(|copy_err| {
                format!("移动文件失败（rename: {}；copy: {}）", rename_err, copy_err)
            })?;
            std::fs::remove_file(source).map_err(|e| {
                format!(
                    "文件已复制到目标位置，但无法删除源文件：{} ({})",
                    source.display(),
                    e
                )
            })?;
            Ok(())
        }
    }
}

/// 库内附件随主文件移动，并更新 `media_attachments.filepath`。
pub fn relocate_library_attachments_after_move(
    conn: &Connection,
    media_id: &str,
    old_main_filepath: &str,
    new_main_filepath: &str,
    library_root: &str,
) {
    let root = std::path::Path::new(library_root);
    let dest_dir = attachment_dir_for_media(new_main_filepath, media_id);
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        log::warn!(
            "[media_bundle] Failed to create attachment dir {}: {}",
            dest_dir.display(),
            e
        );
        return;
    }

    let mut stmt =
        match conn.prepare("SELECT id, filepath FROM media_attachments WHERE media_id = ?") {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[media_bundle] attachment query failed: {}", e);
                return;
            }
        };
    let rows: Vec<(String, String)> =
        match stmt.query_map(params![media_id], |row| Ok((row.get(0)?, row.get(1)?))) {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(e) => {
                log::warn!("[media_bundle] attachment query map failed: {}", e);
                return;
            }
        };

    for (att_id, att_path) in rows {
        let att = std::path::Path::new(&att_path);
        if !att.starts_with(root) || !att.is_file() {
            continue;
        }
        let Some(name) = att.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let target = unique_path_in_dir(&dest_dir, name);
        if let Err(e) = move_file_within_library(att, &target) {
            log::warn!(
                "[media_bundle] Failed to move attachment {} -> {}: {}",
                att_path,
                target.display(),
                e
            );
            continue;
        }
        let new_path = target.to_string_lossy().to_string();
        if let Err(e) = conn.execute(
            "UPDATE media_attachments SET filepath = ? WHERE id = ?",
            params![new_path, att_id],
        ) {
            log::warn!("[media_bundle] Failed to update attachment path: {}", e);
        }
    }

    let _old_main = old_main_filepath;
}

/// 主文件 + sidecar + 库内附件 一并搬迁；返回 `(新路径, 新文件名)`。
pub fn relocate_media_bundle_after_main_move(
    conn: &Connection,
    media_id: &str,
    old_filepath: &str,
    new_filepath: &str,
    old_filename: &str,
    new_filename: &str,
    library_root: &str,
) {
    relocate_sidecar_meta_after_move(old_filepath, new_filepath, old_filename, new_filename);
    sync_thumbnail_paths_in_db(
        conn,
        media_id,
        old_filepath,
        new_filepath,
        old_filename,
        new_filename,
    );
    relocate_library_attachments_after_move(
        conn,
        media_id,
        old_filepath,
        new_filepath,
        library_root,
    );
}

/// 永久删除：sidecar + 库内附件文件（不删 DB；附件行由 `delete_media_file` CASCADE 处理）。
pub fn purge_media_sidecar_and_library_attachment_files(
    conn: &Connection,
    media_id: &str,
    filepath: &str,
    library_root: &str,
) {
    let path = std::path::Path::new(filepath);
    if let Some(parent) = path.parent() {
        let meta_dir = parent.join(".nocturne_meta");
        if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
            if let Some(meta_json) = find_meta_json_path(&meta_dir, filename) {
                let _ = std::fs::remove_file(meta_json);
            }
            let _ = std::fs::remove_file(meta_dir.join(format!("{}_micro.webp", filename)));
            let _ = std::fs::remove_file(meta_dir.join(format!("{}_preview.webp", filename)));
        }
        let att_dir = parent.join(".nocturne_attachments").join(media_id);
        if att_dir.is_dir() {
            let _ = std::fs::remove_dir_all(&att_dir);
        }
    }

    let root = std::path::Path::new(library_root);
    let mut stmt =
        match conn.prepare("SELECT id, filepath FROM media_attachments WHERE media_id = ?") {
            Ok(s) => s,
            Err(_) => return,
        };
    let rows: Vec<(String, String)> = stmt
        .query_map(params![media_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .ok()
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    for (_att_id, att_path) in rows {
        let att = std::path::Path::new(&att_path);
        if att.starts_with(root) && att.is_file() {
            let _ = std::fs::remove_file(att);
        }
    }
}
