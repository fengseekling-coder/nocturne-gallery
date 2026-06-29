//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
use crate::commands::{db_path};
use crate::db::open_conn;
use tauri::{command, AppHandle};

pub fn validate_http_url(url: &str) -> Result<String, String> {
    // 先检查原文是否含控制字符：trim 会吞掉首尾的 \r\n / \t，
    // 那样即使 URL 末尾被注入 CRLF，校验也会"看不见"。这是 SSRF / header
    // 注入的经典向量，必须在 trim 之前拒绝。
    if url.is_empty() || url.chars().any(char::is_control) {
        return Err("URL 无效".to_string());
    }

    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err("URL 无效".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Err("仅支持打开 http:// 或 https:// 链接".to_string())
    }
}

/// 添加网页书签
#[command]
pub async fn add_bookmark(
    handle: AppHandle,
    url: String,
    title: Option<String>,
    description: Option<String>,
    tags: Option<String>,
) -> Result<i64, String> {
    let url = validate_http_url(&url)?;
    eprintln!("[add_bookmark] Adding bookmark: {}", url);

    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::insert_bookmark(
            &conn,
            &url,
            title.as_deref(),
            description.as_deref(),
            tags.as_deref(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取所有书签
#[command]
pub async fn get_bookmarks(handle: AppHandle) -> Result<Vec<crate::models::Bookmark>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::query_bookmarks(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 删除书签
#[command]
pub async fn delete_bookmark(handle: AppHandle, id: i64) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::delete_bookmark(&conn, id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 更新书签信息
#[command]
pub async fn update_bookmark(
    handle: AppHandle,
    id: i64,
    title: Option<String>,
    description: Option<String>,
    tags: Option<String>,
) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::update_bookmark(
            &conn,
            id,
            title.as_deref(),
            description.as_deref(),
            tags.as_deref(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
