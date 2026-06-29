//! P1-1 收尾:拖拽命令独立成模块
//!
//! 从 import_export.rs 拆出,因为:
//! 1. plan 第 20 行对 import_export 的定义是"导入 + 另存为",拖拽本质不属于这里。
//! 2. 拆出后 import_export.rs 从 1539 行降到 < 1500 行(plan 第 85 行完成标志)。

use crate::commands::{library_root, resolve_under_library_root};
use std::path::PathBuf;
use tauri::{command, Manager};

/// 调用系统级 drag API 启动文件拖拽。
/// `drag_paths` 必须是已经通过路径守卫校验的库内文件。
pub fn start_native_file_drag(window: &tauri::Window, drag_paths: Vec<PathBuf>) -> Result<(), String> {
    let preview = drag_paths
        .first()
        .cloned()
        .ok_or_else(|| "没有可拖出的文件".to_string())?;

    drag::start_drag(
        window,
        drag::DragItem::Files(drag_paths),
        drag::Image::File(preview),
        |_result, _cursor_position| {},
        drag::Options::default(),
    )
    .map_err(|e| format!("启动系统拖拽失败：{}", e))
}

/// 收集并校验待拖拽的文件路径,所有路径必须落在库根内且是文件(非目录)。
pub fn collect_file_drag_paths(paths: Vec<String>, library_root: &str) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("没有可拖出的文件".to_string());
    }

    let mut drag_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for path in paths {
        // 路径守卫（A 类）：只允许拖出库内已存在的文件。
        let path_buf = resolve_under_library_root(&path, library_root)?;
        if !path_buf.is_file() {
            return Err(format!("只能拖出文件：{}", path_buf.display()));
        }
        drag_paths.push(path_buf);
    }

    Ok(drag_paths)
}

/// Tauri 命令:从前端接收路径列表,启动系统级文件拖拽。
#[command]
pub async fn start_file_drag(window: tauri::Window, paths: Vec<String>) -> Result<(), String> {
    let library_root = library_root(window.app_handle())?;
    let drag_paths = collect_file_drag_paths(paths, &library_root)?;
    start_native_file_drag(&window, drag_paths)
}
