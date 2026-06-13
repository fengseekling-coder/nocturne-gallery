//! 启动时对齐「回收站」：DB 中 is_trashed=1 的记录必须与 `库根/回收站/` 下真实文件一致。

use std::path::{Path, PathBuf};

use crate::media::path_util::{
    find_file_under_library_by_basename, resolve_media_file_on_disk_with_folder_hint,
};

const TRASH_FOLDER: &str = "回收站";

#[derive(Debug, Default, serde::Serialize)]
pub struct TrashReconcileReport {
    pub scanned: u64,
    pub already_ok: u64,
    pub moved_to_trash_dir: u64,
    pub db_path_updated: u64,
    /// 磁盘上找不到文件，但保留 is_trashed=1（不再误还原到灵感库）
    pub orphaned_trash_records: u64,
    pub failed: u64,
}

fn unique_path_in_dir(dir: &Path, filename: &str) -> PathBuf {
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(filename);
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

fn move_file_to_path(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("源不是文件：{}", source.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if target.exists() {
        return Err(format!("目标已存在：{}", target.display()));
    }
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            std::fs::copy(source, target)
                .map_err(|e| format!("移动失败（rename: {}；copy: {}）", rename_err, e))?;
            std::fs::remove_file(source).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

fn path_is_under_trash(p: &Path) -> bool {
    p.to_string_lossy().replace('\\', "/").contains("/回收站/")
}

/// 启动或手动调用：把误标在回收站但文件还在别处的条目物理移入 `库根/回收站/`；
/// 磁盘上找不到时仍保留 is_trashed=1，避免回收站页面「凭空消失」。
pub fn reconcile_trashed_media_with_disk(
    conn: &rusqlite::Connection,
    library_root: &str,
) -> Result<TrashReconcileReport, String> {
    let root = library_root.trim();
    let trash_dir = Path::new(root).join(TRASH_FOLDER);
    std::fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, filepath, filename, COALESCE(source_folder, ''), COALESCE(pre_trash_folder, '')
             FROM media_files WHERE is_trashed = 1",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut report = TrashReconcileReport {
        scanned: rows.len() as u64,
        ..Default::default()
    };

    for (id, stored, filename, _source_folder, pre_trash) in rows {
        let stored_path = Path::new(&stored);
        if stored_path.is_file() && path_is_under_trash(stored_path) {
            report.already_ok += 1;
            continue;
        }

        // 1) 记录路径上已有文件（可能在回收站外）
        if stored_path.is_file() {
            let target = unique_path_in_dir(&trash_dir, &filename);
            match move_file_to_path(stored_path, &target) {
                Ok(()) => {
                    let new_path = target.to_string_lossy().to_string();
                    let new_name = target
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&filename)
                        .to_string();
                    conn.execute(
                        "UPDATE media_files SET filepath = ?1, filename = ?2, source_folder = ?3 WHERE id = ?4",
                        rusqlite::params![new_path, new_name, TRASH_FOLDER, id],
                    )
                    .map_err(|e| e.to_string())?;
                    report.moved_to_trash_dir += 1;
                    log::info!(
                        "[trash_reconcile] Moved into trash dir: {} -> {}",
                        stored,
                        new_path
                    );
                }
                Err(e) => {
                    report.failed += 1;
                    log::warn!("[trash_reconcile] Move failed for {}: {}", stored, e);
                }
            }
            continue;
        }

        // 2) 按库内搜索真实文件（含 macOS 文件名变体）
        let folder_hint = if pre_trash.trim().is_empty() || pre_trash == TRASH_FOLDER {
            None
        } else {
            Some(pre_trash.as_str())
        };
        let resolved = resolve_media_file_on_disk_with_folder_hint(
            &stored,
            Some(root),
            Some(&filename),
            folder_hint,
        )
        .or_else(|| find_file_under_library_by_basename(root, &filename, folder_hint));

        let Some(disk_path) = resolved else {
            // 磁盘上找不到文件：保留回收站标记，仅修正 source_folder，避免从 UI 中“消失”
            conn.execute(
                "UPDATE media_files SET source_folder = ?1 WHERE id = ?2",
                rusqlite::params![TRASH_FOLDER, id],
            )
            .map_err(|e| e.to_string())?;
            report.orphaned_trash_records += 1;
            log::warn!(
                "[trash_reconcile] Trashed record kept (no file on disk): id={} filename={} stored={}",
                id,
                filename,
                stored
            );
            continue;
        };

        if path_is_under_trash(&disk_path) {
            let new_path = disk_path.to_string_lossy().to_string();
            if new_path != stored {
                conn.execute(
                    "UPDATE media_files SET filepath = ?1, source_folder = ?2 WHERE id = ?3",
                    rusqlite::params![new_path, TRASH_FOLDER, id],
                )
                .map_err(|e| e.to_string())?;
                report.db_path_updated += 1;
            } else {
                report.already_ok += 1;
            }
            continue;
        }

        // 文件在作品集/灵感库等：移入回收站目录
        let target = unique_path_in_dir(&trash_dir, &filename);
        match move_file_to_path(&disk_path, &target) {
            Ok(()) => {
                let new_path = target.to_string_lossy().to_string();
                let new_name = target
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&filename)
                    .to_string();
                conn.execute(
                    "UPDATE media_files SET filepath = ?1, filename = ?2, source_folder = ?3 WHERE id = ?4",
                    rusqlite::params![new_path, new_name, TRASH_FOLDER, id],
                )
                .map_err(|e| e.to_string())?;
                report.moved_to_trash_dir += 1;
                log::info!(
                    "[trash_reconcile] Relocated to trash: {} -> {}",
                    disk_path.display(),
                    new_path
                );
            }
            Err(e) => {
                // 无法移入回收站目录：更新 filepath 指向磁盘真实位置，但保持 is_trashed=1
                let new_path = disk_path.to_string_lossy().to_string();
                conn.execute(
                    "UPDATE media_files SET filepath = ?1, source_folder = ?2 WHERE id = ?3",
                    rusqlite::params![new_path, TRASH_FOLDER, id],
                )
                .map_err(|e| e.to_string())?;
                report.orphaned_trash_records += 1;
                log::warn!(
                    "[trash_reconcile] Could not move to trash ({}); kept is_trashed for {}",
                    e,
                    id
                );
            }
        }
    }

    Ok(report)
}

#[derive(serde::Serialize)]
pub struct TrashDiagnostics {
    pub library_root: String,
    pub trash_folder_on_disk: String,
    pub disk_filenames_in_trash: Vec<String>,
    pub db_trashed_items: Vec<TrashDiagnosticItem>,
}

#[derive(serde::Serialize)]
pub struct TrashDiagnosticItem {
    pub id: String,
    pub filename: String,
    pub filepath: String,
    pub file_exists_at_recorded_path: bool,
    pub resolved_on_disk: Option<String>,
}

pub fn collect_trash_diagnostics(
    conn: &rusqlite::Connection,
    library_root: &str,
) -> Result<TrashDiagnostics, String> {
    let root = library_root.trim();
    let trash_dir = Path::new(root).join(TRASH_FOLDER);
    let mut disk_filenames = Vec::new();
    if trash_dir.is_dir() {
        for entry in std::fs::read_dir(&trash_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    disk_filenames.push(name.to_string());
                }
            }
        }
        disk_filenames.sort();
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, filepath, filename, COALESCE(source_folder, ''), COALESCE(pre_trash_folder, '')
             FROM media_files WHERE is_trashed = 1",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut db_trashed_items = Vec::new();
    for (id, filepath, filename, source_folder, pre_trash) in rows {
        let exists = Path::new(&filepath).is_file();
        let folder_hint = if pre_trash.trim().is_empty() || pre_trash == TRASH_FOLDER {
            if source_folder.trim().is_empty() || source_folder == TRASH_FOLDER {
                None
            } else {
                Some(source_folder.as_str())
            }
        } else {
            Some(pre_trash.as_str())
        };
        let resolved = resolve_media_file_on_disk_with_folder_hint(
            &filepath,
            Some(root),
            Some(&filename),
            folder_hint,
        )
        .map(|p| p.to_string_lossy().to_string());
        db_trashed_items.push(TrashDiagnosticItem {
            id,
            filename,
            filepath,
            file_exists_at_recorded_path: exists,
            resolved_on_disk: resolved,
        });
    }

    Ok(TrashDiagnostics {
        library_root: root.to_string(),
        trash_folder_on_disk: trash_dir.to_string_lossy().to_string(),
        disk_filenames_in_trash: disk_filenames,
        db_trashed_items,
    })
}
