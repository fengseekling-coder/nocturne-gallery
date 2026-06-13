import { invoke } from '@tauri-apps/api/core';
import type { MediaFile } from '../types/media';

/** 与 Rust `design_source` 对齐：需要源预览的扩展名 */
export const DESIGN_SOURCE_EXTENSIONS = [
  'psd', 'psb', 'ai', 'sketch', 'fig', 'xd', 'indd', 'afdesign', 'afphoto',
] as const;

export const DOCUMENT_PREVIEW_EXTENSIONS = ['pdf', 'eps'] as const;

const ALL_SOURCE_PREVIEW_EXTS = new Set<string>([
  ...DESIGN_SOURCE_EXTENSIONS,
  ...DOCUMENT_PREVIEW_EXTENSIONS,
]);

/** 网格/属性面板可用的 WebP 多档缩略图是否齐全 */
function hasModernThumbnailTiers(file: MediaFile): boolean {
  const micro = file.thumbnailMicroPath?.trim();
  if (micro) return true;
  const standard = file.thumbnailPath?.trim();
  if (standard && /\.webp$/i.test(standard)) return true;
  const preview = file.thumbnailPreviewPath?.trim();
  if (preview && /\.webp$/i.test(preview)) return true;
  return false;
}

export function needsDesignPreviewBackfill(file: MediaFile): boolean {
  if (hasModernThumbnailTiers(file)) return false;
  const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
  if (file.filetype === 'design') return true;
  if (file.filetype === 'document' && ALL_SOURCE_PREVIEW_EXTS.has(ext)) return true;
  return ALL_SOURCE_PREVIEW_EXTS.has(ext);
}

/** 选中/聚焦时也应尝试补预览（含仅有 legacy _thumb.jpg 的情况） */
export function shouldAttemptDesignPreviewOnFocus(file: MediaFile): boolean {
  return needsDesignPreviewBackfill(file);
}

const inflight = new Map<string, Promise<MediaFile | null>>();

/** 后台补 PSD/设计文件缩略图；成功时返回更新后的 MediaFile */
export function ensureDesignPreviewThumbnails(mediaId: string): Promise<MediaFile | null> {
  const existing = inflight.get(mediaId);
  if (existing) return existing;

  const promise = invoke<MediaFile | null>('ensure_media_preview_thumbnails', { mediaId })
    .catch(() => null)
    .finally(() => {
      if (inflight.get(mediaId) === promise) inflight.delete(mediaId);
    });

  inflight.set(mediaId, promise);
  return promise;
}

export async function fetchShellPreviewDataUrl(filepath: string, size = 512): Promise<string | null> {
  try {
    const result = await invoke<string | null>('get_attachment_preview_data', { path: filepath, size });
    return result?.trim() || null;
  } catch {
    return null;
  }
}

export type DesignPreviewBackfillCallbacks = {
  onShellPreview: (dataUrl: string) => void;
  onDiskPath: (diskPath: string) => void;
  onUpdatedFile: (file: MediaFile) => void;
};

/** 单次补全：invoke 后端 + 可选 Quick Look data URL */
export function runDesignPreviewBackfill(
  file: MediaFile,
  callbacks: DesignPreviewBackfillCallbacks,
): void {
  if (!needsDesignPreviewBackfill(file)) return;

  if (import.meta.env.DEV) {
    console.info('[designPreview] backfill start', file.id, file.filename);
  }

  void ensureDesignPreviewThumbnails(file.id).then((updated) => {
    if (updated) {
      callbacks.onUpdatedFile(updated);
      return;
    }
    void fetchShellPreviewDataUrl(file.filepath, 512).then((url) => {
      if (url) callbacks.onShellPreview(url);
    });
  });
}