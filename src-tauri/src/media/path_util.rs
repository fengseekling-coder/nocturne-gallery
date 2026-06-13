//! 库内媒体路径解析（macOS 上 DB 路径与磁盘文件名 Unicode 形式可能不一致）。

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 返回磁盘上真实存在的常规文件路径（含 canonicalize、macOS NFC/NFD 变体）。
pub fn resolve_regular_file_path(filepath: &str) -> Option<PathBuf> {
    resolve_media_file_on_disk(filepath, None, None)
}

/// 在库根下按文件名查找（解决 DB filepath 与磁盘 Unicode 不一致）。
pub fn resolve_media_file_on_disk(
    filepath: &str,
    library_root: Option<&str>,
    filename_hint: Option<&str>,
) -> Option<PathBuf> {
    resolve_media_file_on_disk_with_folder_hint(filepath, library_root, filename_hint, None)
}

/// 与 [`resolve_media_file_on_disk`] 相同，但在库内多同名文件时优先匹配 `source_folder` 子目录。
pub fn resolve_media_file_on_disk_with_folder_hint(
    filepath: &str,
    library_root: Option<&str>,
    filename_hint: Option<&str>,
    source_folder: Option<&str>,
) -> Option<PathBuf> {
    let trimmed = filepath.trim();
    if trimmed.is_empty() {
        return None;
    }

    for candidate in path_lookup_variants(trimmed) {
        if candidate.is_file() {
            return Some(candidate);
        }
        if let Ok(canonical) = std::fs::canonicalize(&candidate) {
            if canonical.is_file() {
                return Some(canonical);
            }
        }
    }

    if let Some(root) = library_root.map(str::trim).filter(|s| !s.is_empty()) {
        let basename = filename_hint
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| Path::new(trimmed).file_name().and_then(|n| n.to_str()));
        if let Some(name) = basename {
            if let Some(found) = find_file_under_library_by_basename(root, name, source_folder) {
                log::info!(
                    "[path_util] located by basename under library: {} -> {}",
                    trimmed,
                    found.display()
                );
                return Some(found);
            }
        }

        if let Some(suffix) = library_relative_suffix_from_stored_path(trimmed, root) {
            let candidate = Path::new(root).join(&suffix);
            if candidate.is_file() {
                return Some(candidate);
            }
            for variant in path_lookup_variants(&candidate.to_string_lossy()) {
                if variant.is_file() {
                    return Some(variant);
                }
            }
        }
    }

    None
}

fn library_relative_suffix_from_stored_path(stored: &str, library_root: &str) -> Option<String> {
    let stored_norm = stored.replace('\\', "/");
    let root_norm = library_root
        .trim()
        .trim_end_matches(['\\', '/'])
        .replace('\\', "/");
    if root_norm.is_empty() {
        return None;
    }
    let root_with_slash = format!("{}/", root_norm);
    if stored_norm.starts_with(&root_with_slash) {
        return Some(stored_norm[root_with_slash.len()..].to_string());
    }
    for marker in [
        "/灵感库/",
        "/作品集/",
        "/回收站/",
        "/渲染队列/",
        "/AI 提示词库/",
    ] {
        if let Some(i) = stored_norm.find(marker) {
            return Some(stored_norm[i + 1..].to_string());
        }
    }
    None
}

fn filenames_match_on_disk(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        use unicode_normalization::UnicodeNormalization;
        let a_nfc: String = a.nfc().collect();
        let b_nfc: String = b.nfc().collect();
        if a_nfc == b_nfc {
            return true;
        }
        let a_nfd: String = a.nfd().collect();
        let b_nfd: String = b.nfd().collect();
        if a_nfd == b_nfd {
            return true;
        }
    }
    a.eq_ignore_ascii_case(b)
}

/// 在库根下递归查找与 basename 匹配的文件（深度限制，跳过 .nocturne*）。
pub fn find_file_under_library_by_basename(
    library_root: &str,
    basename: &str,
    source_folder: Option<&str>,
) -> Option<PathBuf> {
    let root = Path::new(library_root);
    if !root.is_dir() {
        return None;
    }

    let mut matches: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.components().any(|c| {
            matches!(
                c.as_os_str().to_string_lossy().as_ref(),
                ".nocturne" | ".nocturne_meta"
            )
        }) {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if filenames_match_on_disk(name, basename) {
            matches.push(p.to_path_buf());
        }
    }

    if matches.is_empty() {
        return None;
    }
    if matches.len() == 1 {
        return matches.into_iter().next();
    }

    if let Some(folder) = source_folder.map(str::trim).filter(|s| !s.is_empty()) {
        let folder_norm = folder.replace('\\', "/");
        for p in &matches {
            let p_str = p.to_string_lossy().replace('\\', "/");
            if p_str.contains(&format!("/{}/", folder_norm))
                || p_str.contains(&format!("/{}/", folder))
            {
                return Some(p.clone());
            }
        }
        // DB 指向回收站等但磁盘上不在该目录：在其它目录找同名文件
        if folder == "回收站" {
            return pick_preferred_basename_match(&matches);
        }
    }

    pick_preferred_basename_match(&matches)
}

fn path_is_under_trash(p: &Path) -> bool {
    let s = p.to_string_lossy().replace('\\', "/");
    s.contains("/回收站/")
}

/// 多同名时优先非回收站、路径较短者（常见为真实工作目录）。
fn pick_preferred_basename_match(matches: &[PathBuf]) -> Option<PathBuf> {
    if matches.is_empty() {
        return None;
    }
    let mut ranked: Vec<&PathBuf> = matches.iter().collect();
    ranked.sort_by(|a, b| {
        let a_trash = path_is_under_trash(a) as u8;
        let b_trash = path_is_under_trash(b) as u8;
        a_trash
            .cmp(&b_trash)
            .then_with(|| a.to_string_lossy().len().cmp(&b.to_string_lossy().len()))
    });
    Some(ranked[0].clone())
}

/// 从库内绝对路径推断 source_folder（灵感库 / 作品集 / 回收站 等）。
pub fn infer_source_folder_from_library_path(path: &Path, library_root: &str) -> Option<String> {
    let p = path.to_string_lossy().replace('\\', "/");
    let root = library_root
        .trim()
        .trim_end_matches(['\\', '/'])
        .replace('\\', "/");
    let rel = if p.starts_with(&format!("{}/", root)) {
        p[root.len() + 1..].to_string()
    } else {
        p.clone()
    };
    for folder in ["灵感库", "作品集", "回收站", "渲染队列", "AI 提示词库"] {
        if rel.starts_with(&format!("{}/", folder)) || rel == folder {
            return Some(folder.to_string());
        }
    }
    None
}

/// 启动或批量操作前：将 DB 中 filepath 与磁盘实际路径对齐（含 macOS Unicode）。
pub fn relink_media_filepaths_in_db(
    conn: &rusqlite::Connection,
    library_root: &str,
) -> Result<u64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, filepath, filename, COALESCE(source_folder, '') FROM media_files WHERE is_trashed = 0",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let root = library_root.trim();
    let mut updated = 0u64;
    for (id, stored, filename, source_folder) in rows {
        let folder_opt = source_folder.trim();
        let folder_ref = if folder_opt.is_empty() {
            None
        } else {
            Some(folder_opt)
        };
        let Some(resolved) = resolve_media_file_on_disk_with_folder_hint(
            &stored,
            Some(root),
            Some(&filename),
            folder_ref,
        ) else {
            continue;
        };
        let new_path = resolved.to_string_lossy().to_string();
        if new_path == stored {
            continue;
        }
        conn.execute(
            "UPDATE media_files SET filepath = ?1 WHERE id = ?2",
            rusqlite::params![new_path, id],
        )
        .map_err(|e| e.to_string())?;
        updated += 1;
        log::info!("[path_util] relink {} -> {}", stored, new_path);
    }
    Ok(updated)
}

fn path_lookup_variants(filepath: &str) -> Vec<PathBuf> {
    let mut variants: Vec<PathBuf> = Vec::new();
    let mut push_unique = |p: PathBuf| {
        if !variants.iter().any(|v| v == &p) {
            variants.push(p);
        }
    };

    push_unique(PathBuf::from(filepath));

    #[cfg(target_os = "macos")]
    {
        use unicode_normalization::UnicodeNormalization;
        let nfc: String = filepath.nfc().collect();
        if nfc != filepath {
            push_unique(PathBuf::from(nfc));
        }
        let nfd: String = filepath.nfd().collect();
        if nfd != filepath {
            push_unique(PathBuf::from(nfd));
        }
    }

    variants
}
