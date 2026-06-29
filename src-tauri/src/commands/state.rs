//! AppHandle 状态访问层
//!
//! 集中"读 AppData 路径 / 库根路径 / 缩略图目录"这一类需要 `AppHandle` 的辅助函数。
//! 它们被几乎所有领域模块共用,放在这里避免循环依赖。
//!
//! 重要: `db_path` / `library_root` 是高频调用点,**不应**在这里加缓存——Tauri
//! 的 `AppHandle` 已经自带路径解析缓存,再加一层反而会带来"库根切换后读到旧值"的问题。

use tauri::{AppHandle, Manager};

use crate::media::watcher;

/// 计算当前数据库文件路径。
///
/// 优先级: 如果 `library_root` 已在 `config.json` 中配置,则 DB 落在库根下的 `.nocturne/`
/// 子目录;否则回落 AppData(`首次初始化期间`)。
pub fn db_path(handle: &AppHandle) -> Result<String, String> {
    let data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    if let Some(root) = watcher::configured_library_root_from_app_data(&data_dir) {
        return Ok(std::path::Path::new(&root)
            .join(".nocturne")
            .join("nocturne.db")
            .to_string_lossy()
            .to_string());
    }

    Ok(data_dir.join("nocturne.db").to_string_lossy().to_string())
}

/// 缩略图目录(已废弃 —— 新架构使用每目录的 `.nocturne_meta/`)。
#[allow(dead_code)]
pub fn thumbs_dir(handle: &AppHandle) -> Result<String, String> {
    let root = library_root(handle)?;
    Ok(std::path::Path::new(&root)
        .join(".nocturne")
        .join("thumbs")
        .to_string_lossy()
        .to_string())
}

/// 取库根目录绝对路径。
///
/// 未配置时返回中文错误,前端会引导用户进入"选择灵感库根目录"流程。
pub fn library_root(handle: &AppHandle) -> Result<String, String> {
    let data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    watcher::configured_library_root_from_app_data(&data_dir)
        .ok_or_else(|| "未配置灵感库，请先在设置中选择灵感库根目录".to_string())
}