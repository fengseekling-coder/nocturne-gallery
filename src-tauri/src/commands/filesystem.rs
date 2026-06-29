//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
use crate::commands::{validate_existing_local_path, validate_http_url};
use tauri::command;

/// 用系统默认浏览器打开 URL
#[command]
pub async fn open_url_in_browser(url: String) -> Result<(), String> {
    let url = validate_http_url(&url)?;
    eprintln!("[open_url_in_browser] Opening: {}", url);
    tokio::task::spawn_blocking(move || open::that(&url).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// 在系统文件管理器中显示文件（定位到文件所在文件夹并选中该文件）
#[command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    eprintln!("[show_in_folder] Revealing: {}", path);
    let path = validate_existing_local_path(&path)?;

    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            // Windows 文件管理器：/select,<path> 必须紧跟逗号，中间无空格
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed to open Finder: {}", e))?;
        }
        #[cfg(target_os = "linux")]
        {
            let parent = path
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_else(|| path.clone());
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {}", e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn open_path(path: String) -> Result<(), String> {
    let path = validate_existing_local_path(&path)?;
    tokio::task::spawn_blocking(move || {
        open::that(path).map_err(|e| format!("Failed to open path: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
