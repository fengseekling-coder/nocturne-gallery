//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
/// 前端 UI 平台（当前阶段仅 macOS 桌面端）
use tauri::command;

#[command]
pub fn get_native_platform() -> String {
    "macos".to_string()
}

/// 检测系统中是否安装了 ffmpeg（执行 ffmpeg -version）
/// 返回 true 表示可用，false 表示未安装或不在 PATH 中
#[command]
pub fn check_ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
