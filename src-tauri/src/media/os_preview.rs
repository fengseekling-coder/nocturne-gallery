//! macOS Quick Look 预览（`qlmanage`），用于 PSD/AI 等无内嵌缩略图时。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const QLMANAGE_TIMEOUT: Duration = Duration::from_secs(45);

/// 尝试从 Quick Look 获取预览图原始字节（PNG）。
pub fn fetch_os_preview_bytes(filepath: &str, size: u32) -> Option<Vec<u8>> {
    fetch_os_preview_bytes_with_hints(filepath, None, None, size)
}

/// 带库根/文件名提示，解决 DB 路径与磁盘不一致时 Quick Look 找不到文件。
pub fn fetch_os_preview_bytes_with_hints(
    filepath: &str,
    library_root: Option<&str>,
    filename_hint: Option<&str>,
    size: u32,
) -> Option<Vec<u8>> {
    let path = crate::media::path_util::resolve_media_file_on_disk(
        filepath,
        library_root.map(str::trim).filter(|s| !s.is_empty()),
        filename_hint.map(str::trim).filter(|s| !s.is_empty()),
    )
    .or_else(|| crate::media::path_util::resolve_regular_file_path(filepath))?;
    let primary = size.clamp(128, 1024);
    if let Some(bytes) = quicklook_preview_bytes(&path, primary) {
        return Some(bytes);
    }
    // 部分 PSD（尤其无内嵌预览）在较大尺寸下失败，逐级缩小重试
    for fallback in [512u32, 384, 256, 192, 128] {
        if fallback >= primary {
            continue;
        }
        if let Some(bytes) = quicklook_preview_bytes(&path, fallback) {
            return Some(bytes);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(bytes) = sips_preview_png_bytes(&path, primary.min(512)) {
            return Some(bytes);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn sips_preview_png_bytes(path: &Path, max_px: u32) -> Option<Vec<u8>> {
    let max_px = max_px.clamp(128, 1024);
    let out_dir = std::env::temp_dir().join(format!("nocturne_sips_{}", uuid_simple()));
    if std::fs::create_dir_all(&out_dir).is_err() {
        return None;
    }
    let out_png = out_dir.join("preview.png");
    let status = Command::new("/usr/bin/sips")
        .args([
            "-s",
            "format",
            "png",
            "-Z",
            &max_px.to_string(),
            path.to_string_lossy().as_ref(),
            "--out",
            out_png.to_string_lossy().as_ref(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    let bytes = if status.success() && out_png.is_file() {
        std::fs::read(&out_png).ok()
    } else {
        None
    };
    let _ = std::fs::remove_dir_all(&out_dir);
    bytes.filter(|b| !b.is_empty())
}

fn quicklook_preview_bytes(path: &Path, size: u32) -> Option<Vec<u8>> {
    let size = size.clamp(128, 1024);
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let out_dir = std::env::temp_dir().join(format!("nocturne_ql_{}", uuid_simple()));
    if std::fs::create_dir_all(&out_dir).is_err() {
        return None;
    }

    let mut child = Command::new("/usr/bin/qlmanage")
        .args([
            "-t",
            "-s",
            &size.to_string(),
            "-o",
            out_dir.to_string_lossy().as_ref(),
        ])
        .arg(&canonical)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let start = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                log::warn!(
                    "[os_preview] qlmanage failed for {} (exit {:?})",
                    canonical.display(),
                    status.code()
                );
                let _ = std::fs::remove_dir_all(&out_dir);
                return None;
            }
            break;
        }
        if start.elapsed() > QLMANAGE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            log::warn!(
                "[os_preview] qlmanage timed out after {}s for {}",
                QLMANAGE_TIMEOUT.as_secs(),
                canonical.display()
            );
            let _ = std::fs::remove_dir_all(&out_dir);
            return None;
        }
        std::thread::sleep(Duration::from_millis(200));
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

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}
