/**
 * Nocturne Gallery — AI Agent 工具调用命令
 *
 * 为前端 AI Agent 提供操作库内素材的能力，
 * 包括搜索、标签管理、分类、提示词更新等。
 */

use tauri::AppHandle;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::db_path;
use crate::db::{crud, open_conn};
use crate::models::{ItemSummary, ItemDetail, ReversePromptData, LibraryStats};

const DEFAULT_OPENAI_BASE_URL: &str = "http://127.0.0.1:8317/v1";
const DEFAULT_OPENAI_MODEL: &str = "gpt-5.5-high";
const DEFAULT_OPENAI_IMAGE_MODEL: &str = "gpt-image-2";
const OPENAI_CHAT_MODEL_VARIANTS: [(&str, &str, &str); 4] = [
    ("gpt-5.5-fast", "gpt-5.5", "low"),
    ("gpt-5.5-standard", "gpt-5.5", "medium"),
    ("gpt-5.5-high", "gpt-5.5", "high"),
    ("gpt-5.5-max", "gpt-5.5", "xhigh"),
];
const OPENAI_IMAGE_MODEL_VARIANTS: [(&str, &str, &str); 3] = [
    ("gpt-image-2-fast", "gpt-image-2", "low"),
    ("gpt-image-2-standard", "gpt-image-2", "medium"),
    ("gpt-image-2-high", "gpt-image-2", "high"),
];
const MAX_OPENAI_REFERENCE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiConfigView {
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
    pub api_key_source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiModelsResult {
    pub base_url: String,
    pub models: Vec<String>,
    pub image_models: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiToolCallResult {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiChatResult {
    pub content: String,
    pub tool_calls: Vec<OpenAiToolCallResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiImageResult {
    pub model: String,
    pub quality: String,
    pub b64_json: Option<String>,
    pub url: Option<String>,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiImageReference {
    pub file_name: Option<String>,
    pub base64_data: Option<String>,
    pub file_path: Option<String>,
}

struct ResolvedOpenAiConfig {
    base_url: String,
    model: String,
    model_variant: String,
    reasoning_effort: Option<String>,
    api_key: String,
    api_key_source: String,
}

struct ImageModelVariant {
    id: String,
    model: String,
    quality: String,
}

fn resolve_openai_chat_variant(model: &str) -> (String, String, Option<String>) {
    let normalized = model.trim();
    if let Some((id, model, effort)) = OPENAI_CHAT_MODEL_VARIANTS
        .iter()
        .find(|(id, _, _)| *id == normalized)
        .or_else(|| {
            if normalized == "gpt-5.5" {
                OPENAI_CHAT_MODEL_VARIANTS
                    .iter()
                    .find(|(id, _, _)| *id == DEFAULT_OPENAI_MODEL)
            } else {
                None
            }
        }) {
        return ((*id).to_string(), (*model).to_string(), Some((*effort).to_string()));
    }

    if normalized.is_empty() {
        let (id, model, effort) = OPENAI_CHAT_MODEL_VARIANTS[2];
        return (id.to_string(), model.to_string(), Some(effort.to_string()));
    }

    (normalized.to_string(), normalized.to_string(), None)
}

fn non_empty_trimmed(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn read_pref(handle: &AppHandle, key: &str) -> Option<String> {
    let db = db_path(handle).ok()?;
    let conn = open_conn(&db).ok()?;
    crud::get_preference(&conn, key).ok().flatten()
}

fn read_local_openai_key() -> Option<String> {
    local_openai_key_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

fn local_openai_key_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".cli-proxy-api").join("local-api-key.txt"))
}

fn is_gemini_model(model: &str) -> bool {
    model.trim().to_lowercase().starts_with("gemini-")
}

fn is_openai_compatible_image_model(model: &str) -> bool {
    let normalized = model.trim().to_lowercase();
    normalized.contains("image") || normalized.starts_with("dall-e")
}

fn validate_http_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err("URL 无效".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Err("仅支持保存 http:// 或 https:// 链接".to_string())
    }
}

fn normalize_path_for_boundary_check(path: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(path);
    if path.exists() {
        return path.canonicalize().ok();
    }

    let cleaned = path.to_string_lossy().replace('/', "\\");
    let cleaned_path = std::path::PathBuf::from(cleaned);
    if cleaned_path.exists() {
        return cleaned_path.canonicalize().ok();
    }

    None
}

fn same_or_descendant_path(candidate: &std::path::Path, root: &std::path::Path) -> bool {
    let candidate = candidate.canonicalize().unwrap_or_else(|_| candidate.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    #[cfg(windows)]
    let candidate_str = candidate.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    #[cfg(windows)]
    let root_str = root.to_string_lossy().replace('/', "\\").to_ascii_lowercase();

    #[cfg(not(windows))]
    let candidate_str = candidate.to_string_lossy().replace('\\', "/");
    #[cfg(not(windows))]
    let root_str = root.to_string_lossy().replace('\\', "/");

    if candidate_str == root_str {
        return true;
    }

    let mut root_with_sep = root_str;
    if !root_with_sep.ends_with(std::path::MAIN_SEPARATOR) {
        root_with_sep.push(std::path::MAIN_SEPARATOR);
    }

    candidate_str.starts_with(&root_with_sep)
}

fn resolve_openai_config(handle: &AppHandle, model_override: Option<String>) -> ResolvedOpenAiConfig {
    let base_url = non_empty_trimmed(std::env::var("OPENAI_BASE_URL").ok())
        .or_else(|| non_empty_trimmed(read_pref(handle, "openai_base_url")))
        .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string();

    let requested_model = non_empty_trimmed(model_override)
        .or_else(|| non_empty_trimmed(std::env::var("OPENAI_MODEL").ok()))
        .or_else(|| non_empty_trimmed(read_pref(handle, "openai_model")))
        .unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string());
    let (model_variant, model, reasoning_effort) = resolve_openai_chat_variant(&requested_model);

    let (api_key, api_key_source) = if let Some(key) = non_empty_trimmed(std::env::var("OPENAI_API_KEY").ok()) {
        (key, "env".to_string())
    } else if let Some(key) = read_local_openai_key() {
        (key, "file".to_string())
    } else if let Some(key) = non_empty_trimmed(read_pref(handle, "openai_api_key")) {
        (key, "settings".to_string())
    } else {
        (String::new(), "missing".to_string())
    };

    ResolvedOpenAiConfig {
        base_url,
        model,
        model_variant,
        reasoning_effort,
        api_key,
        api_key_source,
    }
}

fn resolve_openai_image_model(model_override: Option<String>) -> ImageModelVariant {
    let requested_model = non_empty_trimmed(model_override)
        .unwrap_or_else(|| "gpt-image-2-high".to_string());
    let (id, model, quality) = OPENAI_IMAGE_MODEL_VARIANTS
        .iter()
        .find(|(id, _, _)| *id == requested_model)
        .or_else(|| {
            if requested_model == DEFAULT_OPENAI_IMAGE_MODEL {
                OPENAI_IMAGE_MODEL_VARIANTS
                    .iter()
                    .find(|(id, _, _)| *id == "gpt-image-2-high")
            } else {
                None
            }
        })
        .unwrap_or(&OPENAI_IMAGE_MODEL_VARIANTS[2]);
    ImageModelVariant {
        id: (*id).to_string(),
        model: (*model).to_string(),
        quality: (*quality).to_string(),
    }
}

fn ensure_openai_key(config: &ResolvedOpenAiConfig) -> Result<(), String> {
    if config.api_key.is_empty() {
        Err("OpenAI-compatible API Key 未配置。请设置 OPENAI_API_KEY，或确认本机 key 文件存在。".to_string())
    } else {
        Ok(())
    }
}

fn parse_data_url_base64(value: &str) -> (Option<String>, &str) {
    if !value.starts_with("data:") {
        return (None, value);
    }

    let Some(comma_index) = value.find(',') else {
        return (None, value);
    };
    let header = &value[..comma_index];
    let mime_type = header
        .strip_prefix("data:")
        .and_then(|rest| rest.split(';').next())
        .filter(|mime| !mime.trim().is_empty())
        .map(str::to_string);
    (mime_type, &value[comma_index + 1..])
}

fn image_extension_from_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

struct RegisteredOpenAiReference {
    file_name: Option<String>,
}

fn format_reference_image_size_limit() -> String {
    format!("{}MB", MAX_OPENAI_REFERENCE_IMAGE_BYTES / 1024 / 1024)
}

fn clean_reference_file_name(value: Option<String>) -> Option<String> {
    let value = value?;
    let normalized = value.trim().replace('\\', "/");
    normalized
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn detect_openai_reference_image_mime(bytes: &[u8]) -> Result<String, String> {
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Jpeg) => Ok("image/jpeg".to_string()),
        Ok(image::ImageFormat::Png) => Ok("image/png".to_string()),
        Ok(image::ImageFormat::WebP) => Ok("image/webp".to_string()),
        Ok(image::ImageFormat::Gif) => Ok("image/gif".to_string()),
        Ok(_) => Err("参考图格式不支持，仅支持 JPEG、PNG、WebP 或 GIF".to_string()),
        Err(_) => Err("参考图必须是可识别的图片文件".to_string()),
    }
}

fn ensure_reference_image_size(size: u64) -> Result<(), String> {
    if size > MAX_OPENAI_REFERENCE_IMAGE_BYTES {
        return Err(format!(
            "参考图超过 {}，无法上传",
            format_reference_image_size_limit()
        ));
    }
    Ok(())
}

fn ensure_base64_reference_size(base64_content: &str) -> Result<(), String> {
    let encoded_limit = ((MAX_OPENAI_REFERENCE_IMAGE_BYTES + 2) / 3) * 4 + 4;
    if base64_content.len() as u64 > encoded_limit {
        return Err(format!(
            "参考图超过 {}，无法上传",
            format_reference_image_size_limit()
        ));
    }
    Ok(())
}

fn lookup_registered_openai_reference(
    conn: &Connection,
    file_path: &str,
) -> Result<Option<RegisteredOpenAiReference>, String> {
    const SQL: &str = "
        SELECT filename
        FROM media_files
        WHERE filepath = ?1 AND COALESCE(is_trashed, 0) = 0
        UNION ALL
        SELECT ma.filename
        FROM media_attachments ma
        INNER JOIN media_files mf ON mf.id = ma.media_id
        WHERE ma.filepath = ?1 AND COALESCE(mf.is_trashed, 0) = 0
        LIMIT 1
    ";

    #[cfg(windows)]
    let candidates = {
        let mut candidates = vec![file_path.to_string()];
        let windows_path = file_path.replace('/', "\\");
        if windows_path != file_path {
            candidates.push(windows_path);
        }
        candidates
    };
    #[cfg(not(windows))]
    let candidates = vec![file_path.to_string()];

    for candidate in candidates {
        let result = conn
            .query_row(SQL, params![candidate], |row| {
                Ok(RegisteredOpenAiReference {
                    file_name: row.get(0)?,
                })
            })
            .optional()
            .map_err(|e| format!("校验参考图来源失败：{}", e))?;
        if result.is_some() {
            return Ok(result);
        }
    }

    Ok(None)
}

fn read_registered_reference_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("读取参考图信息失败：{}", e))?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() || !file_type.is_file() {
        return Err("参考图必须是普通文件".to_string());
    }

    ensure_reference_image_size(metadata.len())?;
    let bytes = std::fs::read(path)
        .map_err(|e| format!("读取参考图失败：{}", e))?;
    ensure_reference_image_size(bytes.len() as u64)?;
    Ok(bytes)
}

fn decode_openai_image_reference(
    conn: &Connection,
    reference: &OpenAiImageReference,
    index: usize,
) -> Result<(Vec<u8>, String, String), String> {
    if let Some(file_path) = reference
        .file_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let registered = lookup_registered_openai_reference(conn, file_path)?
            .ok_or_else(|| "参考图路径不在素材库记录中，已拒绝读取".to_string())?;
        let path = Path::new(file_path);
        let bytes = read_registered_reference_file(path)?;
        let mime_type = detect_openai_reference_image_mime(&bytes)?;
        let file_name = clean_reference_file_name(reference.file_name.clone())
            .or_else(|| clean_reference_file_name(registered.file_name))
            .or_else(|| path.file_name().and_then(|name| name.to_str()).map(str::to_string))
            .unwrap_or_else(|| format!("reference-{}.{}", index + 1, image_extension_from_mime(&mime_type)));
        return Ok((bytes, file_name, mime_type));
    }

    let raw_base64 = reference
        .base64_data
        .as_deref()
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .ok_or_else(|| "参考图缺少可读取的数据".to_string())?;
    let (_data_url_mime, base64_content) = parse_data_url_base64(raw_base64);
    ensure_base64_reference_size(base64_content)?;
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = base64::Engine::decode(&engine, base64_content)
        .map_err(|e| format!("参考图解码失败：{}", e))?;
    ensure_reference_image_size(bytes.len() as u64)?;
    let mime_type = detect_openai_reference_image_mime(&bytes)?;
    let file_name = clean_reference_file_name(reference.file_name.clone())
        .unwrap_or_else(|| format!("reference-{}.{}", index + 1, image_extension_from_mime(&mime_type)));

    Ok((bytes, file_name, mime_type))
}

fn openai_error_message(status: reqwest::StatusCode, body: &Value) -> String {
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| body.get("error").and_then(Value::as_str))
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("请求失败"));
    format!("OpenAI-compatible API {}: {}", status.as_u16(), message)
}

fn openai_image_error_message(
    status: reqwest::StatusCode,
    body: &Value,
    image_model: &ImageModelVariant,
) -> String {
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| body.get("error").and_then(Value::as_str))
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("请求失败"));

    if status.as_u16() == 429 && message.to_ascii_lowercase().contains("cooling down") {
        return format!(
            "生图服务暂时限流：本次请求使用 {}（实际发送模型 {}，质量 {}），但本机代理返回「{}」。这通常是 CLIProxyAPI 内部凭证池冷却，不是软件选错模型。请稍后重试，或切换生图质量后再试。",
            image_model.id,
            image_model.model,
            image_model.quality,
            message
        );
    }

    format!(
        "OpenAI-compatible 生图 API {}: {}（请求模型 {}，实际发送 {}，质量 {}）",
        status.as_u16(),
        message,
        image_model.id,
        image_model.model,
        image_model.quality
    )
}

// ─────────────────────────────────────────────
//  AI 工具命令
// ─────────────────────────────────────────────

/// 搜索库内素材
/// 全文搜索 filename + ai_prompt，可选按标签/分类过滤
#[tauri::command]
pub async fn ai_search_library(
    handle: AppHandle,
    query: String,
    tags: Option<Vec<String>>,
    category_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ItemSummary>, String> {
    let limit = limit.unwrap_or(20).min(50).max(1);
    eprintln!("[ai_search_library] query='{}', tags={:?}, category_id={:?}, limit={}", query, tags, category_id, limit);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::ai_search_items(&conn, &query, tags.as_deref(), category_id.as_deref(), limit)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 为素材添加标签
/// 标签不存在则自动创建
#[tauri::command]
pub async fn ai_add_tags(
    handle: AppHandle,
    item_id: String,
    tags: Vec<String>,
) -> Result<(), String> {
    eprintln!("[ai_add_tags] item_id={}, tags={:?}", item_id, tags);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 验证素材存在
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM media_files WHERE id = ?)",
            params![item_id],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        if !exists {
            return Err("素材不存在".to_string());
        }
        crud::add_media_tags(&tx, &item_id, &tags).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 为素材设置分类
/// 分类不存在则自动创建
#[tauri::command]
pub async fn ai_set_category(
    handle: AppHandle,
    item_id: String,
    category_name: String,
) -> Result<(), String> {
    eprintln!("[ai_set_category] item_id={}, category='{}'", item_id, category_name);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crud::set_media_category(&tx, &item_id, &category_name).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取素材完整详情
#[tauri::command]
pub async fn ai_get_item_detail(
    handle: AppHandle,
    item_id: String,
) -> Result<ItemDetail, String> {
    eprintln!("[ai_get_item_detail] item_id={}", item_id);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::get_item_detail(&conn, &item_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "素材不存在".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 更新素材的 AI 提示词
#[tauri::command]
pub async fn ai_update_prompt(
    handle: AppHandle,
    item_id: String,
    prompt: String,
) -> Result<(), String> {
    eprintln!("[ai_update_prompt] item_id={}, prompt_len={}", item_id, prompt.len());

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crud::update_ai_prompt_text(&tx, &item_id, &prompt).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 批量获取素材摘要
#[tauri::command]
pub async fn ai_batch_get_items(
    handle: AppHandle,
    item_ids: Vec<String>,
) -> Result<Vec<ItemSummary>, String> {
    eprintln!("[ai_batch_get_items] count={}", item_ids.len());

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::batch_get_item_summaries(&conn, &item_ids).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 提示词反推：返回素材信息，供前端构建视觉分析请求
#[tauri::command]
pub async fn ai_reverse_prompt(
    handle: AppHandle,
    item_id: String,
) -> Result<ReversePromptData, String> {
    eprintln!("[ai_reverse_prompt] item_id={}", item_id);

    let db = db_path(&handle)?;
    let lib_root = crate::commands::library_root(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let data = crud::get_reverse_prompt_data(&conn, &item_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "素材不存在".to_string())?;

        let candidate = normalize_path_for_boundary_check(&data.filepath)
            .unwrap_or_else(|| std::path::PathBuf::from(&data.filepath));
        let root = normalize_path_for_boundary_check(&lib_root)
            .unwrap_or_else(|| std::path::PathBuf::from(&lib_root));

        if !same_or_descendant_path(&candidate, &root) {
            return Err("路径越界：文件不在库根目录范围内".to_string());
        }

        Ok(data)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取库统计信息（供 AI 了解全局上下文）
#[tauri::command]
pub async fn ai_get_library_stats(
    handle: AppHandle,
) -> Result<LibraryStats, String> {
    eprintln!("[ai_get_library_stats] Getting library statistics");

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::get_library_stats(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 保存联网搜索结果到书签表（用于知识库记录）
#[tauri::command]
pub async fn ai_web_search_save(
    handle: AppHandle,
    title: String,
    url: String,
    content: String,
    tags: Option<Vec<String>>,
) -> Result<i64, String> {
    let url = validate_http_url(&url)?;
    eprintln!("[ai_web_search_save] title='{}', url='{}', content_len={}", title, url, content.len());

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        crud::insert_search_bookmark(&mut conn, &title, &url, &content, tags.as_deref()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 批量为素材添加标签（Batch API）
/// 用于用户导入一批图片后，一次性将所有标签写回数据库
/// 参数格式：[{"item_id": "xxx", "tags": ["tag1", "tag2"]}, ...]
#[tauri::command]
pub async fn batch_add_tags(
    handle: AppHandle,
    updates: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    eprintln!("[batch_add_tags] Processing {} items", updates.len());

    let db = db_path(&handle)?;
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;

        // 使用事务保证批量更新的原子性
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let mut success_count = 0u32;
        let mut fail_count = 0u32;

        for update in &updates {
            let item_id = match update["item_id"].as_str() {
                Some(id) => id.to_string(),
                None => {
                    log::warn!("[batch_add_tags] Missing item_id in update");
                    fail_count += 1;
                    continue;
                }
            };

            let tags = match update["tags"].as_array() {
                Some(t) => t.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>(),
                None => {
                    log::warn!("[batch_add_tags] Invalid tags for item {}", item_id);
                    fail_count += 1;
                    continue;
                }
            };

            // 复用现有的 add_media_tags 逻辑（在 tx 环境下）
            match crud::add_media_tags(&tx, &item_id, &tags) {
                Ok(_) => success_count += 1,
                Err(e) => {
                    log::error!("[batch_add_tags] Failed to add tags for {}: {}", item_id, e);
                    fail_count += 1;
                }
            }
        }

        // 提交事务
        tx.commit().map_err(|e| e.to_string())?;

        Ok::<serde_json::Value, String>(serde_json::json!({
            "success": success_count,
            "failed": fail_count,
            "total": updates.len()
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    log::info!("[batch_add_tags] Completed: success={}, failed={}, total={}",
    result["success"], result["failed"], result["total"]);

    Ok(result)
}

#[tauri::command]
pub async fn openai_get_config(handle: AppHandle) -> Result<OpenAiConfigView, String> {
    let config = resolve_openai_config(&handle, None);
    Ok(OpenAiConfigView {
        base_url: config.base_url,
        model: config.model_variant,
        has_api_key: !config.api_key.is_empty(),
        api_key_source: config.api_key_source,
    })
}

#[tauri::command]
pub async fn openai_list_models(handle: AppHandle) -> Result<OpenAiModelsResult, String> {
    let config = resolve_openai_config(&handle, None);
    ensure_openai_key(&config)?;

    let response = reqwest::Client::new()
        .get(format!("{}/models", config.base_url))
        .bearer_auth(&config.api_key)
        .send()
        .await
        .map_err(|_| "无法连接本机 AI 服务，请检查 CLIProxyAPI 是否运行。".to_string())?;

    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|e| format!("模型列表响应解析失败: {}", e))?;

    if !status.is_success() {
        return Err(openai_error_message(status, &body));
    }

    let available_models = body
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let models = OPENAI_CHAT_MODEL_VARIANTS
        .iter()
        .filter(|(_, base_model, _)| available_models.iter().any(|available| available == *base_model))
        .map(|(id, _, _)| (*id).to_string())
        .collect::<Vec<_>>();
    let mut models = models;

    for model in available_models
        .iter()
        .filter(|model| !is_gemini_model(model) && !is_openai_compatible_image_model(model))
    {
        let is_known_variant_base = OPENAI_CHAT_MODEL_VARIANTS
            .iter()
            .any(|(_, base_model, _)| model == base_model);
        if !is_known_variant_base && !models.iter().any(|existing| existing == model) {
            models.push(model.to_string());
        }
    }

    let image_models = OPENAI_IMAGE_MODEL_VARIANTS
        .iter()
        .filter(|(_, base_model, _)| available_models.iter().any(|available| available == *base_model))
        .map(|(id, _, _)| (*id).to_string())
        .collect::<Vec<_>>();
    let mut image_models = image_models;

    for model in available_models
        .iter()
        .filter(|model| !is_gemini_model(model) && is_openai_compatible_image_model(model))
    {
        let is_known_variant_base = OPENAI_IMAGE_MODEL_VARIANTS
            .iter()
            .any(|(_, base_model, _)| model == base_model);
        if !is_known_variant_base && !image_models.iter().any(|existing| existing == model) {
            image_models.push(model.to_string());
        }
    }

    Ok(OpenAiModelsResult {
        base_url: config.base_url,
        models,
        image_models,
    })
}

#[tauri::command]
pub async fn openai_chat_completion(
    handle: AppHandle,
    messages: Vec<Value>,
    tools: Vec<OpenAiToolSpec>,
    model: Option<String>,
) -> Result<OpenAiChatResult, String> {
    let config = resolve_openai_config(&handle, model);
    ensure_openai_key(&config)?;

    let mut payload = serde_json::json!({
        "model": config.model,
        "messages": messages,
    });

    if let Some(reasoning_effort) = config.reasoning_effort {
        payload["reasoning_effort"] = Value::String(reasoning_effort);
    }

    if !tools.is_empty() {
        payload["tools"] = Value::Array(
            tools
                .into_iter()
                .map(|tool| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }

    let response = reqwest::Client::new()
        .post(format!("{}/chat/completions", config.base_url))
        .bearer_auth(&config.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "无法连接本机 AI 服务，请检查 CLIProxyAPI 是否运行。".to_string())?;

    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|e| format!("聊天响应解析失败: {}", e))?;

    if !status.is_success() {
        return Err(openai_error_message(status, &body));
    }

    let message = body
        .pointer("/choices/0/message")
        .ok_or_else(|| "聊天响应缺少 message 字段".to_string())?;

    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| {
                    let function = call.get("function")?;
                    let name = function.get("name").and_then(Value::as_str)?.to_string();
                    let arguments = function
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                        .unwrap_or_else(|| serde_json::json!({}));
                    Some(OpenAiToolCallResult {
                        id: call
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4())),
                        name,
                        arguments,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(OpenAiChatResult {
        content,
        tool_calls,
    })
}

#[tauri::command]
pub async fn openai_generate_image(
    handle: AppHandle,
    prompt: String,
    size: Option<String>,
    model: Option<String>,
    reference_images: Option<Vec<OpenAiImageReference>>,
) -> Result<OpenAiImageResult, String> {
    let config = resolve_openai_config(&handle, None);
    ensure_openai_key(&config)?;

    let image_model = resolve_openai_image_model(model);
    let trimmed_prompt = prompt.trim().to_string();
    if trimmed_prompt.is_empty() {
        return Err("生图提示词不能为空".to_string());
    }
    let resolved_size = size.unwrap_or_else(|| "1024x1024".to_string());
    let references = reference_images.unwrap_or_default();

    if !references.is_empty() {
        let db = db_path(&handle)?;
        let conn = open_conn(&db).map_err(|e| format!("打开数据库失败：{}", e))?;
        let mut form = reqwest::multipart::Form::new()
            .text("model", image_model.model.clone())
            .text("prompt", trimmed_prompt)
            .text("size", resolved_size)
            .text("quality", image_model.quality.clone())
            .text("response_format", "b64_json");

        for (index, reference) in references.iter().take(4).enumerate() {
            let (bytes, file_name, mime_type) = decode_openai_image_reference(&conn, reference, index)?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name)
                .mime_str(&mime_type)
                .map_err(|e| format!("参考图 MIME 类型无效：{}", e))?;
            form = form.part("image", part);
        }

        let response = reqwest::Client::new()
            .post(format!("{}/images/edits", config.base_url))
            .bearer_auth(&config.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|_| "无法连接本机 AI 图生图服务，请检查 CLIProxyAPI 是否运行。".to_string())?;

        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|e| format!("图生图响应解析失败: {}", e))?;

        if !status.is_success() {
            return Err(openai_image_error_message(status, &body, &image_model));
        }

        let first_image = body
            .get("data")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .ok_or_else(|| "图生图响应缺少 data 字段".to_string())?;

        return Ok(OpenAiImageResult {
            model: image_model.id,
            quality: image_model.quality,
            b64_json: first_image
                .get("b64_json")
                .and_then(Value::as_str)
                .map(str::to_string),
            url: first_image
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
            revised_prompt: first_image
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }

    let payload = serde_json::json!({
        "model": image_model.model,
        "prompt": trimmed_prompt,
        "size": resolved_size,
        "quality": image_model.quality,
        "response_format": "b64_json",
    });

    let response = reqwest::Client::new()
        .post(format!("{}/images/generations", config.base_url))
        .bearer_auth(&config.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "无法连接本机 AI 生图服务，请检查 CLIProxyAPI 是否运行。".to_string())?;

    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|e| format!("生图响应解析失败: {}", e))?;

    if !status.is_success() {
        return Err(openai_image_error_message(status, &body, &image_model));
    }

    let first_image = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "生图响应缺少 data 字段".to_string())?;

    Ok(OpenAiImageResult {
        model: image_model.id,
        quality: image_model.quality,
        b64_json: first_image
            .get("b64_json")
            .and_then(Value::as_str)
            .map(str::to_string),
        url: first_image
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string),
        revised_prompt: first_image
            .get("revised_prompt")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}
