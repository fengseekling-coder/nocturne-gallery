/**
 * 大图：Preview 先显，延迟后解码原文件（可 abort）。与 FullScreenPreview 行为一致。
 */

import { convertFileSrc } from '@tauri-apps/api/core';

const ORIGINAL_LOAD_DELAY_MS = 120;

export type FullResolutionLoadOptions = {
  previewPath: string | null;
  originalPath: string;
  onDisplayPath: (diskPath: string) => void;
  onLoadingOriginal: (loading: boolean) => void;
};

export function loadFullResolutionImage(options: FullResolutionLoadOptions): () => void {
  const { previewPath, originalPath, onDisplayPath, onLoadingOriginal } = options;

  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let img: HTMLImageElement | null = null;

  const cleanupImg = () => {
    if (img) {
      img.onload = null;
      img.onerror = null;
      img.src = '';
      img = null;
    }
  };

  const initial = previewPath?.trim() ? previewPath.trim() : originalPath;
  onDisplayPath(initial);

  if (!previewPath?.trim() || previewPath.trim() === originalPath) {
    onLoadingOriginal(false);
    return () => {
      aborted = true;
      if (timer) clearTimeout(timer);
      cleanupImg();
    };
  }

  onLoadingOriginal(true);

  timer = setTimeout(() => {
    if (aborted) return;
    img = new Image();
    img.decoding = 'async';
    img.src = convertFileSrc(originalPath);
    img.onload = () => {
      if (!aborted) {
        onDisplayPath(originalPath);
        onLoadingOriginal(false);
      }
    };
    img.onerror = () => {
      if (!aborted) {
        onLoadingOriginal(false);
      }
    };
  }, ORIGINAL_LOAD_DELAY_MS);

  return () => {
    aborted = true;
    if (timer) clearTimeout(timer);
    cleanupImg();
    onLoadingOriginal(false);
  };
}