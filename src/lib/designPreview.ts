import { invoke } from '@tauri-apps/api/core';
import type { MediaFile } from '../types/media';
import { pickGridThumbnailPath } from './gridThumbnail';

/** 与 Rust `design_source` 对齐：需要源预览的扩展名 */
export const DESIGN_SOURCE_EXTENSIONS = [
  'psd', 'psb', 'ai', 'sketch', 'fig', 'xd', 'indd', 'afdesign', 'afphoto',
] as const;

export const DOCUMENT_PREVIEW_EXTENSIONS = ['pdf', 'eps'] as const;

const ALL_SOURCE_PREVIEW_EXTS = new Set<string>([
  ...DESIGN_SOURCE_EXTENSIONS,
  ...DOCUMENT_PREVIEW_EXTENSIONS,
]);

function trimPath(path: string | null | undefined): string | null {
  const t = path?.trim();
  return t && t.length > 0 ? t : null;
}

export function hasModernWebpThumbnailTiers(file: MediaFile): boolean {
  const micro = trimPath(file.thumbnailMicroPath);
  if (micro) return true;
  const standard = trimPath(file.thumbnailPath);
  if (standard && /\.webp$/i.test(standard)) return true;
  const preview = trimPath(file.thumbnailPreviewPath);
  if (preview && /\.webp$/i.test(preview)) return true;
  return false;
}

export function isDesignSourceLikeFile(file: MediaFile): boolean {
  const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
  if (file.filetype === 'design') return true;
  if (file.filetype === 'document' && ALL_SOURCE_PREVIEW_EXTS.has(ext)) return true;
  return ALL_SOURCE_PREVIEW_EXTS.has(ext);
}

export function needsDesignPreviewBackfill(file: MediaFile): boolean {
  if (hasModernWebpThumbnailTiers(file)) return false;
  return isDesignSourceLikeFile(file);
}

export function shouldAttemptDesignPreviewOnFocus(file: MediaFile): boolean {
  return needsDesignPreviewBackfill(file);
}

const inflight = new Map<string, Promise<MediaFile | null>>();

export function ensureDesignPreviewThumbnails(mediaId: string): Promise<MediaFile | null> {
  const existing = inflight.get(mediaId);
  if (existing) return existing;

  const promise = invoke<MediaFile | null>('ensure_media_preview_thumbnails', { mediaId })
    .catch((err) => {
      if (import.meta.env.DEV) {
        console.warn('[designPreview] ensure_media_preview_thumbnails failed', mediaId, err);
      }
      return null;
    })
    .finally(() => {
      if (inflight.get(mediaId) === promise) inflight.delete(mediaId);
    });

  inflight.set(mediaId, promise);
  return promise;
}

export async function fetchShellPreviewDataUrl(filepath: string, size = 512): Promise<string | null> {
  const path = filepath?.trim();
  if (!path) return null;
  try {
    const result = await invoke<string | null>('get_attachment_preview_data', { path, size });
    const url = result?.trim() || null;
    if (import.meta.env.DEV && !url) {
      console.info('[designPreview] shell preview empty for', path);
    }
    return url;
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn('[designPreview] get_attachment_preview_data failed', path, err);
    }
    return null;
  }
}

export type DesignPreviewBackfillCallbacks = {
  onShellPreview: (dataUrl: string) => void;
  onDiskPath: (diskPath: string) => void;
  onUpdatedFile: (file: MediaFile) => void;
};

export async function finishDesignPreviewBackfill(
  prior: MediaFile,
  updated: MediaFile | null,
  callbacks: DesignPreviewBackfillCallbacks,
): Promise<void> {
  const merged = updated ?? prior;

  if (updated) {
    callbacks.onUpdatedFile(updated);
  }

  if (!needsDesignPreviewBackfill(merged)) {
    const diskPath = pickGridThumbnailPath(merged);
    if (diskPath) {
      callbacks.onDiskPath(diskPath);
    }
  }
}

/** Quick Look 先出图，同时后台写 sidecar / DB */
export function runDesignPreviewBackfill(
  file: MediaFile,
  callbacks: DesignPreviewBackfillCallbacks,
): void {
  if (!needsDesignPreviewBackfill(file)) return;

  const shellPath = file.filepath?.trim();
  if (import.meta.env.DEV) {
    console.info('[designPreview] backfill start', file.id, file.filename, shellPath);
  }

  if (shellPath) {
    void fetchShellPreviewDataUrl(shellPath, 512).then((url) => {
      if (url) {
        callbacks.onShellPreview(url);
      }
    });
  }

  void ensureDesignPreviewThumbnails(file.id).then(async (updated) => {
    await finishDesignPreviewBackfill(file, updated, callbacks);
    const merged = updated ?? file;
    if (needsDesignPreviewBackfill(merged) && shellPath) {
      const url = await fetchShellPreviewDataUrl(shellPath, 512);
      if (url) {
        callbacks.onShellPreview(url);
      }
    }
  });
}

