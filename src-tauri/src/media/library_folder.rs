//! 灵感库磁盘根目录名：新库使用 `GegaGallery`，并从 `NocturneGallery` 自动迁移。

use std::path::Path;

pub const LEGACY_LIBRARY_DIR_NAME: &str = "NocturneGallery";
pub const CURRENT_LIBRARY_DIR_NAME: &str = "GegaGallery";

fn path_ends_with_dir(path: &Path, dir_name: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case(dir_name))
        .unwrap_or(false)
}

/// 若 `root` 的最后一级为旧目录名，则重命名为 `GegaGallery` 并返回新路径。
pub fn migrate_legacy_library_dir_name(root: &str) -> Result<String, String> {
    let root_path = Path::new(root.trim());
    if root_path.as_os_str().is_empty() {
        return Err("库路径为空".to_string());
    }

    if !path_ends_with_dir(root_path, LEGACY_LIBRARY_DIR_NAME) {
        return Ok(root.trim().to_string());
    }

    let Some(parent) = root_path.parent() else {
        return Ok(root.trim().to_string());
    };

    let target = parent.join(CURRENT_LIBRARY_DIR_NAME);
    if root_path == target {
        return Ok(target.to_string_lossy().into_owned());
    }

    if target.exists() {
        if crate::media::watcher::is_valid_library_root(&target.to_string_lossy()) {
            eprintln!(
                "[library_folder] {} already exists; using it instead of renaming {:?}",
                CURRENT_LIBRARY_DIR_NAME, root_path
            );
            return Ok(target.to_string_lossy().into_owned());
        }
        return Err(format!(
            "无法迁移：目标 {} 已存在但不是有效灵感库",
            target.display()
        ));
    }

    if !root_path.exists() {
        return Ok(root.trim().to_string());
    }

    std::fs::rename(root_path, &target).map_err(|e| {
        format!(
            "无法将 {} 重命名为 {}：{}",
            root_path.display(),
            target.display(),
            e
        )
    })?;
    eprintln!("[library_folder] Renamed {:?} → {:?}", root_path, target);
    Ok(target.to_string_lossy().into_owned())
}

/// 用户选择的父目录下解析灵感库根：优先 `GegaGallery`，必要时从 `NocturneGallery` 迁移或新建。
pub fn resolve_library_root_under_parent(parent_path: &str) -> Result<String, String> {
    let parent = Path::new(parent_path.trim());
    if parent.as_os_str().is_empty() {
        return Err("父目录路径为空".to_string());
    }

    if crate::media::watcher::is_valid_library_root(parent_path.trim()) {
        return migrate_legacy_library_dir_name(parent_path.trim());
    }

    let gega = parent.join(CURRENT_LIBRARY_DIR_NAME);
    let legacy = parent.join(LEGACY_LIBRARY_DIR_NAME);

    let gega_str = gega.to_string_lossy().into_owned();
    let legacy_str = legacy.to_string_lossy().into_owned();

    if gega.exists() {
        return Ok(gega_str);
    }

    if legacy.exists() {
        if crate::media::watcher::is_valid_library_root(&legacy_str) {
            return migrate_legacy_library_dir_name(&legacy_str);
        }
        std::fs::rename(&legacy, &gega).map_err(|e| {
            format!(
                "无法将 {} 重命名为 {}：{}",
                legacy.display(),
                gega.display(),
                e
            )
        })?;
        eprintln!("[library_folder] Renamed {:?} → {:?}", legacy, gega);
        return Ok(gega_str);
    }

    std::fs::create_dir_all(&gega).map_err(|e| format!("无法创建 {}：{}", gega.display(), e))?;
    Ok(gega_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn legacy_leaf_detection_cross_platform() {
        let p = PathBuf::from("Archive").join(LEGACY_LIBRARY_DIR_NAME);
        assert!(path_ends_with_dir(&p, LEGACY_LIBRARY_DIR_NAME));
        assert!(!path_ends_with_dir(&p, CURRENT_LIBRARY_DIR_NAME));
    }

    #[cfg(windows)]
    #[test]
    fn legacy_leaf_detection_windows_drive() {
        let p = Path::new(r"H:\Archive\NocturneGallery");
        assert!(path_ends_with_dir(p, LEGACY_LIBRARY_DIR_NAME));
    }
}
