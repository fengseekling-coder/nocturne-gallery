//! 系统级文件预览（Quick Look / 后续可扩展 Windows Shell），用于 PSD/AI 等无内嵌缩略图时。

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

/// 尝试从操作系统获取预览图原始字节（PNG/JPEG）。
pub fn fetch_os_preview_bytes(filepath: &str, size: u32) -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    {
        let path = crate::media::path_util::resolve_regular_file_path(filepath)?;
        macos_quicklook_preview_bytes(&path, size)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (filepath, size);
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_quicklook_preview_bytes(path: &Path, size: u32) -> Option<Vec<u8>> {
    let size = size.clamp(128, 1024);
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let out_dir = std::env::temp_dir().join(format!("nocturne_ql_{}", uuid_simple()));
    if std::fs::create_dir_all(&out_dir).is_err() {
        return None;
    }

    let output = Command::new("/usr/bin/qlmanage")
        .args([
            "-t",
            "-s",
            &size.to_string(),
            "-o",
            out_dir.to_string_lossy().as_ref(),
        ])
        .arg(&canonical)
        .output()
        .ok()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!(
            "[os_preview] qlmanage failed for {} (exit {:?}): {}",
            canonical.display(),
            output.status.code(),
            stderr.trim()
        );
        let _ = std::fs::remove_dir_all(&out_dir);
        return None;
    }

    let mut png_path: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&out_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("png"))
                == Some(true)
            {
                png_path = Some(p);
                break;
            }
        }
    }

    let png_path = match png_path {
        Some(p) => p,
        None => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return None;
        }
    };

    let bytes = std::fs::read(&png_path).ok();
    let _ = std::fs::remove_dir_all(&out_dir);
    bytes.filter(|b| !b.is_empty())
}

#[cfg(target_os = "macos")]
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}
