//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
use crate::commands::{db_path, library_root, same_or_descendant_path};
use crate::db::open_conn;
use tauri::{command, AppHandle};

/// 诊断：对比 Finder 中 `库根/回收站/` 与数据库里 is_trashed=1 的记录。
#[command]
pub async fn get_trash_diagnostics(
    handle: AppHandle,
) -> Result<crate::media::trash_reconcile::TrashDiagnostics, String> {
    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::media::trash_reconcile::collect_trash_diagnostics(&conn, &library_root)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 紧急修复：清理不在库根目录下的错误记录
#[command]
pub async fn emergency_cleanup_invalid_files(handle: AppHandle) -> Result<String, String> {
    eprintln!("[emergency_cleanup] Starting emergency cleanup of invalid files");

    let db = db_path(&handle)?;
    let library_root = library_root(&handle)?;

    // èŽ·å–æ‰€æœ‰æ–‡ä»¶è®°å½•
    let files_to_check = tokio::task::spawn_blocking({
        let db = db.clone();
        move || -> Result<Vec<(String, String)>, String> {
            let conn = open_conn(&db).map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT id, filepath FROM media_files")
                .map_err(|e| e.to_string())?;
            let files: Vec<(String, String)> = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            Ok(files)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let total_files = files_to_check.len();
    eprintln!(
        "[emergency_cleanup] Total files in database: {}",
        total_files
    );

    // æ‰¾å‡ºä¸åœ¨åº“æ ¹ç›®å½•ä¸‹çš„æ–‡ä»¶
    let mut invalid_ids = Vec::new();
    let mut valid_count = 0;

    for (id, filepath) in files_to_check {
        // æ£€æŸ¥æ–‡ä»¶è·¯å¾„æ˜¯å¦åœ¨åº“æ ¹ç›®å½•ä¸‹ï¼ˆæ“¯æŒ Windows è·¯å¾„ï¼‰
        let is_valid = same_or_descendant_path(
            std::path::Path::new(&filepath),
            std::path::Path::new(&library_root),
        );
        if is_valid {
            valid_count += 1;
        } else {
            eprintln!(
                "[emergency_cleanup] Invalid file path: {} (id: {})",
                filepath, id
            );
            invalid_ids.push(id);
        }
    }

    let invalid_count = invalid_ids.len();
    eprintln!(
        "[emergency_cleanup] Found {} valid files, {} invalid files",
        valid_count, invalid_count
    );

    // åˆ é™¤æ— æ•ˆè®°å½•
    if !invalid_ids.is_empty() {
        let deleted = tokio::task::spawn_blocking({
            let db = db.clone();
            let invalid_ids = invalid_ids.clone();
            move || -> Result<usize, String> {
                let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
                let tx = conn.transaction().map_err(|e| e.to_string())?;

                let mut count = 0;
                for id in invalid_ids {
                    // åˆ é™¤å…³è“çš„æ ‡ç­¾
                    tx.execute("DELETE FROM media_tags WHERE media_id = ?", [&id])
                        .map_err(|e| e.to_string())?;
                    // åˆ é™¤å…³è“çš„ AI å…ƒæ•°æ®
                    tx.execute("DELETE FROM ai_metadata WHERE media_id = ?", [&id])
                        .map_err(|e| e.to_string())?;
                    // åˆ é™¤åª’ä½“æ–‡ä»¶è®°å½•
                    tx.execute("DELETE FROM media_files WHERE id = ?", [&id])
                        .map_err(|e| e.to_string())?;
                    count += 1;
                }

                tx.commit().map_err(|e| e.to_string())?;
                Ok(count)
            }
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

        eprintln!("[emergency_cleanup] Deleted {} invalid records", deleted);
    }

    let message = format!(
        "紧急清理完成\n总记录: {}\n有效: {}\n无效已删除: {}",
        total_files, valid_count, invalid_count
    );

    Ok(message)
}
