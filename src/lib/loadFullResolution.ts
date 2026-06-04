/**
 * Preview → 原图：延迟拉原图 + 可取消 + decode()。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { getAssetUrl } from './thumbnailCache';

export interface LoadFullResolutionOptions {
  imagePath: string;
  thumbnailPreviewPath?: string | null;
  originalDelayMs?: number;
  signal?: AbortSignal;
  onDisplayPathChange: (diskPath: string) => void;
  onLoadingOriginalChange?: (loading: boolean) => void;
}

export function loadFullResolution(options: LoadFullResolutionOptions): () => void {
  const {
    imagePath,
    thumbnailPreviewPath,
    originalDelayMs = 120,
    signal,
    onDisplayPathChange,
    onLoadingOriginalChange,
  } = options;

  let cancelled = false;
  const abortListeners: Array<() => void> = [];

  const cleanup = () => {
    cancelled = true;
    for (const off of abortListeners) off();
    abortListeners.length = 0;
  };

  if (signal) {
    if (signal.aborted) {
      cleanup();
      return cleanup;
    }
    const onAbort = () => cleanup();
    signal.addEventListener('abort', onAbort);
    abortListeners.push(() => signal.removeEventListener('abort', onAbort));
  }

  const initial = thumbnailPreviewPath?.trim() || imagePath;
  onDisplayPathChange(initial);

  if (initial === imagePath) {
    onLoadingOriginalChange?.(false);
    return cleanup;
  }

  onLoadingOriginalChange?.(true);

  const timer = window.setTimeout(() => {
    if (cancelled) return;

    const img = new Image();
    img.decoding = 'async';
    img.src = convertFileSrc(imagePath);

    const finish = (ok: boolean) => {
      if (cancelled) return;
      if (ok) onDisplayPathChange(imagePath);
      onLoadingOriginalChange?.(false);
    };

    img.onload = () => {
      if (cancelled) return;
      if (typeof img.decode === 'function') {
        void img.decode().then(() => finish(true)).catch(() => finish(true));
      } else {
        finish(true);
      }
    };
    img.onerror = () => finish(false);

    abortListeners.push(() => {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    });
  }, originalDelayMs);

  abortListeners.push(() => window.clearTimeout(timer));
  return cleanup;
}

export function resolveDisplaySrc(diskPath: string): string {
  if (!diskPath) return '';
  if (/^https?:\/\//i.test(diskPath) || /^asset:\/\//i.test(diskPath) || /^data:/i.test(diskPath)) {
    return diskPath;
  }
  return getAssetUrl(diskPath);
}
