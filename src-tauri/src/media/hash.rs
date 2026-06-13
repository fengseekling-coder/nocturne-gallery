//! Gega Gallery — 图像哈希计算
//!
//! 双重验证：
//! 1. SHA256 文件哈希（字节级完全相同 → 直接判定重复）
//! 2. pHash 感知哈希（视觉内容几乎一致 → 汉明距离 ≤ 3 判定重复）

use image::{imageops, GrayImage};
use sha2::{Digest, Sha256};
use std::path::Path;

/// SHA256 文件哈希（十六进制字符串）
pub fn compute_sha256(file_path: &str) -> Result<String, String> {
    let data =
        std::fs::read(file_path).map_err(|e| format!("Failed to read file for SHA256: {}", e))?;
    Ok(compute_sha256_from_bytes(&data))
}

/// 流式 SHA256 —— 64KB 分块读取，适用于 PSD/AI 等 GB 级设计文件，不撑爆内存。
/// 直接用裸 File + 手动 buf，避免 BufReader 双缓冲冗余。
pub fn compute_sha256_streaming(file_path: &str) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(file_path).map_err(|e| {
        log::warn!(
            "[hash] compute_sha256_streaming open failed for '{}': {}",
            file_path,
            e
        );
        format!("Failed to open file for streaming SHA256: {}", e)
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            log::warn!(
                "[hash] compute_sha256_streaming read failed for '{}': {}",
                file_path,
                e
            );
            format!("Failed to read chunk for SHA256: {}", e)
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// SHA256 from already-loaded bytes — 避免重复读文件
pub fn compute_sha256_from_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// pHash 感知哈希（64 位整数）——从文件路径加载图片后委托给 compute_phash_from_image。
pub fn compute_phash(image_path: &str) -> Result<u64, String> {
    let img = image::open(Path::new(image_path))
        .map_err(|e| format!("Failed to load image for pHash: {}", e))?;
    compute_phash_from_image(&img)
}

/// pHash 感知哈希——直接从已加载的 DynamicImage 计算，避免重复解码。
///
/// 算法：可分离 2D DCT（O(N·M) vs 朴素 O(N²·M²)，约快 8x）
/// 1. 缩放到 32×32（Triangle 滤波，比 Lanczos3 快 5x 且 pHash 精度损失极小）
/// 2. 转灰度
/// 3. 行 DCT（每行保留前 8 个系数）→ 列 DCT（每列保留前 8 个系数）
/// 4. 取左上角 8×8 低频矩阵，与 AC 均值比较，生成 64 位哈希
#[allow(clippy::needless_range_loop)]
pub fn compute_phash_from_image(img: &image::DynamicImage) -> Result<u64, String> {
    // Triangle 滤波速度约为 Lanczos3 的 5 倍，对 8×8 DCT 精度影响可忽略
    let resized = imageops::resize(img, 32, 32, imageops::FilterType::Triangle);
    let gray: GrayImage = imageops::grayscale(&resized);

    // 提取像素为 f32（比 f64 快，精度对 pHash 足够）
    let mut pixels = [[0.0f32; 32]; 32];
    for y in 0..32usize {
        for x in 0..32usize {
            pixels[y][x] = gray.get_pixel(x as u32, y as u32).0[0] as f32;
        }
    }

    // Phase 1：对每行做 1D DCT，只保留前 8 个系数
    let mut row_dct = [[0.0f32; 8]; 32];
    for y in 0..32usize {
        for u in 0..8usize {
            let mut sum = 0.0f32;
            for x in 0..32usize {
                sum += pixels[y][x]
                    * f32::cos(std::f32::consts::PI * (2 * x + 1) as f32 * u as f32 / 64.0);
            }
            row_dct[y][u] = sum;
        }
    }

    // Phase 2：对每列（u 维度）做 1D DCT，只保留前 8 行 → 最终 8×8 DCT 矩阵
    let mut dct2d = [[0.0f32; 8]; 8];
    for v in 0..8usize {
        for u in 0..8usize {
            let mut sum = 0.0f32;
            for y in 0..32usize {
                sum += row_dct[y][u]
                    * f32::cos(std::f32::consts::PI * (2 * y + 1) as f32 * v as f32 / 64.0);
            }
            dct2d[v][u] = sum;
        }
    }

    // 展开为线性数组，跳过 DC 系数 (0,0)，计算 AC 均值
    let mut coeffs = [0.0f32; 64];
    let mut ac_sum = 0.0f32;
    for v in 0..8usize {
        for u in 0..8usize {
            let i = v * 8 + u;
            coeffs[i] = dct2d[v][u];
            if i > 0 {
                ac_sum += dct2d[v][u];
            }
        }
    }
    let ac_mean = ac_sum / 63.0;

    // 生成 64 位哈希：每个 AC 系数与均值比较
    let mut hash: u64 = 0;
    for i in 1..64usize {
        if coeffs[i] > ac_mean {
            hash |= 1u64 << (i - 1);
        }
    }

    Ok(hash)
}

/// 汉明距离：两个 pHash 之间的位数差异
pub fn hamming_distance(hash1: u64, hash2: u64) -> u32 {
    (hash1 ^ hash2).count_ones()
}

/// 计算相似度百分比（基于汉明距离）
/// 距离 0 = 100% 相同，距离 64 = 0% 相同
pub fn similarity_score(hash1: u64, hash2: u64) -> f32 {
    let distance = hamming_distance(hash1, hash2);
    (1.0 - distance as f32 / 64.0) * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hamming_distance() {
        assert_eq!(hamming_distance(0, 0), 0);
        assert_eq!(hamming_distance(0, u64::MAX), 64);
        assert_eq!(hamming_distance(0b1111, 0b1110), 1);
    }

    #[test]
    fn test_similarity_score() {
        assert_eq!(similarity_score(0, 0), 100.0);
        assert!((similarity_score(0, u64::MAX) - 0.0).abs() < 0.01);
    }

    #[test]
    fn test_sha256_deterministic() {
        // 创建临时文件测试 SHA256
        let tmp = std::env::temp_dir().join("test_sha256.txt");
        std::fs::write(&tmp, "hello world").unwrap();
        let hash1 = compute_sha256(tmp.to_str().unwrap()).unwrap();
        let hash2 = compute_sha256(tmp.to_str().unwrap()).unwrap();
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64); // SHA256 hex = 64 chars
        let _ = std::fs::remove_file(&tmp);
    }
}
