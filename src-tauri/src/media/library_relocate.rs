//! 切换灵感库根目录时，将旧路径下的全部库内数据迁移到新路径（剪切），并清空旧路径。

use std::path::{Path, PathBuf};

use super::watcher;

/// 灵感库根目录下会被迁移/清空的顶层项（不含用户其它文件夹如 Adobe、Codex）。
const LIBRARY_ROOT_ENTRY_NAMES: &[&str] = &[
    ".nocturne",
    "灵感库",
    "作品集",
    "回收站",
    "渲染队列",
    "媒体库",
    "项目文件",
];

fn canonical_dir(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path.trim());
    if !p.exists() {
        return Err(format!("路径不存在：{}", path));
    }
    p.canonicalize()
        .map_err(|e| format!("无法解析路径 {}：{}", path, e))
}

/// 库内是否已有用户数据（非仅空壳目录结构）。
pub fn library_has_user_data(root: &str) -> bool {
    let Ok(root_path) = canonical_dir(root) else {
        return false;
    };
    if !watcher::is_valid_library_root(root) {
        return false;
    }

    for sub in ["灵感库", "作品集", "媒体库", "项目文件"] {
        let folder = root_path.join(sub);
        if !folder.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&folder) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    return true;
                }
                if path.is_dir() {
                    let name = entry.file_name();
                    if name != ".nocturne_meta" && name != ".DS_Store" {
                        return true;
                    }
                }
            }
        }
    }

    let db_path = root_path.join(".nocturne").join("nocturne.db");
    if db_path.is_file() {
        if let Ok(meta) = std::fs::metadata(&db_path) {
            if meta.len() > 250_000 {
                return true;
            }
        }
    }

    false
}

/// 切换库时是否应执行「旧库 → 新库」剪切迁移。
pub fn should_relocate_library_on_switch(old_root: &str, new_root: &str) -> bool {
    if same_library_root(old_root, new_root) {
        return false;
    }
    if !library_has_user_data(old_root) {
        eprintln!(
            "[relocate_library] Old root has no user data, skipping relocation: {}",
            old_root
        );
        return false;
    }
    if library_has_user_data(new_root) && watcher::is_valid_library_root(new_root) {
        eprintln!(
            "[relocate_library] Target already has library data; will switch without merging from old"
        );
        return false;
    }
    true
}

/// 判断两个库根是否指向同一目录（规范化后比较）。
pub fn same_library_root(a: &str, b: &str) -> bool {
    let Ok(a_canon) = canonical_dir(a) else {
        return a.trim() == b.trim();
    };
    let Ok(b_canon) = canonical_dir(b) else {
        return false;
    };
    a_canon == b_canon
}

fn is_nested_path(ancestor: &Path, descendant: &Path) -> bool {
    let mut current = descendant.to_path_buf();
    loop {
        if current == ancestor {
            return true;
        }
        if !current.pop() {
            return false;
        }
    }
}

fn move_file_or_copy_delete(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录 {}：{}", parent.display(), e))?;
    }
    if to.exists() {
        std::fs::remove_file(to)
            .map_err(|e| format!("无法覆盖已存在的目标文件 {}：{}", to.display(), e))?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(from, to).map_err(|e| {
                format!("复制文件失败 {} → {}：{}", from.display(), to.display(), e)
            })?;
            std::fs::remove_file(from)
                .map_err(|e| format!("删除源文件失败 {}：{}", from.display(), e))?;
            Ok(())
        }
    }
}

fn move_tree(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }

    if from.is_file() {
        return move_file_or_copy_delete(from, to);
    }

    if !to.exists() {
        if std::fs::rename(from, to).is_ok() {
            return Ok(());
        }
        std::fs::create_dir_all(to).map_err(|e| format!("无法创建目录 {}：{}", to.display(), e))?;
    } else if !to.is_dir() {
        return Err(format!(
            "迁移受阻：目标已存在且不是文件夹：{}",
            to.display()
        ));
    }

    let entries =
        std::fs::read_dir(from).map_err(|e| format!("无法读取目录 {}：{}", from.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败：{}", e))?;
        let name = entry.file_name();
        if name == ".DS_Store" {
            let _ = std::fs::remove_file(entry.path());
            continue;
        }
        move_tree(&entry.path(), &to.join(&name))?;
    }

    std::fs::remove_dir(from)
        .map_err(|e| format!("无法删除已迁空的目录 {}：{}", from.display(), e))?;
    Ok(())
}

// 保留给后续库迁移回滚/清空策略使用；当前迁移路径只剪切受控顶层项。
#[allow(dead_code)]
fn remove_all_children(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}：{}", dir.display(), e))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败：{}", e))?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("无法删除目录 {}：{}", path.display(), e))?;
        } else {
            std::fs::remove_file(&path)
                .map_err(|e| format!("无法删除文件 {}：{}", path.display(), e))?;
        }
    }
    Ok(())
}

/// 将 `from_root` 下全部内容剪切到 `to_root`，并确保 `from_root` 内不再留有数据文件/子目录。
pub fn relocate_library_contents(from_root: &str, to_root: &str) -> Result<(), String> {
    let from = canonical_dir(from_root)?;
    let to = canonical_dir(to_root)?;

    if from == to {
        return Ok(());
    }

    if is_nested_path(&from, &to) {
        return Err("新灵感库路径不能位于旧灵感库文件夹内部".to_string());
    }
    if is_nested_path(&to, &from) {
        return Err("旧灵感库路径不能位于新灵感库文件夹内部".to_string());
    }

    if !watcher::is_valid_library_root(from.to_string_lossy().as_ref()) {
        eprintln!(
            "[relocate_library] Old path is not a valid library, skipping file migration: {}",
            from.display()
        );
        return Ok(());
    }

    std::fs::create_dir_all(&to)
        .map_err(|e| format!("无法创建新灵感库目录 {}：{}", to.display(), e))?;

    eprintln!(
        "[relocate_library] Moving library data from {} to {}",
        from.display(),
        to.display()
    );

    for name in LIBRARY_ROOT_ENTRY_NAMES {
        let src = from.join(name);
        if !src.exists() {
            continue;
        }
        let dest = to.join(name);
        move_tree(&src, &dest)?;
    }

    for name in LIBRARY_ROOT_ENTRY_NAMES {
        let leftover = from.join(name);
        if leftover.exists() {
            if leftover.is_dir() {
                std::fs::remove_dir_all(&leftover)
                    .map_err(|e| format!("无法删除旧库残留目录 {}：{}", leftover.display(), e))?;
            } else {
                std::fs::remove_file(&leftover)
                    .map_err(|e| format!("无法删除旧库残留文件 {}：{}", leftover.display(), e))?;
            }
        }
    }
    eprintln!(
        "[relocate_library] Old library path cleared (no data left): {}",
        from.display()
    );

    Ok(())
}
