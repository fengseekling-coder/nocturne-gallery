/**
 * 大图：Preview 档先显 → 延迟后解码原图（可 abort）。与 FullScreenPreview 行为一致。
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { getAssetUrl } from './thumbnailCache';

export interface FullResolutionLoadOptions {
  previewDiskPath: string | null;
  originalDiskPath: string;
  delayBeforeOriginalMs?: number;
  onDisplayPathChange: (diskPath: string) => void;
  onLoadingOriginalChange: (loading: boolean) => void;
}

export function loadFullResolutionSequence(options: FullResolutionLoadOptions): () => void {
  const {
    previewDiskPath,
    originalDiskPath,
    delayBeforeOriginalMs = 120,
    onDisplayPathChange,
    onLoadingOriginalChange,
  } = options;

  const abort = new AbortController();
  const { signal } = abort;

  const initial = previewDiskPath?.trim() ? previewDiskPath.trim() : originalDiskPath;
  onDisplayPathChange(initial);

  if (!previewDiskPath?.trim() || previewDiskPath.trim() === originalDiskPath) {
    onLoadingOriginalChange(false);
    return () => abort.abort();
  }

  onLoadingOriginalChange(true);

  const timer = window.setTimeout(() => {
    if (signal.aborted) return;

    void (async () => {
      try {
        const img = new Image();
        img.decoding = 'async';
        const src = convertFileSrc(originalDiskPath);
        const loaded = new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('original decode failed'));
        });
        img.src = src;
        await loaded;
        if (signal.aborted) return;
        if (typeof img.decode === 'function') {
          try {
            await img.decode();
          } catch {
            /* decode optional */
          }
        }
        if (signal.aborted) return;
        onDisplayPathChange(originalDiskPath);
        onLoadingOriginalChange(false);
      } catch {
        if (!signal.aborted) onLoadingOriginalChange(false);
      }
    })();
  }, delayBeforeOriginalMs);

  return () => {
    abort.abort();
    window.clearTimeout(timer);
    onLoadingOriginalChange(false);
  };
}

/** 将磁盘路径转为可展示的 asset URL */
export function resolveDisplaySrc(diskPath: string): string {
  return diskPath ? getAssetUrl(diskPath) : '';
}