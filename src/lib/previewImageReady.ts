/**
 * 预览图预解码：与网格共用 getAssetUrl 缓存，减少大图预览首帧空白。
 */
import { getAssetUrl } from './thumbnailCache';

const decodedUrlCache = new Set<string>();
const inflight = new Map<string, Promise<boolean>>();

export function preloadPreviewAssetUrl(assetUrl: string): Promise<boolean> {
  const url = assetUrl.trim();
  if (!url) return Promise.resolve(false);
  if (decodedUrlCache.has(url)) return Promise.resolve(true);

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = new Promise<boolean>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    let settled = false;

    const finishOk = () => {
      if (settled) return;
      settled = true;
      decodedUrlCache.add(url);
      inflight.delete(url);
      resolve(true);
    };

    const finishFail = () => {
      if (settled) return;
      settled = true;
      inflight.delete(url);
      resolve(false);
    };

    const decodeAndFinish = () => {
      if (typeof img.decode === 'function') {
        void img.decode().then(finishOk).catch(finishFail);
      } else {
        finishOk();
      }
    };

    img.onload = decodeAndFinish;
    img.onerror = finishFail;
    img.src = url;

    if (img.complete && img.naturalWidth > 0) {
      decodeAndFinish();
    }
  });

  inflight.set(url, promise);
  return promise;
}

export function preloadPreviewDiskPath(diskPath: string): Promise<boolean> {
  const path = diskPath.trim();
  if (!path) return Promise.resolve(false);
  return preloadPreviewAssetUrl(getAssetUrl(path));
}

export function markPreviewAssetDecoded(assetUrl: string): void {
  const url = assetUrl.trim();
  if (url) decodedUrlCache.add(url);
}