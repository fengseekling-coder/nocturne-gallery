/**
 * 网格缩略图路径：Retina 优先 Standard(800)。
 */
import type { MediaFile } from '../types/media';

function trimPath(path: string | null | undefined): string | null {
  const t = path?.trim();
  return t && t.length > 0 ? t : null;
}

export function pickGridThumbnailPath(file: MediaFile): string | null {
  const micro = trimPath(file.thumbnailMicroPath);
  const standard = trimPath(file.thumbnailPath);
  const preview = trimPath(file.thumbnailPreviewPath);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  if (dpr >= 2) {
    return standard ?? micro ?? preview;
  }
  return micro ?? standard ?? preview;
}

export function pickGridUpgradePath(file: MediaFile, currentDiskPath: string | null): string | null {
  const standard = trimPath(file.thumbnailPath);
  const preview = trimPath(file.thumbnailPreviewPath);
  if (!standard && !preview) return null;
  if (currentDiskPath === preview) return null;
  if (currentDiskPath === standard) {
    return preview && preview !== standard ? preview : null;
  }
  return standard ?? preview;
}
