//! 磁盘与数据库增量对齐：导入文件夹中有但 DB 没有的素材（不删 DB、不全量重算哈希）。

use rusqlite::OptionalExtension;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::db::{crud, open_conn};
use crate::media::scanner;
use crate::models::ScanResult;

fn classify_extension(ext: &str) -> Option<&'static str> {
    crate::media::design_source::classify_extension(ext)
}

fn is_scannable_library_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if path.components().any(|c| {
        matches!(
            c.as_os_str().to_string_lossy().as_ref(),
            ".nocturne" | ".nocturne_meta"
        )
    }) {
        return false;
    }
    path.extension()
        .and_then(|e| e.to_str())
        .and_then(|ext| classify_extension(ext))
        .is_some()
}

fn filepath_variants(path: &str) -> Vec<String> {
    let mut out = vec![path.to_string()];
    let slash = path.replace('\\', "/");
    if slash != path {
        out.push(slash);
    }
    #[cfg(windows)]
    {
        let back = path.replace('/', "\\");
        if !out.iter().any(|p| p == &back) {
            out.push(back);
        }
    }
    out
}

fn indexed_filepaths(conn: &rusqlite::Connection) -> Result<HashSet<String>, String> {
    // 含 is_trashed=1：避免库根/回收站/ 下文件被 sync 当成新素材重复导入
    let mut stmt = conn
        .prepare("SELECT filepath FROM media_files")
        .map_err(|e| format!("prepare indexed paths: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query indexed paths: {}", e))?;

    let mut set = HashSet::new();
    for row in rows {
        let fp = row.map_err(|e| format!("read filepath: {}", e))?;
        for v in filepath_variants(&fp) {
            set.insert(v);
        }
    }
    Ok(set)
}

fn path_already_indexed(path: &Path, indexed: &HashSet<String>) -> bool {
    let s = path.to_string_lossy();
    if indexed.contains(s.as_ref()) {
        return true;
    }
    let slash = s.replace('\\', "/");
    if indexed.contains(&slash) {
        return true;
    }
    if let Ok(canon) = std::fs::canonicalize(path) {
        let c = canon.to_string_lossy();
        if indexed.contains(c.as_ref()) {
            return true;
        }
        let cslash = c.replace('\\', "/");
        if indexed.contains(&cslash) {
            return true;
        }
    }
    false
}

fn source_folder_from_disk_path(library_root: &Path, file_path: &Path) -> Option<String> {
    let rel = file_path.strip_prefix(library_root).ok()?;
    rel.components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn relink_or_import_disk_file(
    conn: &rusqlite::Connection,
    disk_path: &Path,
    library_root: &str,
    db_path: &str,
    indexed: &mut HashSet<String>,
) -> Result<bool, String> {
    let filepath = disk_path.to_string_lossy().to_string();
    if path_already_indexed(disk_path, indexed) {
        return Ok(false);
    }

    let filename = disk_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    if filename.is_empty() {
        return Ok(false);
    }

    let stale_id: Option<String> = conn
        .query_row(
            "SELECT id FROM media_files
             WHERE filename = ?1 AND COALESCE(is_trashed, 0) = 0
               AND filepath != ?2
             LIMIT 1",
            rusqlite::params![filename, filepath],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("relink lookup: {}", e))?;

    if let Some(id) = stale_id {
        let old_path: String = conn
            .query_row(
                "SELECT filepath FROM media_files WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|e| format!("read old filepath: {}", e))?;

        if !Path::new(&old_path).exists() {
            let root = Path::new(library_root);
            let source_folder = source_folder_from_disk_path(root, disk_path);
            conn.execute(
                "UPDATE media_files SET filepath = ?1, source_folder = COALESCE(?2, source_folder) WHERE id = ?3",
                rusqlite::params![filepath, source_folder, id],
            )
            .map_err(|e| format!("relink update: {}", e))?;
            eprintln!("[library_sync] Relinked {} → {}", old_path, filepath);
            for v in filepath_variants(&filepath) {
                indexed.insert(v);
            }
            return Ok(true);
        }
    }

    let id = scanner::scan_single_file_minimal(&filepath, &filepath, db_path, library_root)
        .map_err(|e| format!("import {}: {}", filepath, e))?;
    eprintln!("[library_sync] Imported from disk: {}", filepath);
    for v in filepath_variants(&filepath) {
        indexed.insert(v);
    }
    let db_for_enrich = db_path.to_string();
    let fp = filepath.clone();
    let root_for_enrich = library_root.to_string();
    std::thread::spawn(move || {
        if let Err(e) = scanner::scan_single_file_enrich(&id, &fp, &db_for_enrich, &root_for_enrich)
        {
            eprintln!("[library_sync] Enrich failed for {}: {}", fp, e);
        }
    });
    Ok(true)
}

/// 修正库根前缀、source_folder，并清理指向不存在文件的重复索引。
pub fn prepare_library_db_for_sync(library_root: &str, db_path: &str) -> Result<(), String> {
    let mut conn = open_conn(db_path).map_err(|e| format!("open db: {}", e))?;
    let _ = crud::repair_unix_path_separators_in_media_paths(&conn)
        .map_err(|e| format!("repair separators: {}", e))?;
    let _ =
        crud::update_folder_paths_in_db(&mut conn).map_err(|e| format!("folder paths: {}", e))?;
    let _ = crud::update_library_root_prefixes(&mut conn, library_root)
        .map_err(|e| format!("root prefixes: {}", e))?;

    let root = Path::new(library_root.trim());
    let root_norm = root.to_string_lossy().to_string();
    conn.execute(
        "UPDATE media_files
         SET source_folder = (
           CASE
             WHEN instr(filepath, ?1 || '/灵感库/') > 0 OR instr(filepath, ?1 || '\\灵感库\\') > 0 THEN '灵感库'
             WHEN instr(filepath, ?1 || '/AI 提示词库/') > 0 THEN 'AI 提示词库'
             WHEN instr(filepath, ?1 || '/作品集/') > 0 OR instr(filepath, ?1 || '\\作品集\\') > 0 THEN '作品集'
             WHEN instr(filepath, ?1 || '/回收站/') > 0 OR instr(filepath, ?1 || '\\回收站\\') > 0 THEN '回收站'
             ELSE source_folder
           END
         )
         WHERE filepath LIKE ?2 OR filepath LIKE ?3",
        rusqlite::params![
            root_norm,
            format!("{}%", root_norm.replace('\\', "/")),
            format!("{}%", root_norm.replace('/', "\\")),
        ],
    )
    .map_err(|e| format!("source_folder fix: {}", e))?;

    repair_stale_media_filepaths(library_root, db_path)?;
    let _ = crate::media::design_source::hydrate_all_design_sidecar_thumbnails_in_db(
        library_root,
        db_path,
    );

    Ok(())
}

pub fn apply_repaired_media_path(
    conn: &rusqlite::Connection,
    id: &str,
    new_path: &str,
    library_root: &str,
) -> Result<(), String> {
    let inferred = crate::media::path_util::infer_source_folder_from_library_path(
        Path::new(new_path),
        library_root,
    );
    if let Some(folder) = inferred {
        conn.execute(
            "UPDATE media_files SET filepath = ?1, source_folder = ?2 WHERE id = ?3",
            rusqlite::params![new_path, folder, id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE media_files SET filepath = ?1 WHERE id = ?2",
            rusqlite::params![new_path, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// DB 中 filepath 在磁盘不存在时，在库根下按 filename 重新定位并写回。
pub fn repair_stale_media_filepaths(library_root: &str, db_path: &str) -> Result<u64, String> {
    let root = library_root.trim();
    if root.is_empty() {
        return Ok(0);
    }
    let conn = open_conn(db_path).map_err(|e| format!("open db: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, filepath, filename, COALESCE(source_folder, '') FROM media_files WHERE COALESCE(is_trashed, 0) = 0",
        )
        .map_err(|e| format!("prepare repair: {}", e))?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("query repair: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut fixed = 0u64;
    for (id, filepath, filename, source_folder) in rows {
        let folder_ref = source_folder.trim();
        let folder_opt = if folder_ref.is_empty() {
            None
        } else {
            Some(folder_ref)
        };

        if let Some(resolved) = crate::media::path_util::resolve_media_file_on_disk_with_folder_hint(
            &filepath,
            Some(root),
            Some(&filename),
            folder_opt,
        ) {
            let new_path = resolved.to_string_lossy().to_string();
            if new_path != filepath
                && apply_repaired_media_path(&conn, &id, &new_path, root).is_ok()
            {
                eprintln!(
                    "[library_sync] Aligned filepath for {}: {} -> {}",
                    filename, filepath, new_path
                );
                fixed += 1;
            }
            continue;
        }

        let Some(found) = crate::media::path_util::find_file_under_library_by_basename(
            root, &filename, folder_opt,
        ) else {
            if filename.to_ascii_lowercase().ends_with(".psd")
                || filename.to_ascii_lowercase().ends_with(".psb")
            {
                eprintln!(
                    "[library_sync] Cannot locate on disk: id={} path={} folder={:?}",
                    id, filepath, folder_opt
                );
            }
            continue;
        };
        let new_path = found.to_string_lossy().to_string();
        if new_path == filepath {
            continue;
        }
        match apply_repaired_media_path(&conn, &id, &new_path, root) {
            Ok(()) => {
                eprintln!(
                    "[library_sync] Repaired filepath for {}: {} -> {}",
                    filename, filepath, new_path
                );
                fixed += 1;
            }
            Err(e) => eprintln!("[library_sync] Repair failed for {}: {}", id, e),
        }
    }
    if fixed > 0 {
        eprintln!("[library_sync] Repaired {} stale filepath(s)", fixed);
    }
    Ok(fixed)
}

/// 扫描库根下支持的文件，仅对 DB 中不存在的路径做 minimal + 后台 enrich。
pub fn sync_library_from_disk(library_root: &str, db_path: &str) -> Result<ScanResult, String> {
    let root = Path::new(library_root.trim());
    if !root.is_dir() {
        return Err(format!("库根不是有效目录：{}", library_root));
    }

    prepare_library_db_for_sync(library_root, db_path)?;

    let conn = open_conn(db_path).map_err(|e| format!("open db: {}", e))?;
    let mut indexed = indexed_filepaths(&conn)?;

    let mut disk_paths: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if is_scannable_library_file(p) {
            disk_paths.push(p.to_path_buf());
        }
    }

    let scanned_count = disk_paths.len() as i64;
    let mut imported_count: i64 = 0;
    let mut skipped_count: i64 = 0;
    let library_root_str = library_root.to_string();
    let db_owned = db_path.to_string();

    for path in disk_paths {
        if path_already_indexed(&path, &indexed) {
            skipped_count += 1;
            continue;
        }

        match relink_or_import_disk_file(&conn, &path, &library_root_str, &db_owned, &mut indexed) {
            Ok(true) => imported_count += 1,
            Ok(false) => skipped_count += 1,
            Err(e) => {
                eprintln!("[library_sync] Skip {}: {}", path.display(), e);
                skipped_count += 1;
            }
        }
    }

    eprintln!(
        "[library_sync] Done: scanned={}, imported={}, skipped={}",
        scanned_count, imported_count, skipped_count
    );

    Ok(ScanResult {
        scanned_count,
        imported_count,
        skipped_count,
    })
}
