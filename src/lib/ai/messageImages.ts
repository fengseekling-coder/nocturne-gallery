import { convertFileSrc, invoke } from '@tauri-apps/api/core';

import type { ImageAttachment, Message } from './types';
import type { MediaDetail, MediaFile } from '../../types/media';

interface ResolvedMessageImage {
  data: string;
  mimeType: string;
}

export type MessageImageMediaLookup = {
  findMediaById: (mediaId: string) => MediaFile | MediaDetail | null | undefined;
  findMediaByPath: (filepath: string) => MediaFile | MediaDetail | null | undefined;
  resolveLegacyPath?: (filepath: string) => string | undefined;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

const URL_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const WINDOWS_PATH_PATTERN = /^[a-zA-Z]:\\/;
const UNC_PATH_PATTERN = /^\\\\/;
const DATA_URL_PREFIX = 'data:';
const BLOB_URL_PREFIX = 'blob:';
const ASSET_URL_PATTERN = /^asset:/i;
const ASSET_LOCALHOST_PATTERN = /^https?:\/\/asset\.localhost\//i;

const getMimeTypeFromFilename = (filename?: string): string => {
  if (!filename) return 'image/jpeg';
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'image/jpeg';
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const parseDataUrl = (url: string): ResolvedMessageImage | null => {
  if (!url.startsWith(DATA_URL_PREFIX)) return null;
  const commaIndex = url.indexOf(',');
  if (commaIndex < 0) return null;

  const header = url.slice(0, commaIndex);
  const data = url.slice(commaIndex + 1).trim();
  if (!data) return null;

  const mediaTypeMatch = header.match(/^data:([^;]+);base64$/i);
  return {
    data,
    mimeType: mediaTypeMatch?.[1] || 'image/jpeg',
  };
};

const isInlineUrl = (value: string): boolean =>
  value.startsWith(DATA_URL_PREFIX) || value.startsWith(BLOB_URL_PREFIX);

const isSupportedRemoteOrInlineUrl = (value: string): boolean =>
  isInlineUrl(value)
  || ASSET_LOCALHOST_PATTERN.test(value)
  || value.startsWith('http://')
  || value.startsWith('https://')
  || ASSET_URL_PATTERN.test(value);

const isLocalFilePath = (value: string): boolean =>
  WINDOWS_PATH_PATTERN.test(value)
  || UNC_PATH_PATTERN.test(value)
  || (value.startsWith('/') && !URL_PROTOCOL_PATTERN.test(value));

const toConvertFileSrc = (value: string): string => {
  if (value.startsWith('file://')) {
    try {
      return convertFileSrc(decodeURI(value.slice('file://'.length)));
    } catch {
      return convertFileSrc(value.slice('file://'.length));
    }
  }
  return convertFileSrc(value);
};

const localPathFromUrl = (value: string): string | undefined => {
  if (value.startsWith('file://')) {
    try {
      return decodeURI(value.slice('file://'.length));
    } catch {
      return value.slice('file://'.length);
    }
  }

  if (!ASSET_LOCALHOST_PATTERN.test(value)) return undefined;

  try {
    const url = new URL(value);
    const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    return decoded || undefined;
  } catch {
    return undefined;
  }
};

const sanitizePreviewUrl = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (isSupportedRemoteOrInlineUrl(trimmed)) return trimmed;
  // Raw local file paths (Windows absolute, UNC, Unix absolute, file://) must not
  // be blindly converted to asset URLs here because this function has no media
  // lookup context. Callers that need local-path resolution use
  // resolveAttachmentPreviewUrl with a lookup instead.
  return undefined;
};

const extractMediaFile = (media: MediaFile | MediaDetail | null | undefined): MediaFile | null => {
  if (!media) return null;
  return 'file' in media ? media.file : media;
};

const pickCurrentMediaPreviewPath = (media: MediaFile | MediaDetail | null | undefined): string | undefined => {
  const file = extractMediaFile(media);
  if (!file) return undefined;
  return file.thumbnailMicroPath || file.thumbnailPath || file.thumbnailPreviewPath || file.filepath || undefined;
};

const tryResolveLegacyFilePath = (legacyPath: string, lookup?: MessageImageMediaLookup): string | undefined => {
  const normalized = legacyPath.trim();
  if (!normalized) return undefined;
  if (lookup) {
    const foundByPath = lookup.findMediaByPath(normalized);
    const currentPreview = pickCurrentMediaPreviewPath(foundByPath);
    if (currentPreview) return currentPreview;

    const rewrittenPath = lookup.resolveLegacyPath?.(normalized);
    if (rewrittenPath) return rewrittenPath;
  }

  const filename = normalized.split(/[\\/]/).pop();
  if (!filename || !lookup) return undefined;

  const foundByName = lookup.findMediaByPath(filename) ?? lookup.findMediaById(filename);
  const currentPreview = pickCurrentMediaPreviewPath(foundByName);
  if (currentPreview) return currentPreview;

  return undefined;
};

const attachmentHasUsableSource = (attachment: ImageAttachment): boolean => {
  if (typeof attachment.base64 === 'string' && attachment.base64.trim().length > 0) return true;
  if (attachment.file) return true;
  if (typeof attachment.filePath === 'string' && attachment.filePath.trim().length > 0) return true;
  if (typeof attachment.previewUrl === 'string' && parseDataUrl(attachment.previewUrl)) return true;
  return false;
};

export const normalizeImageAttachments = (
  attachments?: ImageAttachment[],
): ImageAttachment[] | undefined => {
  const sanitized = attachments
    ?.filter(attachmentHasUsableSource)
    .map((attachment) => ({
      ...attachment,
      base64: attachment.base64?.trim() || undefined,
      filePath: attachment.filePath?.trim() || undefined,
      previewUrl: sanitizePreviewUrl(attachment.previewUrl),
      mimeType: attachment.mimeType?.trim() || undefined,
      fileName: attachment.fileName?.trim() || attachment.file?.name,
    }));

  return sanitized && sanitized.length > 0 ? sanitized : undefined;
};

export const hasInvalidImageAttachments = (attachments?: ImageAttachment[]): boolean =>
  !!attachments?.some((attachment) => !attachmentHasUsableSource(attachment));

export const messageHasImages = (message: Message): boolean =>
  (message.images?.length ?? 0) > 0 || (message.imageAttachments?.length ?? 0) > 0;

export const getLatestVisualMessageId = (messages: Message[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageHasImages(messages[index])) {
      return messages[index].id;
    }
  }
  return null;
};

const summarizeMessageImages = (message: Message): string => {
  const attachmentNames = message.imageAttachments
    ?.map((attachment, index) => attachment.fileName || `图片 ${index + 1}`)
    .filter(Boolean);
  if (attachmentNames && attachmentNames.length > 0) {
    return attachmentNames.join('、');
  }

  const imageCount = message.images?.length ?? 0;
  return imageCount > 1 ? `${imageCount} 张图片` : '图片';
};

export const buildMessageContentForProvider = (
  message: Message,
  includeBinaryImages: boolean,
): string => {
  if (includeBinaryImages || !messageHasImages(message)) {
    return message.content;
  }

  const imageSummary = summarizeMessageImages(message);
  return message.content
    ? `${message.content}\n\n[已附带图片：${imageSummary}]`
    : `[已附带图片：${imageSummary}]`;
};

export const normalizeMessageImageUrl = (value?: string, lookup?: MessageImageMediaLookup): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (isInlineUrl(trimmed)) return trimmed;

  const localUrlPath = localPathFromUrl(trimmed);
  if (localUrlPath) {
    // trimmed is already an asset:// or http://asset.localhost/ URL.
    // Try to re-resolve to the current thumbnail path via lookup (handles library moves).
    // If not found in the lookup, return the original asset URL as-is — the asset
    // protocol scope will allow or deny it based on the configured library root.
    const legacyResolved = tryResolveLegacyFilePath(localUrlPath, lookup);
    return legacyResolved ? toConvertFileSrc(legacyResolved) : trimmed;
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || ASSET_URL_PATTERN.test(trimmed)) return trimmed;

  if (trimmed.startsWith('file://') || isLocalFilePath(trimmed)) {
    // Raw local paths (file://, Windows absolute, UNC, Unix absolute) must only
    // become asset URLs when they can be verified through the media lookup.
    // Without lookup resolution we drop the path to prevent arbitrary file access:
    // the Rust asset scope is now constrained to the library root, so any path
    // that bypasses the lookup would be blocked at the protocol level anyway.
    const localPath = localPathFromUrl(trimmed) || trimmed;
    const legacyResolved = tryResolveLegacyFilePath(localPath, lookup);
    if (!legacyResolved) return undefined;
    return toConvertFileSrc(legacyResolved);
  }

  // Last resort: treat trimmed as a filename or opaque identifier and try lookup.
  const legacyResolved = tryResolveLegacyFilePath(trimmed, lookup);
  if (legacyResolved) {
    // legacyResolved is a library-backed path from the media lookup – convert directly.
    return isSupportedRemoteOrInlineUrl(legacyResolved) ? legacyResolved : toConvertFileSrc(legacyResolved);
  }
  return trimmed;
};

const resolveAttachmentPreviewUrl = (attachment: ImageAttachment, lookup?: MessageImageMediaLookup): string | undefined => {
  const currentMedia = attachment.sourceItemId
    ? lookup?.findMediaById(attachment.sourceItemId)
    : undefined;
  const currentPreview = pickCurrentMediaPreviewPath(currentMedia);
  if (currentPreview) {
    // currentPreview is a library-backed path from the live DB (trusted).
    // Convert directly — normalizeMessageImageUrl would re-run tryResolveLegacyFilePath
    // which is indexed by filepath, not thumbnail sub-paths, and would return undefined.
    return isSupportedRemoteOrInlineUrl(currentPreview) ? currentPreview : toConvertFileSrc(currentPreview);
  }

  // attachment.previewUrl has already been through sanitizePreviewUrl which strips raw
  // local paths; only safe URLs (asset://, http/s, data:, blob:) survive to this point.
  const directPreview = normalizeMessageImageUrl(attachment.previewUrl, lookup);
  if (directPreview) return directPreview;

  const filePath = attachment.filePath?.trim();
  if (filePath) {
    // Try to resolve the stored filePath through the media lookup.
    const restored = tryResolveLegacyFilePath(filePath, lookup);
    if (restored) {
      // resolved is a library-backed path – convert directly.
      return isSupportedRemoteOrInlineUrl(restored) ? restored : toConvertFileSrc(restored);
    }
    // Cannot verify through lookup – drop to prevent arbitrary path exposure.
    return undefined;
  }

  return undefined;
};

export const resolveMessageImagePreviewSources = (
  message: Message,
  lookup?: MessageImageMediaLookup,
): string[] => {
  const previewSources: string[] = [];

  for (const image of message.images ?? []) {
    const data = image.trim();
    if (data) {
      previewSources.push(`data:image/jpeg;base64,${data}`);
    }
  }

  for (const attachment of normalizeImageAttachments(message.imageAttachments) ?? []) {
    const currentPreview = resolveAttachmentPreviewUrl(attachment, lookup);
    if (currentPreview) {
      previewSources.push(currentPreview);
      continue;
    }

    if (attachment.base64) {
      const mimeType = attachment.mimeType || getMimeTypeFromFilename(attachment.fileName);
      previewSources.push(`data:${mimeType};base64,${attachment.base64}`);
    }
  }

  return previewSources;
};

export const resolveMessageImageSrc = (
  image: string,
  lookup?: MessageImageMediaLookup,
): string => normalizeMessageImageUrl(image, lookup) || image;

export const resolveStoredImageAttachments = (
  attachments?: ImageAttachment[],
  lookup?: MessageImageMediaLookup,
): ImageAttachment[] | undefined => {
  const normalized = normalizeImageAttachments(attachments);
  if (!normalized) return undefined;

  const resolved = normalized.map((attachment) => {
    const currentMedia = attachment.sourceItemId
      ? lookup?.findMediaById(attachment.sourceItemId)
      : undefined;
    const currentPreview = pickCurrentMediaPreviewPath(currentMedia);
    // resolveAttachmentPreviewUrl already converts currentPreview directly when
    // sourceItemId resolves; the fallback here converts it for the rare case where
    // resolveAttachmentPreviewUrl returns undefined despite currentPreview being set.
    const resolvedPreview = resolveAttachmentPreviewUrl(attachment, lookup);
    const previewUrl = resolvedPreview
      ?? (currentPreview
        ? (isSupportedRemoteOrInlineUrl(currentPreview) ? currentPreview : toConvertFileSrc(currentPreview))
        : undefined);
    const filePath = attachment.filePath || (currentPreview && !isSupportedRemoteOrInlineUrl(currentPreview) ? currentPreview : undefined);

    return {
      ...attachment,
      previewUrl,
      filePath,
    };
  });

  return resolved.length > 0 ? resolved : undefined;
};

export const resolveMessageImages = async (message: Message): Promise<ResolvedMessageImage[]> => {
  const resolved: ResolvedMessageImage[] = [];

  for (const image of message.images ?? []) {
    const data = image.trim();
    if (!data) continue;
    resolved.push({ data, mimeType: 'image/jpeg' });
  }

  for (const attachment of normalizeImageAttachments(message.imageAttachments) ?? []) {
    const mimeType = attachment.mimeType || getMimeTypeFromFilename(attachment.fileName);

    if (attachment.base64) {
      resolved.push({ data: attachment.base64, mimeType });
      continue;
    }

    if (attachment.file) {
      const bytes = new Uint8Array(await attachment.file.arrayBuffer());
      resolved.push({ data: bytesToBase64(bytes), mimeType: attachment.file.type || mimeType });
      continue;
    }

    if (attachment.filePath) {
      if (attachment.sourceItemId) {
        try {
          const data = await invoke<string>('read_media_file_as_base64', { mediaId: attachment.sourceItemId });
          resolved.push({ data, mimeType });
        } catch (e) {
          console.warn('[messageImages] read_media_file_as_base64 failed:', e);
        }
      } else {
        console.warn('[messageImages] attachment has filePath but no sourceItemId, skipping', attachment.filePath);
      }
      continue;
    }

    if (attachment.previewUrl) {
      const parsed = parseDataUrl(attachment.previewUrl);
      if (parsed) {
        resolved.push(parsed);
      }
    }
  }

  return resolved;
};

export const revokeMessagePreviewUrls = (messages: Message[]): void => {
  for (const message of messages) {
    for (const attachment of message.imageAttachments ?? []) {
      if (attachment.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
  }
};
