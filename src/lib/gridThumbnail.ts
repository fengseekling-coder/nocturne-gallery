/**
 * 网格缩略图路径：Retina 优先 Standard(800)。
 */
import type { MediaFile } from '../types/media';

function trimPath(path: string | null | undefined): string | null {
  const t = path?.trim();
  return t && t.length > 0 ? t : null;
}

/** DB 未写路径时，按源文件同目录 `.nocturne_meta` 约定推断（作品集 PSD 常见） */
function inferSidecarThumbnailPaths(file: MediaFile): {
  micro: string | null;
  standard: string | null;
  preview: string | null;
} {
  const filepath = trimPath(file.filepath);
  const filename = file.filename?.trim();
  if (!filepath || !filename) {
    return { micro: null, standard: null, preview: null };
  }
  const sep = filepath.includes('\\') ? '\\' : '/';
  const lastSep = Math.max(filepath.lastIndexOf('/'), filepath.lastIndexOf('\\'));
  const dir = lastSep >= 0 ? filepath.slice(0, lastSep) : filepath;
  const meta = `${dir}${sep}.nocturne_meta`;
  return {
    micro: `${meta}${sep}${filename}_micro.webp`,
    standard: `${meta}${sep}${filename}_thumb.webp`,
    preview: `${meta}${sep}${filename}_preview.webp`,
  };
}

/** 网格可尝试的缩略图路径（去重、按优先级），用于错误时轮换而非重复加载同一路径 */
export function listGridThumbnailCandidatePaths(file: MediaFile): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (path: string | null) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  const micro = trimPath(file.thumbnailMicroPath);
  const standard = trimPath(file.thumbnailPath);
  const preview = trimPath(file.thumbnailPreviewPath);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  if (dpr >= 2) {
    push(standard);
    push(micro);
    push(preview);
  } else {
    push(micro);
    push(standard);
    push(preview);
  }

  if (file.filetype === 'design' || file.filetype === 'document') {
    const sidecar = inferSidecarThumbnailPaths(file);
    if (dpr >= 2) {
      push(sidecar.standard);
      push(sidecar.micro);
      push(sidecar.preview);
    } else {
      push(sidecar.micro);
      push(sidecar.standard);
      push(sidecar.preview);
    }
  }

  const filepath = trimPath(file.filepath);
  if (filepath && (file.filetype === 'image' || file.filetype === 'video')) {
    push(filepath);
  }

  return out;
}

export function pickGridThumbnailPath(
  file: MediaFile,
  excludePaths?: ReadonlySet<string>,
): string | null {
  const candidates = listGridThumbnailCandidatePaths(file);
  if (excludePaths?.size) {
    const viable = candidates.find((p) => !excludePaths.has(p));
    if (viable) return viable;
  } else if (candidates.length > 0) {
    return candidates[0];
  }

  const legacyStandard = trimPath(file.thumbnailPath);
  if (
    legacyStandard
    && (file.filetype === 'design' || file.filetype === 'document')
    && !excludePaths?.has(legacyStandard)
  ) {
    return legacyStandard;
  }

  return null;
}

/** 属性面板 / 检查器预览：与网格相同的路径优先级，含 micro 与原图回退 */
export function pickInspectorThumbnailPath(file: MediaFile): string | null {
  return pickGridThumbnailPath(file);
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
