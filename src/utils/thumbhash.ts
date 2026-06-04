import { thumbHashToDataURL as decodeThumbHash } from 'thumbhash';

const MAX_CACHE_SIZE = 2000;
const hashCache = new Map<string, string>();
const dataUrlCache = new Map<string, string>();
const MAX_DATA_URL_CACHE_SIZE = 128;

function rememberDataUrl(key: string, value: string): void {
  dataUrlCache.set(key, value);
  if (dataUrlCache.size <= MAX_DATA_URL_CACHE_SIZE) return;
  const oldest = dataUrlCache.keys().next().value;
  if (oldest) dataUrlCache.delete(oldest);
}

export function decodeThumbHashBase64(hash: string): string {
  const cached = hashCache.get(hash);
  if (cached) {
    hashCache.delete(hash);
    hashCache.set(hash, cached);
    return cached;
  }

  const binaryString = atob(hash);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const dataUrl = decodeThumbHash(bytes);
  if (hashCache.size >= MAX_CACHE_SIZE) {
    const firstKey = hashCache.keys().next().value as string | undefined;
    if (firstKey) {
      hashCache.delete(firstKey);
    }
  }
  hashCache.set(hash, dataUrl);
  return dataUrl;
}

/**
 * Decodes a thumbhash (Base64 string) into a data URL (data:image/png;base64,...)
 * using a local LRU cache to prevent re-decoding.
 */
export function thumbHashToDataURL(hash: string): string {
  try {
    const cached = dataUrlCache.get(hash);
    if (cached) {
      dataUrlCache.delete(hash);
      dataUrlCache.set(hash, cached);
      return cached;
    }

    const dataUrl = decodeThumbHashBase64(hash);
    rememberDataUrl(hash, dataUrl);
    return dataUrl;
  } catch (err) {
    console.error('Failed to decode thumbhash:', err);
    return fallbackPlaceholder();
  }
}

export function fallbackPlaceholder(): string {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
}
