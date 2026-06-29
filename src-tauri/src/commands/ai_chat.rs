//! P1-1 后 AI chat 会话持久化模块
const ACTIVE_AI_CHAT_SESSION_PREF: &str = "ai_chat_active_session_id";
use crate::commands::db_path;
use crate::db::open_conn;
use crate::models::{AiChatLoadResult, AiChatSession};
use rusqlite::OptionalExtension;
use std::collections::HashSet;
use tauri::{command, AppHandle};
pub fn query_ai_chat_sessions(conn: &rusqlite::Connection) -> Result<Vec<AiChatSession>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
             FROM ai_chat_sessions s
             LEFT JOIN ai_chat_messages m ON m.session_id = s.id
             GROUP BY s.id
             HAVING message_count > 0
             ORDER BY s.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(AiChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                message_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(sessions)
}

pub fn load_ai_chat_result(
    conn: &rusqlite::Connection,
    requested_session_id: Option<String>,
) -> Result<AiChatLoadResult, String> {
    let sessions = query_ai_chat_sessions(conn)?;
    let requested_session_id = requested_session_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let should_persist_active_session = requested_session_id.is_some();
    let preferred_session_id = requested_session_id.or_else(|| {
        crate::db::crud::get_preference(conn, ACTIVE_AI_CHAT_SESSION_PREF)
            .ok()
            .flatten()
    });

    let active_session_id = preferred_session_id
        .filter(|id| sessions.iter().any(|session| session.id == *id))
        .or_else(|| sessions.first().map(|session| session.id.clone()));

    if should_persist_active_session {
        if let Some(session_id) = active_session_id.as_deref() {
            crate::db::crud::set_preference(conn, ACTIVE_AI_CHAT_SESSION_PREF, session_id)
                .map_err(|e| e.to_string())?;
        }
    }

    let messages = if let Some(session_id) = active_session_id.as_deref() {
        let mut stmt = conn
            .prepare(
                "SELECT payload FROM ai_chat_messages
                 WHERE session_id = ?
                 ORDER BY created_at ASC, rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let loaded_messages = stmt
            .query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|payload| payload.ok())
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
            .collect();
        loaded_messages
    } else {
        Vec::new()
    };

    Ok(AiChatLoadResult {
        active_session_id,
        sessions,
        messages,
    })
}

#[command]
pub async fn load_ai_chat_session(
    handle: AppHandle,
    session_id: Option<String>,
) -> Result<AiChatLoadResult, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        load_ai_chat_result(&conn, session_id)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn save_ai_chat_session(
    handle: AppHandle,
    session_id: String,
    title: String,
    messages: Vec<serde_json::Value>,
) -> Result<AiChatSession, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
        let now = chrono::Local::now().timestamp_millis();
        let clean_title = title.trim();
        let session_title = if clean_title.is_empty() { "新对话" } else { clean_title };
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let created_at = tx
            .query_row(
                "SELECT created_at FROM ai_chat_sessions WHERE id = ?",
                [&session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(now);

        tx.execute(
            "INSERT INTO ai_chat_sessions (id, title, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
            rusqlite::params![session_id, session_title, created_at, now],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM ai_chat_messages WHERE session_id = ?",
            [&session_id],
        )
        .map_err(|e| e.to_string())?;

        let mut stored_message_ids = HashSet::new();
        for (index, message) in messages.iter().enumerate() {
            let raw_message_id = message
                .get("id")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}-{}", session_id, index));
            let base_message_id = format!("{}:{}", session_id, raw_message_id);
            let message_id = if stored_message_ids.insert(base_message_id.clone()) {
                base_message_id
            } else {
                let mut deduped_message_id = format!("{}:{}", base_message_id, index);
                while !stored_message_ids.insert(deduped_message_id.clone()) {
                    deduped_message_id = format!("{}:{}", base_message_id, stored_message_ids.len());
                }
                deduped_message_id
            };
            let role = message
                .get("role")
                .and_then(|value| value.as_str())
                .unwrap_or("assistant");
            let content = message
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let created_at = message
                .get("timestamp")
                .and_then(|value| value.as_i64())
                .unwrap_or(now + index as i64);
            let payload = serde_json::to_string(message).map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO ai_chat_messages (id, session_id, role, content, payload, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![message_id, session_id, role, content, payload, created_at],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.execute(
            "INSERT OR REPLACE INTO user_preferences (key, value) VALUES (?, ?)",
            rusqlite::params![ACTIVE_AI_CHAT_SESSION_PREF, session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        Ok(AiChatSession {
            id: session_id,
            title: session_title.to_string(),
            created_at,
            updated_at: now,
            message_count: messages.len() as i64,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn delete_ai_chat_session(
    handle: AppHandle,
    session_id: String,
) -> Result<AiChatLoadResult, String> {
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM ai_chat_sessions WHERE id = ?", [&session_id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM user_preferences WHERE key = ? AND value = ?",
            rusqlite::params![ACTIVE_AI_CHAT_SESSION_PREF, session_id],
        )
        .map_err(|e| e.to_string())?;
        load_ai_chat_result(&conn, None)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
