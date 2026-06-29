//! 自动从 mod.rs 搬运,执行 cargo check 后补 use
use crate::commands::{
    consume_destructive_token, db_path, library_root,
    validate_library_relative_folder, validate_path_in_library,
};
use crate::db::open_conn;
use crate::media::media_bundle;
use crate::commands::BatchFileOperationResult;
use std::collections::HashMap;
use rusqlite::params_from_iter;
use tauri::{command, AppHandle};

pub const TRASH_FOLDER_NAME: &str = "回收站";
pub fn query_file_records(
    conn: &rusqlite::Connection,
    ids: &[String],
    sql: &str,
) -> Result<Vec<Vec<String>>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let query = sql.replace("{placeholders}", &placeholders);
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let column_count = stmt.column_count();
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), move |row| {
            let mut values = Vec::with_capacity(column_count);
            for index in 0..column_count {
                values.push(row.get::<_, String>(index)?);
            }
            Ok(values)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

pub fn record_fail(first_error: &mut Option<String>, reason: impl Into<String>) {
    if first_error.is_none() {
        *first_error = Some(reason.into());
    }
}

pub fn path_allowed_for_trash_op(
    stored_path: &str,
    resolved: Option<&std::path::Path>,
    library_root: &str,
) -> bool {
    if validate_path_in_library(stored_path, library_root).is_ok() {
        return true;
    }
    if let Some(p) = resolved {
        if validate_path_in_library(&p.to_string_lossy(), library_root).is_ok() {
            return true;
        }
    }
    false
}

pub fn restore_folder_for_trash_item(pre_trash: &str, current_source_folder: &str) -> String {
    let pre = pre_trash.trim();
    if !pre.is_empty() && pre != TRASH_FOLDER_NAME {
        return pre.to_string();
    }
    let cur = current_source_folder.trim();
    if !cur.is_empty() && cur != TRASH_FOLDER_NAME {
        return cur.to_string();
    }
    "灵感库".to_string()
}

pub fn unique_path_in_dir(dir: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(filename);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    for n in 1..=10_000 {
        candidate = dir.join(format!("{} ({}){}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(filename)
}

pub fn resolve_library_media_on_disk(
    stored_path: &str,
    filename: &str,
    source_folder: &str,
    library_root: &str,
) -> Option<std::path::PathBuf> {
    let folder = source_folder.trim();
    let folder_ref = if folder.is_empty() || folder == TRASH_FOLDER_NAME {
        None
    } else {
        Some(folder)
    };
    crate::media::path_util::resolve_media_file_on_disk_with_folder_hint(
        stored_path,
        Some(library_root),
        Some(filename),
        folder_ref,
    )
}

pub fn is_movable_library_entry(path: &std::path::Path) -> bool {
    path.is_file() || path.is_dir()
}

pub fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("无法创建目录 {}：{}", dst.display(), e))?;
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("无法读取目录 {}：{}", src.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("无法读取目录项类型：{}", e))?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "复制失败 {} -> {}：{}",
                    entry.path().display(),
                    target.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

pub fn remove_path_recursive(path: &std::path::Path) -> Result<(), String> {
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| format!("无法删除目录 {}：{}", path.display(), e))
    } else if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("无法删除文件 {}：{}", path.display(), e))
    } else {
        Ok(())
    }
}

pub fn move_file_within_library(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    if !is_movable_library_entry(source) {
        return Err(format!("源文件不存在或无法访问：{}", source.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目标目录：{}", e))?;
    }
    if target.exists() {
        return Err(format!("目标路径已存在：{}", target.display()));
    }
    if source.is_dir() {
        match std::fs::rename(source, target) {
            Ok(()) => return Ok(()),
            Err(_) => {
                copy_dir_recursive(source, target)?;
                remove_path_recursive(source).map_err(|e| {
                    format!(
                        "目录已复制到目标位置，但无法删除源目录：{} ({})",
                        source.display(),
                        e
                    )
                })?;
                return Ok(());
            }
        }
    }
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            std::fs::copy(source, target).map_err(|copy_err| {
                format!("移动文件失败（rename: {}；copy: {}）", rename_err, copy_err)
            })?;
            std::fs::remove_file(source).map_err(|e| {
                format!(
                    "文件已复制到目标位置，但无法删除源文件：{} ({})",
                    source.display(),
                    e
                )
            })?;
            Ok(())
        }
    }
}

pub fn relocate_bundle_after_move(
    conn: &rusqlite::Connection,
    media_id: &str,
    old_filepath: &str,
    new_filepath: &str,
    old_filename: &str,
    new_filename: &str,
    library_root: &str,
) {
    media_bundle::relocate_media_bundle_after_main_move(
        conn,
        media_id,
        old_filepath,
        new_filepath,
        old_filename,
        new_filename,
        library_root,
    );
}

/// 将文件移入回收站（软删除）。
#[command]
pub async fn move_to_trash(handle: AppHandle, id: String) -> Result<(), String> {
    eprintln!("[move_to_trash] Moving file to trash: {}", id);

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    // First get the file info
    let (stored_path, filename, source_folder) = tokio::task::spawn_blocking({
        let db_clone = db.clone();
        let id_clone = id.clone();
        let root_clone = library_root.clone();
        move || {
            let conn = open_conn(&db_clone).map_err(|e| e.to_string())?;
            let _ = crate::media::path_util::relink_media_filepaths_in_db(&conn, &root_clone);

            conn.query_row(
                "SELECT filepath, filename, COALESCE(source_folder, '') FROM media_files WHERE id = ?",
                rusqlite::params![id_clone],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|e| format!("Media file not found: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    let resolved =
        resolve_library_media_on_disk(&stored_path, &filename, &source_folder, &library_root);
    eprintln!(
        "[move_to_trash] Stored: {}, resolved: {:?}, filename: {}",
        stored_path,
        resolved.as_ref().map(|p| p.display().to_string()),
        filename
    );

    let target_folder = validate_library_relative_folder(TRASH_FOLDER_NAME)?;
    let trash_dir = std::path::Path::new(&library_root).join(&target_folder);
    std::fs::create_dir_all(&trash_dir)
        .map_err(|e| format!("Failed to create trash folder: {}", e))?;

    let source_path_buf = match resolved {
        Some(buf) if is_movable_library_entry(&buf) => {
            validate_path_in_library(&buf.to_string_lossy(), &library_root)?;
            buf
        }
        _ => {
            return Err(format!(
                "无法在磁盘上找到文件，未移入回收站（记录：{}）。请在 Finder 中打开库根「{}」下的「回收站」文件夹查看；若文件已被手动删除，请从回收站永久删除该记录。",
                stored_path, library_root
            ));
        }
    };
    let source_path = source_path_buf.to_string_lossy().to_string();

    let target_path = unique_path_in_dir(&trash_dir, &filename);

    let target_path_str = target_path.to_string_lossy().to_string();
    validate_path_in_library(&target_path_str, &library_root)?;
    eprintln!("[move_to_trash] Target path: {}", target_path_str);

    let source_path_clone = source_path.clone();
    let filename_for_meta = filename.clone();
    let new_filename = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&filename)
        .to_string();

    // Move the file physically
    tokio::task::spawn_blocking(move || {
        move_file_within_library(std::path::Path::new(&source_path_clone), &target_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[move_to_trash] Physical move failed: {}", e);
        e
    })?;

    if !std::path::Path::new(&target_path_str).is_file() {
        return Err(format!("文件移动后未出现在回收站目录：{}", target_path_str));
    }

    eprintln!("[move_to_trash] File moved to trash successfully");

    // Update database: update path and set is_trashed flag
    let db = db_path(&handle)?;
    let target_path_str_db = target_path_str.clone();
    let target_folder_db = target_folder.clone();
    let new_filename_db = new_filename.clone();
    let library_root_db = library_root.clone();
    let source_path_db = source_path.clone();
    let filename_for_meta_db = filename_for_meta.clone();
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        let (pre_trash_raw, current_source): (String, String) = conn
            .query_row(
                "SELECT COALESCE(pre_trash_folder, ''), COALESCE(source_folder, '') FROM media_files WHERE id = ?",
                rusqlite::params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_else(|_| (String::new(), String::new()));
        let pre_trash = restore_folder_for_trash_item(&pre_trash_raw, &current_source);

        relocate_bundle_after_move(
            &conn,
            &id,
            &source_path_db,
            &target_path_str_db,
            &filename_for_meta_db,
            &new_filename_db,
            &library_root_db,
        );

        // Update the file path and is_trashed flag
        conn.execute(
            "UPDATE media_files SET filepath = ?, filename = ?, source_folder = ?, pre_trash_folder = ?, is_trashed = 1 WHERE id = ?",
            rusqlite::params![target_path_str_db, new_filename_db, target_folder_db, pre_trash, id],
        )
        .map_err(|e| format!("Failed to update database: {}", e))?;

        eprintln!("[move_to_trash] Database updated successfully");
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| {
        eprintln!("[move_to_trash] DB update failed: {}", e);
        e
    })?;

    Ok(())
}

#[command]
pub async fn batch_move_to_trash(
    handle: AppHandle,
    ids: Vec<String>,
) -> Result<BatchFileOperationResult, String> {
    if ids.is_empty() {
        return Ok(BatchFileOperationResult {
            succeeded: 0,
            failed: 0,
            first_error: None,
        });
    }

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let _ = crate::media::path_util::relink_media_filepaths_in_db(&conn, &library_root);
        let rows = query_file_records(
            &conn,
            &ids,
            "SELECT id, filepath, COALESCE(pre_trash_folder, ''), COALESCE(source_folder, ''), filename FROM media_files WHERE id IN ({placeholders})",
        )?;
        let file_map: HashMap<String, (String, String, String, String)> = rows
            .into_iter()
            .filter_map(|row| {
                if row.len() == 5 {
                    Some((
                        row[0].clone(),
                        (
                            row[1].clone(),
                            row[2].clone(),
                            row[3].clone(),
                            row[4].clone(),
                        ),
                    ))
                } else {
                    None
                }
            })
            .collect();

        let target_folder = validate_library_relative_folder(TRASH_FOLDER_NAME)?;
        let trash_dir = std::path::Path::new(&library_root).join(&target_folder);
        std::fs::create_dir_all(&trash_dir)
            .map_err(|e| format!("Failed to create trash folder: {}", e))?;

        let mut moved_items: Vec<(String, String, String, String, String, String)> = Vec::new();
        let mut failed = 0usize;
        let mut first_error: Option<String> = None;

        for id in &ids {
            let Some((stored_path, pre_trash_raw, current_source, db_filename)) = file_map.get(id)
            else {
                failed += 1;
                record_fail(&mut first_error, "未找到该素材记录");
                continue;
            };

            let resolved = resolve_library_media_on_disk(
                stored_path,
                db_filename,
                current_source,
                &library_root,
            );

            if let Some(ref source_path_buf) = resolved {
                if !is_movable_library_entry(source_path_buf) {
                    failed += 1;
                    record_fail(
                        &mut first_error,
                        format!("无法访问文件：{}", db_filename),
                    );
                    continue;
                }
                if !path_allowed_for_trash_op(stored_path, Some(source_path_buf.as_path()), &library_root)
                {
                    failed += 1;
                    record_fail(&mut first_error, "路径不在库目录内");
                    continue;
                }

                let source_path = source_path_buf.to_string_lossy().to_string();
                let filename = source_path_buf
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(db_filename.as_str());

                let target_path = unique_path_in_dir(&trash_dir, filename);
                let target_path_str = target_path.to_string_lossy().to_string();
                if validate_path_in_library(&target_path_str, &library_root).is_err() {
                    failed += 1;
                    record_fail(&mut first_error, "回收站目标路径无效");
                    continue;
                }

                let new_filename = target_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(filename)
                    .to_string();

                match move_file_within_library(source_path_buf, &target_path) {
                    Ok(()) => {
                        if !target_path.is_file() {
                            failed += 1;
                            record_fail(
                                &mut first_error,
                                format!("移动后磁盘上找不到：{}", target_path_str),
                            );
                            continue;
                        }
                        if source_path != *stored_path {
                            let _ = conn.execute(
                                "UPDATE media_files SET filepath = ?1 WHERE id = ?2",
                                rusqlite::params![&source_path, id],
                            );
                        }
                        relocate_bundle_after_move(
                            &conn,
                            id,
                            &source_path,
                            &target_path_str,
                            filename,
                            &new_filename,
                            &library_root,
                        );
                        let pre_trash =
                            restore_folder_for_trash_item(pre_trash_raw, current_source);
                        moved_items.push((
                            id.clone(),
                            source_path.clone(),
                            target_path_str,
                            pre_trash,
                            new_filename,
                            filename.to_string(),
                        ));
                    }
                    Err(error) => {
                        log::warn!("[batch_move_to_trash] Failed to move {}: {}", source_path, error);
                        failed += 1;
                        record_fail(&mut first_error, error);
                    }
                }
                continue;
            }

            log::warn!(
                "[batch_move_to_trash] Source missing (stored={}, folder={})",
                stored_path,
                current_source
            );
            failed += 1;
            record_fail(
                &mut first_error,
                format!(
                    "无法在磁盘找到「{}」，未移入回收站（避免仅改数据库）。请检查库根下的文件是否还在原文件夹。",
                    db_filename
                ),
            );
        }

        if !moved_items.is_empty() {
            let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (id, _old_path, target_path, pre_trash, new_name, _old_name) in &moved_items {
                tx.execute(
                    "UPDATE media_files SET filepath = ?, filename = ?, source_folder = ?, pre_trash_folder = ?, is_trashed = 1 WHERE id = ?",
                    rusqlite::params![target_path, new_name, &target_folder, pre_trash, id],
                )
                .map_err(|e| format!("Failed to update database: {}", e))?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(BatchFileOperationResult {
            succeeded: moved_items.len(),
            failed,
            first_error,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 从回收站恢复文件。
#[command]
pub async fn restore_from_trash(handle: AppHandle, id: String) -> Result<(), String> {
    eprintln!("[restore_from_trash] Restoring file from trash: {}", id);

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    // Get the current trashed file info and determine original folder
    let (current_path, pre_trash_raw, current_source_folder) = tokio::task::spawn_blocking({
        let db_clone = db.clone();
        let id_clone = id.clone();
        move || {
            let conn = open_conn(&db_clone).map_err(|e| e.to_string())?;

            conn.query_row(
                "SELECT filepath, COALESCE(pre_trash_folder, ''), COALESCE(source_folder, '') FROM media_files WHERE id = ?",
                rusqlite::params![id_clone],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|e| format!("Media file not found: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    let restore_folder = restore_folder_for_trash_item(&pre_trash_raw, &current_source_folder);
    eprintln!(
        "[restore_from_trash] Current path: {}, restore to folder: {}",
        current_path, restore_folder
    );
    validate_path_in_library(&current_path, &library_root)?;
    let original_source_folder = validate_library_relative_folder(&restore_folder)?;

    // Determine target path based on original source folder
    let filename = std::path::Path::new(&current_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let target_dir = std::path::Path::new(&library_root).join(&original_source_folder);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create target folder: {}", e))?;
    let target_path = unique_path_in_dir(&target_dir, &filename);

    let target_path_str = target_path.to_string_lossy().to_string();
    validate_path_in_library(&target_path_str, &library_root)?;
    eprintln!("[restore_from_trash] Target path: {}", target_path_str);

    let current_path_move = current_path.clone();
    let filename_meta = filename.clone();
    let new_filename = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&filename)
        .to_string();

    // Move the file back from trash
    tokio::task::spawn_blocking(move || {
        move_file_within_library(std::path::Path::new(&current_path_move), &target_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[restore_from_trash] Physical move failed: {}", e);
        e
    })?;

    eprintln!("[restore_from_trash] File moved from trash successfully");

    // Update database: update path and clear is_trashed flag
    let db = db_path(&handle)?;
    let target_path_str_db = target_path_str.clone();
    let original_source_folder_db = original_source_folder.clone();
    let new_filename_db = new_filename.clone();
    let library_root_db = library_root.clone();
    let current_path_db = current_path.clone();
    let filename_meta_db = filename_meta.clone();
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;

        relocate_bundle_after_move(
            &conn,
            &id,
            &current_path_db,
            &target_path_str_db,
            &filename_meta_db,
            &new_filename_db,
            &library_root_db,
        );

        // Update the file path and clear is_trashed flag
        conn.execute(
            "UPDATE media_files SET filepath = ?, filename = ?, source_folder = ?, pre_trash_folder = NULL, is_trashed = 0 WHERE id = ?",
            rusqlite::params![target_path_str_db, new_filename_db, original_source_folder_db, id],
        )
        .map_err(|e| format!("Failed to update database: {}", e))?;

        eprintln!("[restore_from_trash] Database updated successfully");
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| {
        eprintln!("[restore_from_trash] DB update failed: {}", e);
        e
    })?;

    Ok(())
}

#[command]
pub async fn batch_restore_from_trash(
    handle: AppHandle,
    ids: Vec<String>,
) -> Result<BatchFileOperationResult, String> {
    if ids.is_empty() {
        return Ok(BatchFileOperationResult {
            succeeded: 0,
            failed: 0,
            first_error: None,
        });
    }

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        let rows = query_file_records(
            &conn,
            &ids,
            "SELECT id, filepath, COALESCE(pre_trash_folder, ''), COALESCE(source_folder, '') FROM media_files WHERE id IN ({placeholders})",
        )?;
        let file_map: HashMap<String, (String, String, String)> = rows
            .into_iter()
            .filter_map(|row| {
                if row.len() == 4 {
                    Some((row[0].clone(), (row[1].clone(), row[2].clone(), row[3].clone())))
                } else {
                    None
                }
            })
            .collect();

        let mut restored_items: Vec<(String, String, String, String)> = Vec::new();
        let mut failed = 0usize;

        for id in &ids {
            let Some((current_path, pre_trash_raw, current_source)) = file_map.get(id) else {
                failed += 1;
                continue;
            };

            if validate_path_in_library(current_path, &library_root).is_err() {
                failed += 1;
                continue;
            }

            let restore_folder =
                restore_folder_for_trash_item(pre_trash_raw, current_source);
            let source_folder = match validate_library_relative_folder(&restore_folder) {
                Ok(folder) => folder,
                Err(error) => {
                    log::warn!("[batch_restore_from_trash] Invalid source folder for {}: {}", id, error);
                    failed += 1;
                    continue;
                }
            };

            let current = std::path::Path::new(current_path);
            if !current.is_file() {
                failed += 1;
                continue;
            }

            let Some(filename) = current.file_name().and_then(|name| name.to_str()) else {
                failed += 1;
                continue;
            };

            let target_dir = std::path::Path::new(&library_root).join(&source_folder);
            if let Err(error) = std::fs::create_dir_all(&target_dir) {
                log::warn!(
                    "[batch_restore_from_trash] Failed to create target folder {}: {}",
                    target_dir.display(),
                    error
                );
                failed += 1;
                continue;
            }

            let target_path = unique_path_in_dir(&target_dir, filename);
            let target_path_str = target_path.to_string_lossy().to_string();
            if validate_path_in_library(&target_path_str, &library_root).is_err() {
                failed += 1;
                continue;
            }

            let new_filename = target_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(filename)
                .to_string();

            match move_file_within_library(current, &target_path) {
                Ok(()) => {
                    relocate_bundle_after_move(
                        &conn,
                        id,
                        current_path,
                        &target_path_str,
                        filename,
                        &new_filename,
                        &library_root,
                    );
                    restored_items.push((
                        id.clone(),
                        target_path_str,
                        source_folder,
                        new_filename,
                    ));
                }
                Err(error) => {
                    log::warn!(
                        "[batch_restore_from_trash] Failed to restore {}: {}",
                        current_path,
                        error
                    );
                    failed += 1;
                }
            }
        }

        if !restored_items.is_empty() {
            let mut conn = open_conn(&db).map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (id, target_path, source_folder, new_filename) in &restored_items {
                tx.execute(
                    "UPDATE media_files SET filepath = ?, filename = ?, source_folder = ?, pre_trash_folder = NULL, is_trashed = 0 WHERE id = ?",
                    rusqlite::params![target_path, new_filename, source_folder, id],
                )
                .map_err(|e| format!("Failed to update database: {}", e))?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(BatchFileOperationResult {
            succeeded: restored_items.len(),
            failed,
            first_error: None,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 永久删除回收站中的所有文件，返回被删除的数量。
/// 对齐回收站：DB 中 is_trashed=1 的条目与 `库根/回收站/` 磁盘一致（启动时也会自动跑）。
#[command]
pub async fn reconcile_trash_with_disk(
    handle: AppHandle,
) -> Result<crate::media::trash_reconcile::TrashReconcileReport, String> {
    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::media::trash_reconcile::reconcile_trashed_media_with_disk(&conn, &library_root)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[command]
pub async fn empty_trash(
    handle: AppHandle,
    confirmation_token: String,
) -> Result<i64, String> {
    eprintln!("[empty_trash] Emptying trash folder...");

    consume_destructive_token(&handle, &confirmation_token, "empty_trash")?;

    let library_root = library_root(&handle)?;
    let db = db_path(&handle)?;

    // First get the file paths to delete
    let files_to_delete = tokio::task::spawn_blocking({
        let db_clone = db.clone();
        move || {
            let conn = open_conn(&db_clone).map_err(|e| e.to_string())?;

            // Get all files that are marked as trashed
            let mut stmt = conn
                .prepare("SELECT id, filepath FROM media_files WHERE is_trashed = 1")
                .map_err(|e| e.to_string())?;

            let rows: Vec<(String, String)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            Ok(rows)
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    eprintln!(
        "[empty_trash] Found {} trashed files to delete",
        files_to_delete.len()
    );

    // Delete the physical files
    if let Ok(conn) = open_conn(&db) {
        for (media_id, filepath) in &files_to_delete {
            if validate_path_in_library(filepath, &library_root).is_err() {
                eprintln!("[empty_trash] Skipping out-of-library file {}", filepath);
                continue;
            }
            media_bundle::purge_media_sidecar_and_library_attachment_files(
                &conn,
                media_id,
                filepath,
                &library_root,
            );
            eprintln!("[empty_trash] Deleting physical file: {}", filepath);
            if let Err(e) = std::fs::remove_file(filepath) {
                eprintln!(
                    "[empty_trash] Warning: Failed to delete physical file {}: {}",
                    filepath, e
                );
            }
        }
    }

    eprintln!("[empty_trash] Physical files deleted, now clearing database records...");

    // Now clear the database records
    let db = db_path(&handle)?;
    let deleted_count = tokio::task::spawn_blocking(move || {
        let conn = open_conn(&db).map_err(|e| e.to_string())?;
        crate::db::crud::empty_trash(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e: String| e)?;

    eprintln!(
        "[empty_trash] Successfully emptied trash. {} records deleted.",
        deleted_count
    );
    Ok(deleted_count)
}
