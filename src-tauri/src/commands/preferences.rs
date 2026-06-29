//! 用户偏好设置的 Tauri 命令
use crate::commands::db_path;
use crate::db::open_conn;
use tauri::{command, AppHandle};

/// 获取用户偏好设置
#[command]
pub async fn get_preference(handle: AppHandle, key: String) -> Result<Option<String>, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::get_preference(&conn, &key).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 设置用户偏好设置
#[command]
pub async fn set_preference(handle: AppHandle, key: String, value: String) -> Result<(), String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::set_preference(&conn, &key, &value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
