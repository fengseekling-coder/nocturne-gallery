/**
 * Gega Gallery — 媒体类型定义
 *
 * 与 Rust 结构体保持一致（src-tauri/src/）
 */

/** 单个媒体文件，对应 Rust MediaFile 结构体 */
export interface MediaFile {
  id: string;
  filename: string;
  filepath: string;
  filetype: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  fileSize: number;
  createdAt: number;
  modifiedAt: number;
  importedAt: number;
  thumbnailPath: string | null;
  thumbnailMicroPath: string | null;
  thumbnailPreviewPath: string | null;
  thumbhash: string | null;
  colorDominant: string | null;
  isTrashed: boolean;
  sourceFolder?: string | null;
  sha256?: string | null;
  phash?: number | null;
}

/** 标签 */
export interface Tag {
  id: string;
  name: string;
  color: string;
}

/** AI 元数据 */
export interface AiMetadata {
  id: string;
  mediaId: string;
  promptText: string | null;
  modelName: string | null;
  platform: string | null;
  createdAt: number;
}

export interface MediaAttachment {
  id: string;
  mediaId: string;
  filename: string;
  filepath: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: number;
}

/** 媒体详情（含关联数据） */
export interface MediaDetail {
  file: MediaFile;
  tags: Tag[];
  aiMetadata: AiMetadata | null;
  categoryId: string | null;
  attachments: MediaAttachment[];
}

/** 媒体过滤条件 */
export interface MediaFilter {
  tagIds: string[] | null;
  categoryId: string | null;
  categoryName?: string | null;
  onlyTrashed: boolean;
  fileTypes: string[] | null;
  hasAiMetadata: boolean;
  aiMetadataStatus?: 'filled' | 'empty' | null;
  sourceFolder?: string | null;
  libraryRootPath?: string | null;
  keyword?: string | null;
  /** AI 提示词库虚拟大分组：全库按 Prompt/AI 条件筛选，不按 source_folder */
  virtualAiPromptsView?: boolean;
}

/** Keyset 分页游标（后端返回，用于下一页请求） */
export interface MediaCursor {
  importedAt: number;
  id: string;
}

/** 分页媒体列表 */
export interface MediaPage {
  items: MediaFile[];
  total: number;
  page: number;
  perPage: number;
  nextCursor: MediaCursor | null;
}
