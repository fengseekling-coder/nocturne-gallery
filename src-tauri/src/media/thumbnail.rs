use anyhow::{bail, Context, Result};
use std::path::Path;

use crate::db::{crud, open_conn};
use crate::models::FileMetaJSON;
use image::{DynamicImage, GenericImageView};
use std::collections::HashMap;
use webp::Encoder;

// ─────────────────────────────────────────────
//  PSD 嵌入缩略图提取
// ─────────────────────────────────────────────

/// 从 PSD/PSB 文件中提取 Image Resources 段里的嵌入 JPEG 缩略图（Resource ID 1036）。
/// 只读文件头部，不加载整个文件，适合 GB 级 PSD。
/// 返回 JPEG 字节数据；未内嵌缩略图时返回 Err。
pub fn extract_psd_thumbnail_jpeg(filepath: &str) -> Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let disk = crate::media::path_util::resolve_regular_file_path(filepath)
        .ok_or_else(|| anyhow::anyhow!("PSD not found on disk: {}", filepath))?;
    let open_path = disk.to_string_lossy().to_string();

    let mut f = std::fs::File::open(&open_path)
        .with_context(|| format!("Failed to open PSD: {}", open_path))?;

    // ── Header (26 bytes) ──
    let mut hdr = [0u8; 26];
    f.read_exact(&mut hdr)
        .context("Failed to read PSD header")?;
    if &hdr[0..4] != b"8BPS" {
        bail!("Not a valid PSD/PSB file");
    }
    let version = u16::from_be_bytes([hdr[4], hdr[5]]);
    let is_psb = version == 2;

    // ── Color Mode Data section ──
    let cmode_len: i64 = if is_psb {
        let mut len8 = [0u8; 8];
        f.read_exact(&mut len8)?;
        u64::from_be_bytes(len8) as i64
    } else {
        let mut len4 = [0u8; 4];
        f.read_exact(&mut len4)?;
        u32::from_be_bytes(len4) as i64
    };
    f.seek(SeekFrom::Current(cmode_len))?;

    // ── Image Resources section ──
    let imgres_len: usize = if is_psb {
        let mut len8 = [0u8; 8];
        f.read_exact(&mut len8)?;
        u64::from_be_bytes(len8) as usize
    } else {
        let mut len4 = [0u8; 4];
        f.read_exact(&mut len4)?;
        u32::from_be_bytes(len4) as usize
    };

    // 限制最大读取 32 MB，防止异常 PSD 导致 OOM
    let read_len = imgres_len.min(32 * 1024 * 1024);
    let mut imgres = vec![0u8; read_len];
    f.read_exact(&mut imgres)
        .context("Failed to read Image Resources")?;

    // ── 解析 Resource Block 列表 ──
    let mut pos = 0usize;
    while pos + 12 <= imgres.len() {
        if &imgres[pos..pos + 4] != b"8BIM" {
            break;
        }
        pos += 4;

        let res_id = u16::from_be_bytes([imgres[pos], imgres[pos + 1]]);
        pos += 2;

        // Pascal string（长度字节 + 内容），整体对齐到偶数字节
        let name_len = imgres[pos] as usize;
        pos += 1;
        let skip = if (name_len + 1).is_multiple_of(2) {
            name_len
        } else {
            name_len + 1
        };
        pos += skip;

        if pos + 4 > imgres.len() {
            break;
        }
        let data_len = u32::from_be_bytes([
            imgres[pos],
            imgres[pos + 1],
            imgres[pos + 2],
            imgres[pos + 3],
        ]) as usize;
        pos += 4;

        if pos + data_len > imgres.len() {
            break;
        }

        // Resource ID 1036 (0x040C) = Photoshop 5.0+ 缩略图
        // Resource ID 1033 (0x0409) = Photoshop 4.0 缩略图（格式相同）
        if (res_id == 1036 || res_id == 1033) && data_len >= 28 {
            let format = u32::from_be_bytes([
                imgres[pos],
                imgres[pos + 1],
                imgres[pos + 2],
                imgres[pos + 3],
            ]);
            if format == 1 {
                // 头部 28 字节是元数据，之后是 JPEG 数据
                let jpeg = imgres[pos + 28..pos + data_len].to_vec();
                if !jpeg.is_empty() {
                    return Ok(jpeg);
                }
            }
        }

        // 对齐到偶数字节，跳到下一个 block
        let padded = if !data_len.is_multiple_of(2) {
            data_len + 1
        } else {
            data_len
        };
        pos += padded;
    }

    bail!("No embedded JPEG thumbnail found in PSD (resource 1036/1033 not present or format unsupported)")
}

/// 从 JPEG/PNG 等栅格字节生成 micro + standard WebP，写入 `.nocturne_meta` 并更新 DB。
/// 用于 PSD 内嵌缩略图或 macOS Quick Look 回退。
pub fn ensure_design_preview_from_raster_bytes(
    media_id: &str,
    filepath: &str,
    filename: &str,
    meta_dir: &Path,
    db_path: &str,
    raster_bytes: &[u8],
) -> Option<String> {
    if raster_bytes.is_empty() {
        return None;
    }
    if std::fs::create_dir_all(meta_dir).is_err() {
        return None;
    }

    let img = image::load_from_memory(raster_bytes).ok()?;
    let (width, height) = img.dimensions();
    if width == 0 || height == 0 {
        return None;
    }

    let micro_filename = format!("{}_micro.webp", filename);
    let standard_filename = format!("{}_thumb.webp", filename);
    let micro_dst = meta_dir.join(&micro_filename);
    let standard_dst = meta_dir.join(&standard_filename);

    if generate_micro_thumbnail_from_image(&img, &micro_dst).is_err() || !micro_dst.exists() {
        return None;
    }
    if generate_standard_thumbnail_from_image(&img, &standard_dst).is_err()
        || !standard_dst.exists()
    {
        return None;
    }

    let micro_abs = micro_dst.to_string_lossy().to_string();
    let standard_abs = standard_dst.to_string_lossy().to_string();

    let thumbhash_opt = generate_thumbhash_from_image(&img)
        .ok()
        .filter(|h| !h.is_empty());

    if let Ok(conn) = open_conn(db_path) {
        let _ = crud::update_media_dimensions(&conn, media_id, width as i64, height as i64);
        let _ = update_multi_tier_thumbnails(
            &conn,
            media_id,
            Some(&micro_abs),
            Some(&standard_abs),
            None,
            thumbhash_opt.as_deref(),
        );
    }

    let _ = filepath;
    Some(standard_abs)
}

/// PSD/PSB：内嵌 JPEG → 多档 WebP；失败时用系统 Quick Look（macOS）。
pub fn ensure_psd_design_thumbnails(
    media_id: &str,
    filepath: &str,
    filename: &str,
    meta_dir: &Path,
    db_path: &str,
) -> Option<String> {
    if let Ok(jpeg) = extract_psd_thumbnail_jpeg(filepath) {
        if let Some(path) = ensure_design_preview_from_raster_bytes(
            media_id, filepath, filename, meta_dir, db_path, &jpeg,
        ) {
            return Some(path);
        }
    }

    let legacy_jpg = meta_dir.join(format!("{}_thumb.jpg", filename));
    if legacy_jpg.is_file() {
        if let Ok(bytes) = std::fs::read(&legacy_jpg) {
            if let Some(path) = ensure_design_preview_from_raster_bytes(
                media_id, filepath, filename, meta_dir, db_path, &bytes,
            ) {
                return Some(path);
            }
        }
        let abs = legacy_jpg.to_string_lossy().to_string();
        if let Ok(conn) = open_conn(db_path) {
            let _ = update_multi_tier_thumbnails(&conn, media_id, None, Some(&abs), None, None);
        }
        return Some(abs);
    }

    if let Some(bytes) = crate::media::os_preview::fetch_os_preview_bytes(filepath, 512) {
        return ensure_design_preview_from_raster_bytes(
            media_id, filepath, filename, meta_dir, db_path, &bytes,
        );
    }

    log::warn!(
        "[ensure_psd_design_thumbnails] No preview for {} (no embedded thumb, no legacy jpg, Quick Look failed)",
        filename
    );
    None
}

// ─────────────────────────────────────────────
//  缩略图多档位常量（v5.8 新增）
// ─────────────────────────────────────────────

// Retina 网格更清晰；新导入生效
const MICRO_SIZE: u32 = 640;
const STANDARD_SIZE: u32 = 800;
const PREVIEW_SIZE: u32 = 2048;
const MICRO_WEBP_QUALITY: f32 = 84.0;
const STANDARD_WEBP_QUALITY: f32 = 84.0;
const PREVIEW_WEBP_QUALITY: f32 = 88.0;

// ─────────────────────────────────────────────
//  旧缩略图函数（JPEG，过渡期兼容）
//  TODO v5.9: 逐步迁移旧库缩略图格式为 WebP
// ─────────────────────────────────────────────
//  视频缩略图（ffmpeg 提取第一帧）
// ─────────────────────────────────────────────

/// 判断文件是否为支持的视频格式
pub fn is_video_file(filepath: &str) -> bool {
    let ext = Path::new(filepath)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    matches!(
        ext.as_deref(),
        Some("mp4") | Some("mov") | Some("avi") | Some("mkv") | Some("webm")
    )
}

/// 调用 ffmpeg 在指定时间戳提取单帧到 output 路径
fn try_ffmpeg_extract(input: &str, output: &str, timestamp: &str) -> Result<()> {
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-i",
            input,
            "-ss",
            timestamp,
            "-vframes",
            "1",
            "-vf",
            "scale=800:-1",
            "-q:v",
            "2",
            output,
            "-y",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .context("ffmpeg not found — install ffmpeg and add it to PATH")?;

    if status.success() && Path::new(output).exists() {
        Ok(())
    } else {
        anyhow::bail!(
            "ffmpeg exited with status {:?} or output not created at {}",
            status.code(),
            output
        )
    }
}

/// 用 ffmpeg 提取视频第一帧作为缩略图，保存到 `.nocturne_meta/{filename}_thumb.jpg`。
/// 先尝试 1s 处提取，若失败（短视频）则 fallback 到 0s。
/// ffmpeg 不可用时返回 Err，不 panic，不影响其他文件导入。
pub fn generate_video_thumbnail(media_id: &str, filepath: &str, db_path: &str) -> Result<String> {
    generate_video_thumbnail_with_conn(media_id, filepath, db_path, None)
}

pub fn generate_video_thumbnail_with_conn(
    media_id: &str,
    filepath: &str,
    db_path: &str,
    db_conn: Option<&rusqlite::Connection>,
) -> Result<String> {
    eprintln!(
        "[generate_video_thumbnail] Generating for media_id={}",
        media_id
    );

    let file_path = Path::new(filepath);
    let parent_dir = file_path.parent().unwrap_or(Path::new("."));
    let meta_dir = parent_dir.join(".nocturne_meta");
    let filename = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(media_id);

    std::fs::create_dir_all(&meta_dir)
        .with_context(|| format!("Failed to create .nocturne_meta: {}", meta_dir.display()))?;

    let thumb_filename = format!("{}_thumb.jpg", filename);
    let thumb_path = meta_dir.join(&thumb_filename);
    let thumb_str = thumb_path.to_string_lossy().to_string();

    // 尝试 1s 处提取帧，短视频 fallback 到 0s
    try_ffmpeg_extract(filepath, &thumb_str, "00:00:01")
        .or_else(|_| try_ffmpeg_extract(filepath, &thumb_str, "00:00:00"))
        .context("ffmpeg frame extraction failed for both 1s and 0s timestamps")?;

    eprintln!("[generate_video_thumbnail] Frame extracted: {}", thumb_str);

    // 更新数据库中的缩略图路径
    if let Some(conn) = db_conn {
        crud::update_thumbnail_path(conn, media_id, &thumb_str)
            .context("Failed to update thumbnail_path in DB")?;
    } else if !db_path.is_empty() {
        let conn = open_conn(db_path).context("Failed to open DB in generate_video_thumbnail")?;
        crud::update_thumbnail_path(&conn, media_id, &thumb_str)
            .context("Failed to update thumbnail_path in DB")?;
    }

    // 写入 .nocturne_meta/{filename}.json（视频不含颜色数据）
    let meta = FileMetaJSON {
        file_name: filename.to_string(),
        sha256: None,
        phash: None,
        color_dominant: None,
        thumbnail: format!(".nocturne_meta/{}", thumb_filename),
        tags: None,
        prompt_text: None,
    };
    let json_path = meta_dir.join(format!("{}.json", filename));
    let content = serde_json::to_string_pretty(&meta).context("Failed to serialize meta JSON")?;
    std::fs::write(&json_path, content)
        .with_context(|| format!("Failed to write meta JSON: {}", json_path.display()))?;

    eprintln!("[generate_video_thumbnail] Done: {}", thumb_str);
    Ok(thumb_str)
}

// ─────────────────────────────────────────────
//  缩略图生成核心
// ─────────────────────────────────────────────

/// 生成主缩略图（800px，JPEG q85）
/// 保留旧函数向后兼容——新代码使用 generate_standard_thumbnail
pub fn generate_thumbnail(src: &Path, dst: &Path) -> Result<()> {
    generate_standard_thumbnail(src, dst)
}

/// 生成主缩略图（800px，WebP q80）
pub fn generate_standard_thumbnail(src: &Path, dst: &Path) -> Result<()> {
    let img =
        image::open(src).with_context(|| format!("Failed to open image: {}", src.display()))?;

    let thumb = img.thumbnail(STANDARD_SIZE, STANDARD_SIZE);
    write_webp_thumbnail(&thumb, dst, STANDARD_WEBP_QUALITY, "standard")
}

/// 生成 Preview 档缩略图（2048px，WebP q85）
pub fn generate_preview_thumbnail(src: &Path, dst: &Path) -> Result<()> {
    let img = image::open(src)
        .with_context(|| format!("Failed to open image for preview: {}", src.display()))?;

    generate_preview_thumbnail_from_image(&img, dst)
}

pub fn generate_preview_thumbnail_from_image(img: &DynamicImage, dst: &Path) -> Result<()> {
    let thumb = img.thumbnail(PREVIEW_SIZE, PREVIEW_SIZE);
    write_webp_thumbnail(&thumb, dst, PREVIEW_WEBP_QUALITY, "preview")
}

// ─────────────────────────────────────────────
//  单读管线缩略图生成函数（接受 &DynamicImage，不复读磁盘）
// ─────────────────────────────────────────────

/// 从已加载的 DynamicImage 生成主缩略图（800px，WebP q80）
pub fn generate_standard_thumbnail_from_image(img: &DynamicImage, dst: &Path) -> Result<()> {
    let thumb = img.thumbnail(STANDARD_SIZE, STANDARD_SIZE);
    write_webp_thumbnail(&thumb, dst, STANDARD_WEBP_QUALITY, "standard")
}

// ─────────────────────────────────────────────
//  主色提取
// ─────────────────────────────────────────────

/// 从已加载的 DynamicImage 提取主色（Hex 字符串）
pub fn extract_dominant_color_from_image(img: &DynamicImage) -> Option<String> {
    let small = img.thumbnail(64, 64);
    let rgba = small.to_rgba8();
    let mut color_map: HashMap<u32, usize> = HashMap::new();

    for pixel in rgba.chunks(4) {
        let r = (pixel[0] as u32 / 32) * 32;
        let g = (pixel[1] as u32 / 32) * 32;
        let b = (pixel[2] as u32 / 32) * 32;
        let quantized = (r << 16) | (g << 8) | b;
        *color_map.entry(quantized).or_insert(0) += 1;
    }

    color_map
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(color, _)| {
            let r = (color >> 16) as u8;
            let g = ((color >> 8) & 0xFF) as u8;
            let b = (color & 0xFF) as u8;
            format!("#{:02X}{:02X}{:02X}", r, g, b)
        })
}

/// 从文件提取主色（返回 Vec 兼容旧接口）
pub fn extract_dominant_colors(img: &DynamicImage) -> Vec<String> {
    extract_dominant_color_from_image(img).into_iter().collect()
}

/// 从文件提取主色
pub fn extract_dominant_color(filepath: &str) -> Result<String> {
    let img = image::open(filepath)
        .with_context(|| format!("Failed to open image for color extraction: {}", filepath))?;
    extract_dominant_color_from_image(&img)
        .ok_or_else(|| anyhow::anyhow!("Failed to extract dominant color for: {}", filepath))
}

// ─────────────────────────────────────────────
//  哈希计算（SHA256 + pHash）
// ─────────────────────────────────────────────

/// 计算文件的 SHA256 字节级哈希
pub fn compute_sha256(filepath: &str) -> Result<String> {
    use sha2::{Digest, Sha256};
    let data = std::fs::read(filepath)
        .with_context(|| format!("Failed to read file for SHA256: {}", filepath))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(format!("{:x}", hasher.finalize()))
}

/// 计算图像文件的感知哈希（pHash），用于相似度检测
/// 返回 64-bit 整数哈希值
pub fn compute_phash(filepath: &str) -> Result<i64> {
    let img = image::open(filepath)
        .with_context(|| format!("Failed to open image for pHash: {}", filepath))?;
    Ok(compute_phash_from_image(&img))
}

/// 从已加载的 DynamicImage 计算感知哈希
pub fn compute_phash_from_image(img: &DynamicImage) -> i64 {
    let small = img.thumbnail_exact(32, 32).to_luma8();
    let pixels: Vec<u8> = small.pixels().map(|p| p.0[0]).collect();
    let mean = pixels.iter().map(|&p| p as f64).sum::<f64>() / pixels.len() as f64;

    let mut hash: i64 = 0;
    for (i, &p) in pixels.iter().enumerate() {
        if p as f64 > mean {
            hash |= 1 << i;
        }
    }
    hash
}

/// 计算感知哈希的汉明距离
pub fn hamming_distance(h1: i64, h2: i64) -> u32 {
    (h1 ^ h2).count_ones()
}

/// 检查两个文件是否为重复（字节级 SHA256 + 感知哈希相似度）
pub fn check_duplicate(sha1: &str, phash1: i64, sha2: &str, phash2: i64) -> (bool, bool) {
    let exact = sha1 == sha2;
    let similar = if exact {
        false
    } else {
        hamming_distance(phash1, phash2) <= 3
    };
    (exact, similar)
}

// ─────────────────────────────────────────────
//  缩略图集成生成（扫描时调用）
// ─────────────────────────────────────────────

/// 生成所有缩略图 + 颜色提取（用于旧版扫描路径）
pub fn generate_thumbnail_and_meta(
    media_id: &str,
    filepath: &str,
    db_path: &str,
) -> Result<String> {
    generate_thumbnail_and_meta_with_conn(media_id, filepath, db_path, None)
}

/// 生成缩略图 + 颜色提取（支持已有连接，避免重复打开 DB）
pub fn generate_thumbnail_and_meta_with_conn(
    media_id: &str,
    filepath: &str,
    db_path: &str,
    db_conn: Option<&rusqlite::Connection>,
) -> Result<String> {
    let file_path = Path::new(filepath);
    let parent_dir = file_path.parent().unwrap_or(Path::new("."));
    let meta_dir = parent_dir.join(".nocturne_meta");

    std::fs::create_dir_all(&meta_dir)
        .with_context(|| format!("Failed to create .nocturne_meta: {}", meta_dir.display()))?;

    let img =
        image::open(filepath).with_context(|| format!("Failed to open image: {}", filepath))?;

    let filename = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(media_id);

    if let Ok(conn) = open_conn(db_path) {
        let (width, height) = img.dimensions();
        let _ = crud::update_media_dimensions(&conn, media_id, width as i64, height as i64);
    }

    // 生成主缩略图（800px WebP）
    let standard_filename = format!("{}_thumb.webp", filename);
    let standard_dst = meta_dir.join(&standard_filename);
    let standard_path_abs = standard_dst.to_string_lossy().to_string();

    generate_standard_thumbnail_from_image(&img, &standard_dst)
        .with_context(|| format!("Failed to generate standard thumbnail for {}", filepath))?;

    // 提取主色
    let color_hex = extract_dominant_color_from_image(&img);

    // 更新 DB
    if let Some(conn) = db_conn {
        crud::update_thumbnail_path(conn, media_id, &standard_path_abs)
            .context("Failed to update thumbnail_path")?;
        if let Some(ref color) = color_hex {
            crud::update_color_dominant(conn, media_id, color)
                .context("Failed to update color_dominant")?;
        }
    } else {
        let conn =
            open_conn(db_path).context("Failed to open DB in generate_thumbnail_and_meta")?;
        crud::update_thumbnail_path(&conn, media_id, &standard_path_abs)
            .context("Failed to update thumbnail_path")?;
        if let Some(ref color) = color_hex {
            crud::update_color_dominant(&conn, media_id, color)
                .context("Failed to update color_dominant")?;
        }
    }

    Ok(standard_path_abs)
}

// ─────────────────────────────────────────────
//  嵌入式 JPEG 缩略图提取
// ─────────────────────────────────────────────

/// 从 JPEG EXIF 数据中提取嵌入缩略图（通常 160-320px），不解码原图。
/// 大多数相机拍摄的 JPEG 文件中内嵌了缩略图，读取文件头即可获取，耗时 < 1ms。
/// 相当于 Apple Photos 的 CGImageSourceCreateThumbnailAtIndex。
///
/// NOTE: 当前未启用，等待 kamadak-exif API 适配。
pub fn extract_embedded_jpeg_thumbnail(_filepath: &str) -> Option<Vec<u8>> {
    None
}

/// 尝试用嵌入缩略图生成 micro WebP，比 image::open 原图快 10-100×。
/// 返回 micro 路径（写入成功时）
pub fn generate_micro_from_embedded_thumbnail(_filepath: &str, _dst: &Path) -> Option<String> {
    None
}

// ─────────────────────────────────────────────

/// 生成 Micro 档缩略图（512px 长边，WebP q76）
pub fn generate_micro_thumbnail(src: &Path, dst: &Path) -> Result<()> {
    if src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        == Some("svg".to_string())
    {
        std::fs::copy(src, dst)
            .with_context(|| format!("Failed to copy SVG to: {}", dst.display()))?;
        return Ok(());
    }

    let img = image::open(src).with_context(|| {
        format!(
            "Failed to open image for micro thumbnail: {}",
            src.display()
        )
    })?;

    write_micro_thumbnail(&img, dst)?;
    Ok(())
}

pub fn generate_micro_thumbnail_from_image(img: &DynamicImage, dst: &Path) -> Result<()> {
    write_micro_thumbnail(img, dst)?;
    Ok(())
}

fn write_micro_thumbnail(img: &DynamicImage, dst: &Path) -> Result<bool> {
    let (width, height) = img.dimensions();
    // 原图 ≤ 512px：不经缩放直接编码为 WebP，保证所有图片都有 micro 档
    let thumb = if width <= MICRO_SIZE && height <= MICRO_SIZE {
        img.clone()
    } else {
        img.thumbnail(MICRO_SIZE, MICRO_SIZE)
    };

    write_webp_thumbnail(&thumb, dst, MICRO_WEBP_QUALITY, "micro")?;

    if dst.exists() {
        let metadata = std::fs::metadata(dst)
            .with_context(|| format!("Failed to stat micro thumbnail: {}", dst.display()))?;
        if metadata.len() > 0 {
            return Ok(true);
        }
        eprintln!(
            "[write_micro_thumbnail] micro file exists but is empty: {}",
            dst.display()
        );
    } else {
        eprintln!(
            "[write_micro_thumbnail] micro file missing after write: {}",
            dst.display()
        );
    }

    Ok(false)
}

fn write_webp_thumbnail(thumb: &DynamicImage, dst: &Path, quality: f32, kind: &str) -> Result<()> {
    let rgba = thumb.to_rgba8();
    let encoder = Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
    let memory = encoder.encode(quality);
    let bytes: &[u8] = memory.as_ref();
    if bytes.is_empty() {
        bail!(
            "webp encoder produced empty {} thumbnail for {}",
            kind,
            dst.display()
        );
    }

    std::fs::write(dst, bytes)
        .with_context(|| format!("Failed to write {} thumbnail: {}", kind, dst.display()))?;

    let metadata = std::fs::metadata(dst)
        .with_context(|| format!("Failed to stat {} thumbnail: {}", kind, dst.display()))?;
    if metadata.len() == 0 {
        bail!(
            "{} thumbnail written but file is empty: {}",
            kind,
            dst.display()
        );
    }

    Ok(())
}

// ─────────────────────────────────────────────
//  ThumbHash 模糊哈希（用于瞬时占位）
// ─────────────────────────────────────────────

/// 生成 ThumbHash（Base64 编码字符串，用于模糊占位）
pub fn generate_thumbhash(src: &Path) -> Result<String> {
    // 视频 → 返回空（视频帧的 thumbhash 在 ffmpeg 提取帧后再处理，当前先跳过）
    if crate::media::thumbnail::is_video_file(src.to_string_lossy().as_ref()) {
        return Ok(String::new());
    }

    let img = image::open(src)
        .with_context(|| format!("Failed to open image for thumbhash: {}", src.display()))?;

    generate_thumbhash_from_image(&img)
}

pub fn generate_thumbhash_from_image(img: &DynamicImage) -> Result<String> {
    // 缩放到 100x100 以内（ThumbHash 推荐尺寸）
    let thumb = img.thumbnail(100, 100);
    let rgba = thumb.to_rgba8();
    let (width, height) = rgba.dimensions();

    // 使用 fast-thumbhash 库编码
    let hash_bytes = fast_thumbhash::rgba_to_thumb_hash(width as usize, height as usize, &rgba);

    // 转换为 Base64 字符串（便于存储在数据库中）
    use base64::{engine::general_purpose, Engine as _};
    Ok(general_purpose::STANDARD.encode(&hash_bytes))
}

/// 更新数据库中的多档缩略图路径
pub fn update_multi_tier_thumbnails(
    conn: &rusqlite::Connection,
    media_id: &str,
    micro_path: Option<&str>,
    standard_path: Option<&str>,
    preview_path: Option<&str>,
    thumbhash: Option<&str>,
) -> Result<()> {
    let thumbhash = thumbhash.filter(|hash| !hash.is_empty());
    if micro_path.is_none()
        && standard_path.is_none()
        && preview_path.is_none()
        && thumbhash.is_none()
    {
        return Ok(());
    }

    log::debug!(
        "[update_multi_tier] EXECUTING UPDATE for id={} micro={:?} thumbhash={:?}",
        media_id,
        micro_path,
        thumbhash.as_ref().map(|h| &h[..8.min(h.len())])
    );
    let rows = conn
        .execute(
            "UPDATE media_files
         SET thumbnail_micro_path = COALESCE(?1, thumbnail_micro_path),
             thumbnail_path = COALESCE(?2, thumbnail_path),
             thumbnail_preview_path = COALESCE(?3, thumbnail_preview_path),
             thumbhash = COALESCE(?4, thumbhash)
         WHERE id = ?5",
            rusqlite::params![micro_path, standard_path, preview_path, thumbhash, media_id],
        )
        .with_context(|| "Failed to update multi-tier thumbnail fields in DB")?;
    log::debug!(
        "[update_multi_tier] rows_affected={} for id={}",
        rows,
        media_id
    );

    Ok(())
}
