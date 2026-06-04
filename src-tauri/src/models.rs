use serde::{Deserialize, Serialize};

/// 所有序列化结构体统一使用 camelCase，与 TypeScript 前端对齐。
/// Rust 内部字段仍用 snake_case，serde 负责转换。

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub id: String,
    pub filename: String,
    pub filepath: String,
    pub filetype: String,
    pub mime_type: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub file_size: i64,
    pub created_at: i64,
    pub modified_at: i64,
    pub imported_at: i64,
    pub thumbnail_path: Option<String>,
    pub thumbnail_micro_path: Option<String>,
    pub thumbnail_preview_path: Option<String>,
    pub thumbhash: Option<String>,
    pub color_dominant: Option<String>,
    pub is_trashed: bool,
    pub source_folder: Option<String>,
    pub sha256: Option<String>,
    pub phash: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiMetadata {
    pub id: String,
    pub media_id: String,
    pub prompt_text: Option<String>,
    pub model_name: Option<String>,
    pub platform: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaDetail {
    pub file: MediaFile,
    pub tags: Vec<Tag>,
    pub ai_metadata: Option<AiMetadata>,
    pub category_id: Option<String>,
    pub attachments: Vec<MediaAttachment>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaAttachment {
    pub id: String,
    pub media_id: String,
    pub filename: String,
    pub filepath: String,
    pub file_size: Option<i64>,
    pub mime_type: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub scanned_count: i64,
    pub imported_count: i64,
    pub skipped_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaCursor {
    pub imported_at: i64,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    pub items: Vec<MediaFile>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
    pub next_cursor: Option<MediaCursor>,
}

/// MediaFilter 从前端反序列化，camelCase 字段名。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaFilter {
    pub tag_ids: Option<Vec<String>>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub only_trashed: bool,
    pub file_types: Option<Vec<String>>,
    pub has_ai_metadata: bool,
    pub ai_metadata_status: Option<String>,
    pub source_folder: Option<String>,
    pub library_root_path: Option<String>,
    pub keyword: Option<String>,
}

/// 网页书签
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub favicon_url: Option<String>,
    pub tags: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePlacement {
    pub source_folder: Option<String>,
    pub category_name: Option<String>,
}

/// 重复检测结果
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCheckResult {
    /// 重复类型：'exact'（完全相同）/ 'similar'（视觉相似）/ null（无重复）
    pub duplicate_type: Option<String>,
    /// 已存在的文件信息
    pub existing_item: Option<MediaFile>,
    /// 相似度 0.0-1.0
    pub similarity: f32,
    /// 已有素材所在位置
    pub existing_placement: Option<DuplicatePlacement>,
    /// 待导入素材的弹窗预览图
    pub pending_preview: Option<String>,
}

/// 文件基本信息
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub size: i64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportPathsResult {
    pub imported_count: i64,
    pub skipped_count: i64,
    pub failed_count: i64,
}

// ─────────────────────────────────────────────
//  AI Agent 工具调用相关结构体
// ─────────────────────────────────────────────

/// 素材摘要信息（用于搜索和列表）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: String,
    pub filename: String,
    pub filetype: String,
    pub thumbnail_path: Option<String>,
    pub ai_prompt: Option<String>,
    pub tags: Vec<String>,
    pub category_name: Option<String>,
    pub created_at: i64,
}

/// 素材完整详情（用于 Agent 深度分析）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    pub id: String,
    pub filename: String,
    pub filepath: String,
    pub filetype: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub file_size: i64,
    pub thumbnail_path: Option<String>,
    pub color_dominant: Option<String>,
    pub ai_prompt: Option<String>,
    pub ai_model: Option<String>,
    pub ai_platform: Option<String>,
    pub tags: Vec<String>,
    pub category_name: Option<String>,
    pub created_at: i64,
}

/// 提示词反推返回数据
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReversePromptData {
    pub item_id: String,
    pub filename: String,
    pub filepath: String,
    pub thumbnail_path: Option<String>,
    pub existing_prompt: Option<String>,
    pub color_dominant: Option<String>,
    pub file_size: i64,
    pub mime_type: Option<String>,
}

/// 标签计数（用于统计）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GroupItemCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NavItemCount {
    pub nav_id: String,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiChatLoadResult {
    pub active_session_id: Option<String>,
    pub sessions: Vec<AiChatSession>,
    pub messages: Vec<serde_json::Value>,
}

/// 库统计信息
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total_items: i64,
    pub total_with_prompt: i64,
    pub total_without_prompt: i64,
    pub total_tags: i64,
    pub total_categories: i64,
    pub top_tags: Vec<TagCount>,
    pub recent_items: Vec<ItemSummary>,
}

/// 文件侧边元数据（.nocturne_meta/{filename}.json）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileMetaJSON {
    pub file_name: String,
    pub sha256: Option<String>,
    pub phash: Option<i64>,
    pub color_dominant: Option<String>,
    pub thumbnail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_text: Option<String>,
}
