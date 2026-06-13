/**
 * Preview → preview 档 → 原图：分阶段升级，首帧始终用可显示的缩略图路径。
 */
import { getAssetUrl } from './thumbnailCache';
import { preloadPreviewDiskPath } from './previewImageReady';

export interface LoadFullResolutionOptions {
  imagePath: string;
  thumbnailPreviewPath?: string | null;
  /** 进入预览时立即展示的路径（micro/standard 等） */
  initialDiskPath?: string | null;
  /** 缩略图之后的中间档（通常为 thumbnail_preview_path） */
  upgradeDiskPath?: string | null;
  originalDelayMs?: number;
  upgradeDelayMs?: number;
  signal?: AbortSignal;
  onDisplayPathChange: (diskPath: string) => void;
  onLoadingOriginalChange?: (loading: boolean) => void;
}

function norm(path: string | null | undefined): string {
  const t = path?.trim();
  return t && t.length > 0 ? t : '';
}

export function loadFullResolution(options: LoadFullResolutionOptions): () => void {
  const {
    imagePath,
    thumbnailPreviewPath,
    initialDiskPath,
    upgradeDiskPath,
    originalDelayMs = 480,
    upgradeDelayMs = 120,
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

  const original = norm(imagePath);
  const upgrade =
    norm(upgradeDiskPath)
    || norm(thumbnailPreviewPath);
  const initial =
    norm(initialDiskPath)
    || upgrade
    || original;

  onDisplayPathChange(initial);

  const needsUpgrade = upgrade && upgrade !== initial;
  const needsOriginal = original && original !== initial && original !== upgrade;

  if (!needsUpgrade && !needsOriginal) {
    onLoadingOriginalChange?.(false);
    void preloadPreviewDiskPath(initial);
    return cleanup;
  }

  onLoadingOriginalChange?.(true);

  const upgradeTimer = window.setTimeout(() => {
    if (cancelled || !needsUpgrade) return;

    void preloadPreviewDiskPath(upgrade).then((ok) => {
      if (cancelled) return;
      if (ok) {
        onDisplayPathChange(upgrade);
      }
      if (!needsOriginal) {
        onLoadingOriginalChange?.(false);
      }
    });
  }, upgradeDelayMs);

  abortListeners.push(() => window.clearTimeout(upgradeTimer));

  if (needsOriginal) {
    const originalTimer = window.setTimeout(() => {
      if (cancelled) return;

      void preloadPreviewDiskPath(original).then((ok) => {
        if (cancelled) return;
        if (ok) {
          onDisplayPathChange(original);
        }
        onLoadingOriginalChange?.(false);
      });
    }, originalDelayMs);

    abortListeners.push(() => window.clearTimeout(originalTimer));
  }

  return cleanup;
}

export function resolveDisplaySrc(diskPath: string): string {
  if (!diskPath) return '';
  if (/^https?:\/\//i.test(diskPath) || /^asset:\/\//i.test(diskPath) || /^data:/i.test(diskPath)) {
    return diskPath;
  }
  return getAssetUrl(diskPath);
}