use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use uuid::Uuid;

use crate::models::{AiMetadata, GroupItemCount, MediaAttachment, MediaDetail, MediaFile, NavItemCount, MediaFilter, Tag, ItemSummary, ItemDetail, ReversePromptData, LibraryStats, TagCount};

// ─────────────────────────────────────────────
//  统计相关结构体
// ─────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct MediaStatistics {
    pub file_count: i64,
    pub total_size: i64,
}

// ─────────────────────────────────────────────
//  内部工具：从行映射 MediaFile
// ─────────────────────────────────────────────

fn row_to_media_file(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaFile> {
    let is_trashed_int: i32 = row.get(13)?;
    Ok(MediaFile {
        id: row.get(0)?,
        filename: row.get(1)?,
        filepath: row.get(2)?,
        filetype: row.get(3)?,
        mime_type: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        file_size: row.get(7)?,
        created_at: row.get(8)?,
        modified_at: row.get(9)?,
        imported_at: row.get(10)?,
        thumbnail_path: row.get(11)?,
        color_dominant: row.get(12)?,
        is_trashed: is_trashed_int != 0,
        source_folder: row.get(14)?,
        sha256: row.get(15)?,
        phash: row.get(16)?,
        thumbnail_micro_path: row.get(17)?,
        thumbnail_preview_path: row.get(18)?,
        thumbhash: row.get(19)?,
    })
}

fn normalized_root_variants(root: &str) -> Vec<String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let without_trailing = trimmed.trim_end_matches(['\\', '/']);
    let base = if without_trailing.is_empty() || without_trailing.ends_with(':') {
        trimmed
    } else {
        without_trailing
    };

    let mut variants = Vec::new();
    let backslash = base.replace('/', "\\");
    variants.push(backslash);
    let slash = base.replace('\\', "/");
    if !variants.iter().any(|item| item == &slash) {
        variants.push(slash);
    }
    variants
}

fn descendant_like_pattern(root: &str) -> String {
    if root.ends_with('\\') || root.ends_with('/') {
        format!("{}%", root)
    } else if root.contains('\\') {
        format!("{}\\%", root)
    } else {
        format!("{}/%", root)
    }
}

fn push_library_root_filter(
    conditions: &mut Vec<String>,
    param_values: &mut Vec<Box<dyn rusqlite::ToSql>>,
    column: &str,
    root: &str,
) {
    let variants = normalized_root_variants(root);
    if variants.is_empty() {
        return;
    }

    let mut clauses = Vec::new();
    for variant in variants {
        clauses.push(format!("{} = ?", column));
        param_values.push(Box::new(variant.clone()));
        clauses.push(format!("{} LIKE ?", column));
        param_values.push(Box::new(descendant_like_pattern(&variant)));
    }
    conditions.push(format!("({})", clauses.join(" OR ")));
}

fn row_to_media_attachment(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaAttachment> {
    Ok(MediaAttachment {
        id: row.get(0)?,
        media_id: row.get(1)?,
        filename: row.get(2)?,
        filepath: row.get(3)?,
        file_size: row.get(4)?,
        mime_type: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn media_search_index_exists(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'media_search_fts'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .unwrap_or(false)
}

fn build_fts_match_query(keyword: &str) -> Option<String> {
    let terms: Vec<String> = keyword
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();

    if !terms.is_empty() {
        return Some(terms.join(" AND "));
    }

    let trimmed = keyword.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(format!("\"{}\"", trimmed.replace('"', "\"\"")))
    }
}

fn rebuild_media_search_index(conn: &Connection) -> Result<()> {
    if !media_search_index_exists(conn) {
        return Ok(());
    }

    conn.execute("DELETE FROM media_search_fts", [])
        .context("Failed to clear media_search_fts")?;
    conn.execute(
        "INSERT INTO media_search_fts (media_id, filename, prompt_text, tags)
         SELECT mf.id,
                mf.filename,
                COALESCE(am.prompt_text, ''),
                COALESCE(GROUP_CONCAT(t.name, ' '), '')
         FROM media_files mf
         LEFT JOIN ai_metadata am ON am.media_id = mf.id
         LEFT JOIN media_tags mt ON mt.media_id = mf.id
         LEFT JOIN tags t ON t.id = mt.tag_id
         GROUP BY mf.id",
        [],
    )
    .context("Failed to rebuild media_search_fts")?;

    Ok(())
}

fn delete_media_search_document(conn: &Connection, media_id: &str) -> Result<()> {
    if !media_search_index_exists(conn) {
        return Ok(());
    }

    conn.execute(
        "DELETE FROM media_search_fts WHERE media_id = ?",
        params![media_id],
    )
    .context("Failed to delete media_search_fts row")?;
    Ok(())
}

fn refresh_media_search_document(conn: &Connection, media_id: &str) -> Result<()> {
    if !media_search_index_exists(conn) {
        return Ok(());
    }

    delete_media_search_document(conn, media_id)?;
    conn.execute(
        "INSERT INTO media_search_fts (media_id, filename, prompt_text, tags)
         SELECT mf.id,
                mf.filename,
                COALESCE(am.prompt_text, ''),
                COALESCE(GROUP_CONCAT(t.name, ' '), '')
         FROM media_files mf
         LEFT JOIN ai_metadata am ON am.media_id = mf.id
         LEFT JOIN media_tags mt ON mt.media_id = mf.id
         LEFT JOIN tags t ON t.id = mt.tag_id
         WHERE mf.id = ?
         GROUP BY mf.id",
        params![media_id],
    )
    .context("Failed to refresh media_search_fts row")?;

    Ok(())
}

pub fn ensure_media_search_index(conn: &Connection) -> Result<()> {
    if !media_search_index_exists(conn) {
        return Ok(());
    }

    let media_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM media_files", [], |row| row.get(0))
        .context("Failed to count media_files for media_search_fts")?;
    let indexed_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM media_search_fts", [], |row| row.get(0))
        .context("Failed to count media_search_fts rows")?;

    if indexed_count != media_count {
        rebuild_media_search_index(conn)?;
    }

    Ok(())
}

// ─────────────────────────────────────────────
//  查询（带过滤器和分页）
// ─────────────────────────────────────────────

/// 返回 (items, total_count, next_cursor)。page 从 1 开始。
/// 当 cursor 存在时走 keyset 分页（无 OFFSET），total 返回 -1 表示"沿用上次"。
/// library_root_path 从 filter 中读取，用于过滤只显示库根目录范围内的文件
pub fn query_media_files(
    conn: &Connection,
    _page: i64,
    per_page: i64,
    filter: &MediaFilter,
    cursor: Option<&crate::models::MediaCursor>,
    skip_count: bool,
) -> Result<(Vec<MediaFile>, i64, Option<crate::models::MediaCursor>)> {
    // 动态构建 WHERE 子句
    let mut conditions: Vec<String> = Vec::new();
    // 使用 Box<dyn rusqlite::ToSql> 存储参数
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    // 库根路径过滤（最重要的守卫）
    if let Some(ref root) = filter.library_root_path {
        push_library_root_filter(&mut conditions, &mut param_values, "filepath", root);
    }

    // is_trashed 过滤
    conditions.push("is_trashed = ?".to_string());
    param_values.push(Box::new(if filter.only_trashed { 1i32 } else { 0i32 }));

    // 文件类型过滤
    if let Some(ref types) = filter.file_types {
        if !types.is_empty() {
            let placeholders = types.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            conditions.push(format!("filetype IN ({})", placeholders));
            for t in types {
                param_values.push(Box::new(t.clone()));
            }
        }
    }

    // 标签过滤（需要所有指定标签都存在）
    if let Some(ref tag_ids) = filter.tag_ids {
        if !tag_ids.is_empty() {
            let placeholders = tag_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            conditions.push(format!(
                "id IN (SELECT media_id FROM media_tags WHERE tag_id IN ({}) GROUP BY media_id HAVING COUNT(DISTINCT tag_id) = {})",
                placeholders,
                tag_ids.len()
            ));
            for tid in tag_ids {
                param_values.push(Box::new(tid.clone()));
            }
        }
    }

    // 自定义分组过滤（按分类名称隔离）
    if let Some(ref category_name) = filter.category_name {
        if !category_name.is_empty() {
            conditions.push("category_id IN (SELECT id FROM categories WHERE name = ?)".to_string());
            param_values.push(Box::new(category_name.clone()));
        }
    }

    // AI 元数据状态过滤
    match filter.ai_metadata_status.as_deref() {
        Some("filled") => conditions.push(
            "id IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        Some("empty") => conditions.push(
            "id NOT IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        _ if filter.has_ai_metadata => conditions.push(
            "id IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        _ => {}
    }

    // 来源文件夹过滤
    if let Some(ref source) = filter.source_folder {
        if !source.is_empty() {
            conditions.push("source_folder = ?".to_string());
            param_values.push(Box::new(source.clone()));
        }
    }
    
    // 关键字搜索 (文件名, 标签, AI 提示词)
    if let Some(ref keyword) = filter.keyword {
        if let Some(match_query) = build_fts_match_query(keyword) {
            if media_search_index_exists(conn) {
                conditions.push(
                    "id IN (SELECT media_id FROM media_search_fts WHERE media_search_fts MATCH ?)"
                        .to_string(),
                );
                param_values.push(Box::new(match_query));
            } else {
                let like_keyword = format!("%{}%", keyword.trim());
                conditions.push(
                    "(filename LIKE ? OR id IN (SELECT media_id FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE t.name LIKE ?) OR id IN (SELECT media_id FROM ai_metadata WHERE prompt_text LIKE ?))"
                        .to_string(),
                );
                param_values.push(Box::new(like_keyword.clone()));
                param_values.push(Box::new(like_keyword.clone()));
                param_values.push(Box::new(like_keyword));
            }
        }
    }

    // Keyset 分页条件
    if let Some(c) = cursor {
        conditions.push("(imported_at < ? OR (imported_at = ? AND id < ?))".to_string());
        param_values.push(Box::new(c.imported_at));
        param_values.push(Box::new(c.imported_at));
        param_values.push(Box::new(c.id.clone()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let select_sql = format!(
        "SELECT id, filename, filepath, filetype, mime_type, width, height, \
         file_size, created_at, modified_at, imported_at, thumbnail_path, \
         color_dominant, is_trashed, source_folder, sha256, phash, \
         thumbnail_micro_path, thumbnail_preview_path, thumbhash \
         FROM media_files {} \
         ORDER BY imported_at DESC, id DESC \
         LIMIT ?",
        where_clause
    );

    // 将参数转为引用切片以供 rusqlite 使用
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        param_values.iter().map(|b| b.as_ref()).collect();

    // 后续页可跳过 COUNT，前端沿用已有 totalCount。
    let count_sql = format!("SELECT COUNT(*) FROM media_files {}", where_clause);
    let total: i64 = if skip_count {
        -1
    } else {
        conn.query_row(&count_sql, params_refs.as_slice(), |row| row.get(0))
            .context("Failed to count media_files")?
    };

    // 分页查询
    let mut select_params: Vec<&dyn rusqlite::ToSql> = params_refs.clone();
    let limit_box: Box<dyn rusqlite::ToSql> = Box::new(per_page);
    select_params.push(limit_box.as_ref());

    let mut stmt = conn.prepare(&select_sql).context("Failed to prepare select statement")?;
    let items = stmt
        .query_map(select_params.as_slice(), row_to_media_file)
        .context("Failed to query media_files")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect media_files")?;

    // 构造 next_cursor
    let next_cursor = if items.len() == per_page as usize {
        items.last().map(|last| crate::models::MediaCursor {
            imported_at: last.imported_at,
            id: last.id.clone(),
        })
    } else {
        None
    };

    Ok((items, total, next_cursor))
}

// ─────────────────────────────────────────────
//  查询单个文件详情
// ─────────────────────────────────────────────

pub fn get_media_detail(conn: &Connection, id: &str) -> Result<Option<MediaDetail>> {
    // 查询文件基本信息
    let file_opt: Option<MediaFile> = conn
        .query_row(
            "SELECT id, filename, filepath, filetype, mime_type, width, height, \
             file_size, created_at, modified_at, imported_at, thumbnail_path, \
             color_dominant, is_trashed, source_folder, sha256, phash, \
             thumbnail_micro_path, thumbnail_preview_path, thumbhash \
             FROM media_files WHERE id = ?",
            params![id],
            row_to_media_file,
        )
        .optional()
        .context("Failed to query media file by id")?;

    let file = match file_opt {
        None => return Ok(None),
        Some(f) => f,
    };

    // 查询关联标签
    let mut tag_stmt = conn.prepare(
        "SELECT t.id, t.name, t.color \
         FROM tags t \
         INNER JOIN media_tags mt ON mt.tag_id = t.id \
         WHERE mt.media_id = ?",
    )?;
    let tags = tag_stmt
        .query_map(params![id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect tags")?;

    // 查询 AI 元数据
    let ai_metadata: Option<AiMetadata> = conn
        .query_row(
            "SELECT id, media_id, prompt_text, model_name, platform, created_at \
             FROM ai_metadata WHERE media_id = ?",
            params![id],
            |row| {
                Ok(AiMetadata {
                    id: row.get(0)?,
                    media_id: row.get(1)?,
                    prompt_text: row.get(2)?,
                    model_name: row.get(3)?,
                    platform: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()
        .context("Failed to query ai_metadata")?;

    let mut attachment_stmt = conn.prepare(
        "SELECT id, media_id, filename, filepath, file_size, mime_type, created_at
         FROM media_attachments
         WHERE media_id = ?
         ORDER BY created_at DESC, id DESC",
    )?;
    let attachments = attachment_stmt
        .query_map(params![id], row_to_media_attachment)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect attachments")?;

    Ok(Some(MediaDetail {
        file,
        tags,
        ai_metadata,
        category_id: None, // categories 关联表暂未实现
        attachments,
    }))
}

pub fn add_media_attachment(
    conn: &Connection,
    media_id: &str,
    filepath: &str,
    filename: &str,
    file_size: Option<i64>,
    mime_type: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO media_attachments
         (id, media_id, filename, filepath, file_size, mime_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s', 'now'))",
        params![
            Uuid::new_v4().to_string(),
            media_id,
            filename,
            filepath,
            file_size,
            mime_type,
        ],
    )
    .context("Failed to insert media attachment")?;

    Ok(())
}

pub fn remove_media_attachment(conn: &Connection, attachment_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM media_attachments WHERE id = ?",
        params![attachment_id],
    )
    .context("Failed to delete media attachment")?;

    Ok(())
}

// ─────────────────────────────────────────────
//  插入新文件
// ─────────────────────────────────────────────

/// 返回 true 表示插入成功，false 表示已存在（路径重复跳过）。
pub fn insert_media_file(conn: &Connection, file: &MediaFile) -> Result<bool> {
    let result = conn.execute(
        "INSERT OR IGNORE INTO media_files \
         (id, filename, filepath, filetype, mime_type, width, height, \
          file_size, created_at, modified_at, imported_at, thumbnail_path, \
          color_dominant, is_trashed, source_folder, sha256, phash, \
          thumbnail_micro_path, thumbnail_preview_path, thumbhash) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            file.id,
            file.filename,
            file.filepath,
            file.filetype,
            file.mime_type,
            file.width,
            file.height,
            file.file_size,
            file.created_at,
            file.modified_at,
            file.imported_at,
            file.thumbnail_path,
            file.color_dominant,
            if file.is_trashed { 1i32 } else { 0i32 },
            file.source_folder,
            file.sha256,
            file.phash,
            file.thumbnail_micro_path,
            file.thumbnail_preview_path,
            file.thumbhash,
        ],
    );

    match result {
        Ok(0) => Ok(false), // OR IGNORE 触发，行已存在
        Ok(_) => {
            refresh_media_search_document(conn, &file.id)?;
            Ok(true)
        }
        Err(e) => Err(anyhow::Error::from(e).context("Failed to insert media_file")),
    }
}

/// INSERT 或恢复：先尝试正常插入；若 filepath UNIQUE 冲突且旧记录在回收站，
/// 则自动恢复（is_trashed=1→0）并更新元数据。已经是正常状态的才返回 false（跳過）。
pub fn insert_or_restore_media_file(conn: &Connection, file: &MediaFile) -> Result<bool> {
    match insert_media_file(conn, file) {
        Ok(true) => Ok(true),  // 新插入成功
        Ok(false) => {
            // filepath 已存在，检查是否在回收站
            let restored = conn.execute(
                "UPDATE media_files SET is_trashed = 0, thumbnail_path = ?2, \
                 thumbnail_micro_path = ?3, thumbnail_preview_path = ?4, thumbhash = ?5, \
                 sha256 = ?6, phash = ?7, color_dominant = ?8, file_size = ?9, \
                 width = ?10, height = ?11 \
                 WHERE filepath = ?1 AND is_trashed = 1",
                rusqlite::params![
                    file.filepath,
                    file.thumbnail_path,
                    file.thumbnail_micro_path,
                    file.thumbnail_preview_path,
                    file.thumbhash,
                    file.sha256,
                    file.phash,
                    file.color_dominant,
                    file.file_size,
                    file.width,
                    file.height,
                ],
            )?;
            Ok(restored > 0)
        }
        Err(e) => Err(e),
    }
}

/// JSON 恢复专用：INSERT OR REPLACE，强制覆盖已有记录（filepath UNIQUE 冲突时替换）。
/// 用于换电脑从 .nocturne_meta/*.json 重建数据库索引。
pub fn insert_or_replace_media_file(conn: &Connection, file: &MediaFile) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO media_files \
         (id, filename, filepath, filetype, mime_type, width, height, \
          file_size, created_at, modified_at, imported_at, thumbnail_path, \
          color_dominant, is_trashed, source_folder, sha256, phash, \
          thumbnail_micro_path, thumbnail_preview_path, thumbhash) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            file.id,
            file.filename,
            file.filepath,
            file.filetype,
            file.mime_type,
            file.width,
            file.height,
            file.file_size,
            file.created_at,
            file.modified_at,
            file.imported_at,
            file.thumbnail_path,
            file.color_dominant,
            if file.is_trashed { 1i32 } else { 0i32 },
            file.source_folder,
            file.sha256,
            file.phash,
            file.thumbnail_micro_path,
            file.thumbnail_preview_path,
            file.thumbhash,
        ],
    )
    .context("Failed to insert_or_replace media_file")?;
    refresh_media_search_document(conn, &file.id)?;
    Ok(())
}

// ─────────────────────────────────────────────
//  更新标签
// ─────────────────────────────────────────────

/// 事务内：删除该 media 的所有旧标签关联，然后按 tag_names
/// 查找或创建 Tag，最后批量插入新关联。
pub fn update_media_tags(
    conn: &Connection,
    media_id: &str,
    tag_names: &[String],
) -> Result<()> {
    log::info!("[db] Atomic update tags for item: {}", media_id);
    // 删除旧关联
    conn.execute("DELETE FROM media_tags WHERE media_id = ?", params![media_id])
        .context("Failed to delete old media_tags")?;

    for name in tag_names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }

        // 查找或创建 tag
        let tag_id: String = match conn
            .query_row("SELECT id FROM tags WHERE name = ?", params![name], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .context("Failed to query tag by name")?
        {
            Some(id) => id,
            None => {
                let new_id = Uuid::new_v4().to_string();
                // 默认颜色灰色
                conn.execute(
                    "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
                    params![new_id, name, "#6B7280"],
                )
                .context("Failed to insert new tag")?;
                new_id
            }
        };

        conn.execute(
            "INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)",
            params![media_id, tag_id],
        )
        .context("Failed to insert media_tag")?;
    }

    refresh_media_search_document(conn, media_id)?;
    Ok(())
}

// ─────────────────────────────────────────────
//  AI 元数据
// ─────────────────────────────────────────────

pub fn upsert_ai_metadata(
    conn: &Connection,
    media_id: &str,
    prompt: &str,
    model: &str,
    platform: &str,
) -> Result<()> {
    // 先检查是否存在，决定 INSERT 还是 UPDATE
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM ai_metadata WHERE media_id = ?",
            params![media_id],
            |r| r.get(0),
        )
        .optional()
        .context("Failed to query ai_metadata for upsert")?;

    if let Some(existing_id) = existing_id {
        conn.execute(
            "UPDATE ai_metadata SET prompt_text = ?1, model_name = ?2, platform = ?3 WHERE id = ?4",
            params![prompt, model, platform, existing_id],
        )
        .context("Failed to update ai_metadata")?;
    } else {
        let new_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO ai_metadata (id, media_id, prompt_text, model_name, platform) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![new_id, media_id, prompt, model, platform],
        )
        .context("Failed to insert ai_metadata")?;
    }

    refresh_media_search_document(conn, media_id)?;
    Ok(())
}

// ─────────────────────────────────────────────
//  软删除 / 恢复
// ─────────────────────────────────────────────

pub fn set_trashed(conn: &Connection, id: &str, trashed: bool) -> Result<()> {
    conn.execute(
        "UPDATE media_files SET is_trashed = ? WHERE id = ?",
        params![if trashed { 1i32 } else { 0i32 }, id],
    )
    .context("Failed to set is_trashed")?;
    Ok(())
}

// ─────────────────────────────────────────────
//  清空回收站（硬删除）
// ─────────────────────────────────────────────

/// 返回被删除的记录数。
pub fn empty_trash(conn: &Connection) -> Result<i64> {
    let deleted = conn
        .execute("DELETE FROM media_files WHERE is_trashed = 1", [])
        .context("Failed to empty trash")? as i64;

    if media_search_index_exists(conn) {
        conn.execute(
            "DELETE FROM media_search_fts WHERE media_id NOT IN (SELECT id FROM media_files)",
            [],
        )
        .context("Failed to prune media_search_fts rows after empty_trash")?;
    }

    Ok(deleted)
}

// ─────────────────────────────────────────────
//  更新缩略图路径
// ─────────────────────────────────────────────

pub fn update_thumbnail_path(conn: &Connection, id: &str, path: &str) -> Result<()> {
    conn.execute(
        "UPDATE media_files SET thumbnail_path = ? WHERE id = ?",
        params![path, id],
    )
    .context("Failed to update thumbnail_path")?;
    Ok(())
}

/// 更新主色
pub fn update_color_dominant(conn: &Connection, id: &str, color: &str) -> Result<()> {
    conn.execute(
        "UPDATE media_files SET color_dominant = ? WHERE id = ?",
        params![color, id],
    )
    .context("Failed to update color_dominant")?;
    Ok(())
}

/// 更新 preview 档缩略图路径
pub fn update_thumbnail_preview_path(conn: &Connection, id: &str, path: &str) -> Result<()> {
    conn.execute(
        "UPDATE media_files SET thumbnail_preview_path = ? WHERE id = ?",
        params![path, id],
    )
    .context("Failed to update thumbnail_preview_path")?;
    Ok(())
}

/// 通过 ID 获取完整的 MediaFile（用于多档缩略图命令）
pub fn get_media_file_by_id(conn: &Connection, id: &str) -> Result<MediaFile> {
    conn.query_row(
        "SELECT id, filename, filepath, filetype, mime_type, width, height, \
         file_size, created_at, modified_at, imported_at, thumbnail_path, \
         color_dominant, is_trashed, source_folder, sha256, phash, \
         thumbnail_micro_path, thumbnail_preview_path, thumbhash \
         FROM media_files WHERE id = ?",
        params![id],
        row_to_media_file,
    )
    .context("Failed to get media file by id")
}

/// 更新媒体文件名与绝对路径，并同步刷新全文搜索索引
pub fn rename_media_file(
    conn: &Connection,
    id: &str,
    new_filename: &str,
    new_filepath: &str,
    modified_at: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE media_files
         SET filename = ?, filepath = ?, modified_at = ?
         WHERE id = ?",
        params![new_filename, new_filepath, modified_at, id],
    )
    .context("Failed to rename media_file")?;

    refresh_media_search_document(conn, id)?;
    Ok(())
}

// ─────────────────────────────────────────────
//  硬删除文件（永久删除）
// ─────────────────────────────────────────────

/// 永久删除媒体文件记录及其关联数据
pub fn delete_media_file(conn: &Connection, id: &str) -> Result<()> {
    delete_media_search_document(conn, id)?;

    // 删除与该媒体文件关联的所有标签关系
    conn.execute("DELETE FROM media_tags WHERE media_id = ?", params![id])
        .context("Failed to delete media_tags")?;

    // 删除与该媒体文件相关的 AI 元数据
    conn.execute("DELETE FROM ai_metadata WHERE media_id = ?", params![id])
        .context("Failed to delete ai_metadata")?;

    // 删除媒体文件记录本身
    conn.execute("DELETE FROM media_files WHERE id = ?", params![id])
        .context("Failed to delete media_file")?;

    Ok(())
}

// ─────────────────────────────────────────────
//  更新文件路径（移动文件后调用）
// ─────────────────────────────────────────────

/// 更新媒体文件的 filepath 和 source_folder
pub fn update_media_file_path(conn: &mut Connection, id: &str, new_path: &str) -> Result<()> {
    // 从新路径提取 source_folder（相对于库根的第一级子文件夹名）
    let source_folder = std::path::Path::new(new_path)
        .components()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|w| {
            if w[0].as_os_str() == ".nocturne"
                || w[0].as_os_str() == "媒体库"
                || w[0].as_os_str() == "项目文件"
                || w[0].as_os_str() == "回收站"
            {
                w[0].as_os_str().to_str().map(|s| s.to_string())
            } else {
                None
            }
        });

    eprintln!("[update_media_file_path] Updating {} -> {}, source_folder={:?}", id, new_path, source_folder);

    conn.execute(
        "UPDATE media_files SET filepath = ?, source_folder = ? WHERE id = ?",
        params![new_path, source_folder, id],
    )
    .context("Failed to update media_file path")?;
    Ok(())
}

/// 批量查询需要补齐尺寸的图片记录（仅返回 id 和 filepath）
pub fn backfill_missing_dimensions_batch(
    conn: &Connection,
    batch_size: i64,
) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, filepath
         FROM media_files
         WHERE filetype = 'image'
           AND (
                width IS NULL OR height IS NULL
                OR width <= 0 OR height <= 0
                OR width > 100000 OR height > 100000
           )
         ORDER BY imported_at ASC, id ASC
         LIMIT ?1",
    )
    .context("Failed to prepare missing-dimension batch query")?;

    let rows = stmt
        .query_map(params![batch_size], |row| Ok((row.get(0)?, row.get(1)?)))
        .context("Failed to query missing-dimension batch")?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect missing-dimension batch")
}

/// 更新媒体文件的原图尺寸
pub fn update_media_dimensions(conn: &Connection, id: &str, width: i64, height: i64) -> Result<()> {
    conn.execute(
        "UPDATE media_files SET width = ?, height = ? WHERE id = ?",
        params![width, height, id],
    )
    .context("Failed to update media dimensions")?;
    Ok(())
}

// ─────────────────────────────────────────────
//  清空所有数据（用于重新初始化）
// ─────────────────────────────────────────────

/// 清空所有媒体文件、标签和 AI 元数据，返回删除的媒体文件数量
pub fn clear_all_data(conn: &mut Connection) -> Result<i64> {
    eprintln!("[clear_all_data] Starting to clear all data...");

    // 使用事务确保原子性
    let tx = conn.transaction().context("Failed to begin transaction")?;

    // 删除所有媒体标签关联
    let media_tags_deleted = tx.execute("DELETE FROM media_tags", [])
        .context("Failed to delete media_tags")?;
    eprintln!("[clear_all_data] Deleted {} media_tags", media_tags_deleted);

    // 删除所有 AI 元数据
    let ai_metadata_deleted = tx.execute("DELETE FROM ai_metadata", [])
        .context("Failed to delete ai_metadata")?;
    eprintln!("[clear_all_data] Deleted {} ai_metadata", ai_metadata_deleted);

    // 删除所有标签
    let tags_deleted = tx.execute("DELETE FROM tags", [])
        .context("Failed to delete tags")?;
    eprintln!("[clear_all_data] Deleted {} tags", tags_deleted);

    // 删除所有媒体文件
    let media_files_deleted = tx.execute("DELETE FROM media_files", [])
        .context("Failed to delete media_files")?;
    eprintln!("[clear_all_data] Deleted {} media_files", media_files_deleted);

    // 重置自增序列（media_files 用 UUID，此行通常为空操作，不报错即可）
    tx.execute("DELETE FROM sqlite_sequence WHERE name='media_files'", []).ok();

    tx.commit().context("Failed to commit transaction")?;

    // VACUUM 必须在事务外执行（SQLite 限制）
    conn.execute_batch("VACUUM").ok();
    eprintln!("[clear_all_data] VACUUM completed");

    eprintln!("[clear_all_data] Total cleared {} media files", media_files_deleted);
    Ok(media_files_deleted as i64)
}

// ─────────────────────────────────────────────
//  书签 CRUD
// ─────────────────────────────────────────────

/// 新增书签
pub fn insert_bookmark(conn: &Connection, url: &str, title: Option<&str>, description: Option<&str>, tags: Option<&str>) -> Result<i64> {
    let favicon_url = extract_favicon_url(url);
    conn.execute(
        "INSERT INTO bookmarks (url, title, description, favicon_url, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![url, title, description, favicon_url, tags],
    )
    .context("Failed to insert bookmark")?;

    // 返回最后插入的 ID
    let id = conn.last_insert_rowid();
    Ok(id)
}

/// 提取域名的 favicon URL
fn extract_favicon_url(url: &str) -> Option<String> {
    // 从 URL 提取域名
    let domain = url.trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("www.")
        .split('/')
        .next()?;

    // 使用 Google 的 favicon 服务
    Some(format!("https://www.google.com/s2/favicons?domain={}&sz=64", domain))
}

/// 查询所有书签，按 created_at DESC
pub fn query_bookmarks(conn: &Connection) -> Result<Vec<crate::models::Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, url, title, description, favicon_url, tags, created_at FROM bookmarks ORDER BY created_at DESC"
    )
    .context("Failed to prepare bookmarks query")?;

    let bookmarks = stmt
        .query_map([], |row| {
            Ok(crate::models::Bookmark {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                favicon_url: row.get(4)?,
                tags: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .context("Failed to query bookmarks")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect bookmarks")?;

    Ok(bookmarks)
}

/// 删除书签
pub fn delete_bookmark(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?", params![id])
        .context("Failed to delete bookmark")?;
    Ok(())
}

/// 更新书签信息
pub fn update_bookmark(conn: &Connection, id: i64, title: Option<&str>, description: Option<&str>, tags: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE bookmarks SET title = ?, description = ?, tags = ? WHERE id = ?",
        params![title, description, tags, id],
    )
    .context("Failed to update bookmark")?;
    Ok(())
}

// ─────────────────────────────────────────────
//  获取媒体文件统计信息
// ─────────────────────────────────────────────

pub fn get_media_statistics(conn: &Connection, filter: &MediaFilter) -> Result<MediaStatistics> {
    // 动态构建 WHERE 子句
    let mut conditions: Vec<String> = Vec::new();
    // 使用 Box<dyn rusqlite::ToSql> 存储参数
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    // 库根路径过滤（最重要的守卫）
    if let Some(ref root) = filter.library_root_path {
        push_library_root_filter(&mut conditions, &mut param_values, "filepath", root);
    }

    // is_trashed 过滤
    conditions.push("is_trashed = ?".to_string());
    param_values.push(Box::new(if filter.only_trashed { 1i32 } else { 0i32 }));

    // 文件类型过滤
    if let Some(ref types) = filter.file_types {
        if !types.is_empty() {
            let placeholders = types.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            conditions.push(format!("filetype IN ({})", placeholders));
            for t in types {
                param_values.push(Box::new(t.clone()));
            }
        }
    }

    // 标签过滤（需要所有指定标签都存在）
    if let Some(ref tag_ids) = filter.tag_ids {
        if !tag_ids.is_empty() {
            let placeholders = tag_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            conditions.push(format!(
                "id IN (SELECT media_id FROM media_tags WHERE tag_id IN ({}) GROUP BY media_id HAVING COUNT(DISTINCT tag_id) = {})",
                placeholders,
                tag_ids.len()
            ));
            for tid in tag_ids {
                param_values.push(Box::new(tid.clone()));
            }
        }
    }

    // AI 元数据状态过滤
    match filter.ai_metadata_status.as_deref() {
        Some("filled") => conditions.push(
            "id IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        Some("empty") => conditions.push(
            "id NOT IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        _ if filter.has_ai_metadata => conditions.push(
            "id IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        _ => {}
    }

    // 来源文件夹过滤
    if let Some(ref source) = filter.source_folder {
        if !source.is_empty() {
            conditions.push("source_folder = ?".to_string());
            param_values.push(Box::new(source.clone()));
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!("SELECT COUNT(*), SUM(file_size) FROM media_files {}", where_clause);

    // 将参数转为引用切片以供 rusqlite 使用
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        param_values.iter().map(|b| b.as_ref()).collect();

    let (file_count, total_size_option): (i64, Option<i64>) = conn
        .query_row(&sql, params_refs.as_slice(), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .context("Failed to query media statistics")?;

    Ok(MediaStatistics {
        file_count,
        total_size: total_size_option.unwrap_or(0),
    })
}

pub fn get_group_item_counts(
    conn: &Connection,
    filter: &MediaFilter,
    group_names: &[String],
) -> Result<Vec<GroupItemCount>> {
    if group_names.is_empty() {
        return Ok(Vec::new());
    }

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    conditions.push("mf.is_trashed = ?".to_string());
    param_values.push(Box::new(if filter.only_trashed { 1i32 } else { 0i32 }));

    if let Some(ref types) = filter.file_types {
        if !types.is_empty() {
            let placeholders = types.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            conditions.push(format!("mf.filetype IN ({})", placeholders));
            for file_type in types {
                param_values.push(Box::new(file_type.clone()));
            }
        }
    }

    if let Some(ref tag_ids) = filter.tag_ids {
        if !tag_ids.is_empty() {
            let placeholders = tag_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            conditions.push(format!(
                "mf.id IN (SELECT media_id FROM media_tags WHERE tag_id IN ({}) GROUP BY media_id HAVING COUNT(DISTINCT tag_id) = {})",
                placeholders,
                tag_ids.len()
            ));
            for tag_id in tag_ids {
                param_values.push(Box::new(tag_id.clone()));
            }
        }
    }

    match filter.ai_metadata_status.as_deref() {
        Some("filled") => conditions.push(
            "mf.id IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        Some("empty") => conditions.push(
            "mf.id NOT IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        _ if filter.has_ai_metadata => conditions.push(
            "mf.id IN (SELECT media_id FROM ai_metadata WHERE prompt_text IS NOT NULL AND TRIM(prompt_text) != '')".to_string(),
        ),
        _ => {}
    }

    if let Some(ref source_folder) = filter.source_folder {
        if !source_folder.is_empty() {
            conditions.push("mf.source_folder = ?".to_string());
            param_values.push(Box::new(source_folder.clone()));
        }
    }

    if let Some(ref keyword) = filter.keyword {
        let trimmed = keyword.trim();
        if !trimmed.is_empty() {
            conditions.push("(mf.filename LIKE ? OR mf.filepath LIKE ?)".to_string());
            let pattern = format!("%{}%", trimmed);
            param_values.push(Box::new(pattern.clone()));
            param_values.push(Box::new(pattern));
        }
    }

    let group_placeholders = group_names.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    conditions.push(format!("c.name IN ({})", group_placeholders));
    for group_name in group_names {
        param_values.push(Box::new(group_name.clone()));
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT c.name,
                COALESCE(SUM(1 + COALESCE(att.attachment_count, 0)), 0) AS total_count
         FROM media_files mf
         INNER JOIN categories c ON c.id = mf.category_id
         LEFT JOIN (
             SELECT media_id, COUNT(*) AS attachment_count
             FROM media_attachments
             GROUP BY media_id
         ) att ON att.media_id = mf.id
         WHERE {}
         GROUP BY c.name",
        where_clause
    );

    let params_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|value| value.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).context("Failed to prepare group item counts query")?;
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok(GroupItemCount {
                name: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .context("Failed to query group item counts")?;

    rows.collect::<Result<Vec<_>, _>>()
        .context("Failed to collect group item counts")
}

pub fn get_nav_item_counts(
    conn: &Connection,
    nav_ids: &[String],
    library_root: Option<&str>,
) -> Result<Vec<NavItemCount>> {
    if nav_ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = nav_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    let mut inner_conditions = Vec::new();
    if let Some(root) = library_root.map(str::trim).filter(|root| !root.is_empty()) {
        let root = root.trim_end_matches(['\\', '/']);
        inner_conditions.push("mf.filepath LIKE ?".to_string());
        param_values.push(Box::new(format!("{}{}%", root, std::path::MAIN_SEPARATOR)));
    }

    param_values.extend(
        nav_ids
            .iter()
            .cloned()
            .map(|nav_id| Box::new(nav_id) as Box<dyn rusqlite::ToSql>),
    );

    let inner_where_clause = if inner_conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", inner_conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT nav_id, COUNT(*)
         FROM (
             SELECT CASE
                 WHEN mf.source_folder = '灵感库' AND mf.is_trashed = 0 THEN 'library'
                 WHEN mf.source_folder = 'AI 提示词库' AND mf.is_trashed = 0 THEN 'ai-prompts'
                 WHEN mf.source_folder = '作品集' AND mf.is_trashed = 0 THEN 'projects'
                 WHEN mf.is_trashed = 1 THEN 'trash'
                 ELSE mf.source_folder
             END AS nav_id
             FROM media_files mf
             {}
         ) grouped
         WHERE nav_id IN ({})
         GROUP BY nav_id",
        inner_where_clause,
        placeholders
    );

    let params_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|value| value.as_ref()).collect();

    let mut counts_by_nav: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut stmt = conn.prepare(&sql).context("Failed to prepare nav item counts query")?;
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .context("Failed to execute nav item counts query")?;

    for row in rows {
        let (nav_id, count) = row.context("Failed to read nav item counts row")?;
        counts_by_nav.insert(nav_id, count);
    }

    let mut results = Vec::with_capacity(nav_ids.len());
    for nav_id in nav_ids {
        results.push(NavItemCount {
            nav_id: nav_id.clone(),
            count: counts_by_nav.get(nav_id).copied().unwrap_or(0),
        });
    }

    Ok(results)
}

// ─────────────────────────────────────────────
//  文件夹迁移后更新数据库路径
// ─────────────────────────────────────────────

/// 更新媒体文件路径中的旧文件夹名为新文件夹名
/// - 媒体库 → 灵感库
/// - 项目文件 → 作品集
pub fn update_folder_paths_in_db(conn: &mut Connection) -> Result<i64> {
    eprintln!("[update_folder_paths_in_db] Updating database paths after folder migration...");

    let tx = conn.transaction().context("Failed to begin transaction for folder migration")?;
    let mut updated_count = 0i64;

    // 更新媒体库路径
    let media_lib_updated = tx.execute(
        "UPDATE media_files SET filepath = REPLACE(filepath, '\\\\媒体库\\\\', '\\\\灵感库\\\\') \
         WHERE filepath LIKE '%\\\\媒体库\\\\%'",
        [],
    )
    .context("Failed to update 媒体库 paths")? as i64;
    eprintln!("[update_folder_paths_in_db] Updated {} media_files (媒体库→灵感库)", media_lib_updated);
    updated_count += media_lib_updated;

    // 更新项目文件路径
    let projects_updated = tx.execute(
        "UPDATE media_files SET filepath = REPLACE(filepath, '\\\\项目文件\\\\', '\\\\作品集\\\\') \
         WHERE filepath LIKE '%\\\\项目文件\\\\%'",
        [],
    )
    .context("Failed to update 项目文件 paths")? as i64;
    eprintln!("[update_folder_paths_in_db] Updated {} media_files (项目文件→作品集)", projects_updated);
    updated_count += projects_updated;

    // 更新 source_folder 字段
    let source_updated_1 = tx.execute(
        "UPDATE media_files SET source_folder = '灵感库' WHERE source_folder = '媒体库'",
        [],
    )
    .context("Failed to update source_folder 媒体库")? as i64;

    let source_updated_2 = tx.execute(
        "UPDATE media_files SET source_folder = '作品集' WHERE source_folder = '项目文件'",
        [],
    )
    .context("Failed to update source_folder 项目文件")? as i64;

    tx.commit().context("Failed to commit folder migration transaction")?;

    eprintln!("[update_folder_paths_in_db] Updated {} source_folder entries", source_updated_1 + source_updated_2);

    eprintln!("[update_folder_paths_in_db] Database path migration completed. Total updated: {}", updated_count);
    Ok(updated_count)
}

fn normalize_windows_root(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_string()
}

fn legacy_nocturne_root_from_path(path: &str) -> Option<String> {
    let normalized = normalize_windows_root(path);
    let marker = "\\NocturneGallery\\";
    if let Some(index) = normalized.find(marker) {
        return Some(normalized[..index + "\\NocturneGallery".len()].to_string());
    }

    normalized
        .ends_with("\\NocturneGallery")
        .then_some(normalized)
}

pub fn update_library_root_prefixes(conn: &mut Connection, library_root: &str) -> Result<i64> {
    let current_root = normalize_windows_root(library_root);
    let mut legacy_roots = HashSet::new();

    {
        let mut stmt = conn
            .prepare(
                "SELECT filepath, thumbnail_path, thumbnail_micro_path, thumbnail_preview_path
                 FROM media_files",
            )
            .context("Failed to prepare legacy library root scan")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .context("Failed to scan legacy library roots")?;

        for row in rows {
            let (filepath, thumbnail_path, thumbnail_micro_path, thumbnail_preview_path) =
                row.context("Failed to read legacy library root row")?;
            for value in [filepath, thumbnail_path, thumbnail_micro_path, thumbnail_preview_path]
                .into_iter()
                .flatten()
            {
                if let Some(root) = legacy_nocturne_root_from_path(&value) {
                    if !root.eq_ignore_ascii_case(&current_root) {
                        legacy_roots.insert(root);
                    }
                }
            }
        }
    }

    if legacy_roots.is_empty() {
        return Ok(0);
    }

    let tx = conn
        .transaction()
        .context("Failed to begin transaction for library root migration")?;
    let mut updated_count = 0i64;
    let columns = [
        "filepath",
        "thumbnail_path",
        "thumbnail_micro_path",
        "thumbnail_preview_path",
    ];
    let current_root_slash = current_root.replace('\\', "/");

    for legacy_root in legacy_roots {
        let legacy_root_slash = legacy_root.replace('\\', "/");
        for column in columns {
            let sql = if column == "filepath" {
                format!(
                    "UPDATE media_files
                     SET {column} = REPLACE({column}, ?1, ?2)
                     WHERE {column} LIKE ?3
                       AND NOT EXISTS (
                         SELECT 1 FROM media_files AS existing
                         WHERE existing.filepath = REPLACE(media_files.{column}, ?1, ?2)
                       )",
                )
            } else {
                format!(
                    "UPDATE media_files
                     SET {column} = REPLACE({column}, ?1, ?2)
                     WHERE {column} LIKE ?3",
                )
            };
            let updated = tx
                .execute(
                    &sql,
                    params![
                        legacy_root.as_str(),
                        current_root.as_str(),
                        format!("{}%", legacy_root),
                    ],
                )
                .with_context(|| format!("Failed to rebase {} from legacy library root", column))?
                as i64;
            updated_count += updated;

            let slash_sql = if column == "filepath" {
                format!(
                    "UPDATE media_files
                     SET {column} = REPLACE({column}, ?1, ?2)
                     WHERE {column} LIKE ?3
                       AND NOT EXISTS (
                         SELECT 1 FROM media_files AS existing
                         WHERE existing.filepath = REPLACE(media_files.{column}, ?1, ?2)
                       )",
                )
            } else {
                format!(
                    "UPDATE media_files
                     SET {column} = REPLACE({column}, ?1, ?2)
                     WHERE {column} LIKE ?3",
                )
            };
            let slash_updated = tx
                .execute(
                    &slash_sql,
                    params![
                        legacy_root_slash.as_str(),
                        current_root_slash.as_str(),
                        format!("{}%", legacy_root_slash),
                    ],
                )
                .with_context(|| {
                    format!("Failed to rebase slash-normalized {} from legacy library root", column)
                })? as i64;
            updated_count += slash_updated;
        }
    }

    tx.commit()
        .context("Failed to commit library root migration transaction")?;
    eprintln!(
        "[update_library_root_prefixes] Rebased {} media file path fields to {}",
        updated_count, current_root
    );
    Ok(updated_count)
}

// ─────────────────────────────────────────────
//  缩略图重新生成
// ─────────────────────────────────────────────

/// 查询所有需要重新生成缩略图的媒体文件
/// 返回 (media_id, filepath) 列表
pub fn query_media_files_for_regenerate(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, filepath FROM media_files WHERE filetype = 'image' AND thumbnail_micro_path IS NULL AND is_trashed = 0 ORDER BY imported_at DESC, id DESC"
    )
    .context("Failed to prepare regenerate query")?;

    let files = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect media files for regenerate")?;

    Ok(files)
}

/// 清空所有缩略图路径记录
pub fn clear_all_thumbnail_paths(conn: &Connection) -> Result<usize> {
    let updated = conn.execute(
        "UPDATE media_files SET
            thumbnail_path = NULL,
            thumbnail_micro_path = NULL,
            thumbnail_preview_path = NULL",
        [],
    )
    .context("Failed to clear thumbnail paths")?;

    Ok(updated)
}

// ─────────────────────────────────────────────
//  用户偏好设置（替代 localStorage）
// ─────────────────────────────────────────────

pub fn get_preference(conn: &Connection, key: &str) -> Result<Option<String>> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM user_preferences WHERE key = ?",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .context("Failed to query preference")?;
    Ok(value)
}

pub fn set_preference(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO user_preferences (key, value) VALUES (?, ?)",
        params![key, value],
    )
    .context("Failed to set preference")?;
    Ok(())
}

// ─────────────────────────────────────────────
//  重复检测
// ─────────────────────────────────────────────

/// 通过 SHA256 精确匹配查找重复
pub fn find_by_sha256(conn: &Connection, sha256: &str) -> Result<Option<MediaFile>> {
    let file_opt: Option<MediaFile> = conn
        .query_row(
            "SELECT id, filename, filepath, filetype, mime_type, width, height, \
             file_size, created_at, modified_at, imported_at, thumbnail_path, \
             color_dominant, is_trashed, source_folder, sha256, phash, \
             thumbnail_micro_path, thumbnail_preview_path, thumbhash \
             FROM media_files WHERE sha256 = ? LIMIT 1",
            params![sha256],
            row_to_media_file,
        )
        .optional()
        .context("Failed to query by sha256")?;
    Ok(file_opt)
}

/// 查询所有有 phash 的记录（用于相似性检测）
pub fn find_by_phash_threshold(conn: &Connection, phash: u64, max_distance: u32) -> Result<Vec<MediaFile>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, filepath, filetype, mime_type, width, height, \
         file_size, created_at, modified_at, imported_at, thumbnail_path, \
         color_dominant, is_trashed, source_folder, sha256, phash, \
         thumbnail_micro_path, thumbnail_preview_path, thumbhash \
         FROM media_files WHERE phash IS NOT NULL"
    ).context("Failed to prepare phash query")?;

    let files = stmt
        .query_map([], |row| row_to_media_file(row))?
        .filter_map(|r| r.ok())
        .filter(|f| {
            if let Some(p) = f.phash {
                crate::media::hash::hamming_distance(p as u64, phash) <= max_distance
            } else {
                false
            }
        })
        .collect();

    Ok(files)
}

pub fn get_media_duplicate_placement(
    conn: &Connection,
    media_id: &str,
) -> Result<(Option<String>, Option<String>)> {
    conn.query_row(
        "SELECT mf.source_folder, c.name
         FROM media_files mf
         LEFT JOIN categories c ON c.id = mf.category_id
         WHERE mf.id = ?",
        params![media_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .context("Failed to query duplicate placement")?
    .ok_or_else(|| anyhow::anyhow!("Duplicate media not found"))
}

/// 更新文件的 sha256 和 phash
pub fn update_file_hashes(conn: &Connection, id: &str, sha256: &str, phash: i64) -> Result<()> {
    conn.execute(
        "UPDATE media_files SET sha256 = ?, phash = ? WHERE id = ?",
        params![sha256, phash, id],
    )
    .context("Failed to update file hashes")?;
    Ok(())
}

/// 统计 sha256 为 NULL 的图片数量
pub fn count_missing_hashes(conn: &Connection) -> Result<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_files WHERE filetype = 'image' AND sha256 IS NULL",
        [],
        |row| row.get(0),
    ).context("Failed to count missing hashes")?;
    Ok(count)
}

/// 批量计算缺失的 sha256 和 phash（每次处理一批）
pub fn backfill_hashes_batch(conn: &Connection, batch_size: i64) -> Result<Vec<(String, String)>> {
    // 获取一批缺少哈希的文件路径
    let mut stmt = conn.prepare(
        "SELECT id, filepath FROM media_files WHERE filetype = 'image' AND sha256 IS NULL LIMIT ?"
    ).context("Failed to prepare backfill query")?;

    let rows: Vec<(String, String)> = stmt
        .query_map(params![batch_size], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

// ─────────────────────────────────────────────
//  AI Agent 工具函数
// ─────────────────────────────────────────────

/// AI 搜索：全文搜索 filename + ai_prompt
pub fn ai_search_items(
    conn: &Connection,
    query: &str,
    tags: Option<&[String]>,
    category_id: Option<&str>,
    limit: i64,
) -> Result<Vec<ItemSummary>> {
    let mut conditions = vec!["is_trashed = 0".to_string()];
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    // 搜索 filename + ai_prompt
    if !query.trim().is_empty() {
        if let Some(match_query) = build_fts_match_query(query) {
            if media_search_index_exists(conn) {
                conditions.push(
                    "id IN (SELECT media_id FROM media_search_fts WHERE media_search_fts MATCH ?)"
                        .to_string(),
                );
                param_values.push(Box::new(match_query));
            } else {
                conditions.push(
                    "(filename LIKE ? OR id IN (SELECT media_id FROM ai_metadata WHERE prompt_text LIKE ?))".to_string()
                );
                let like_query = format!("%{}%", query);
                param_values.push(Box::new(like_query.clone()));
                param_values.push(Box::new(like_query));
            }
        }
    }

    // 按标签过滤
    if let Some(tag_list) = tags {
        if !tag_list.is_empty() {
            let placeholders = tag_list.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            conditions.push(
                format!("id IN (SELECT media_id FROM media_tags WHERE tag_id IN ({}) GROUP BY media_id HAVING COUNT(DISTINCT tag_id) = {})", placeholders, tag_list.len())
            );
            for t in tag_list {
                param_values.push(Box::new(t.clone()));
            }
        }
    }

    // 按分类过滤
    if let Some(cat_id) = category_id {
        conditions.push("category_id = ?".to_string());
        param_values.push(Box::new(cat_id.to_string()));
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT mf.id, mf.filename, mf.filetype, mf.thumbnail_path,
                am.prompt_text, mf.created_at,
                GROUP_CONCAT(t.name, '|') as tag_names,
                c.name as category_name
         FROM media_files mf
         LEFT JOIN ai_metadata am ON am.media_id = mf.id
         LEFT JOIN media_tags mt ON mt.media_id = mf.id
         LEFT JOIN tags t ON t.id = mt.tag_id
         LEFT JOIN categories c ON c.id = mf.category_id
         WHERE {}
         GROUP BY mf.id
         ORDER BY mf.imported_at DESC, mf.id DESC
         LIMIT ?",
        where_clause
    );

    // 添加 limit 参数
    param_values.push(Box::new(limit));

    let params_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|b| b.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).context("Failed to prepare search query")?;
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            let tag_names: Option<String> = row.get(6)?;
            let tags: Vec<String> = tag_names
                .unwrap_or_default()
                .split('|')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            Ok(ItemSummary {
                id: row.get(0)?,
                filename: row.get(1)?,
                filetype: row.get(2)?,
                thumbnail_path: row.get(3)?,
                ai_prompt: row.get(4)?,
                tags,
                category_name: row.get(7)?,
                created_at: row.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// 为素材添加标签（不存在则自动创建）
pub fn add_media_tags(conn: &Connection, media_id: &str, tag_names: &[String]) -> Result<()> {
    log::info!("[db] Adding tags to item {}: {:?}", media_id, tag_names);

    for name in tag_names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }

        // 查找或创建 tag
        let tag_id: String = match conn
            .query_row("SELECT id FROM tags WHERE name = ?", params![name], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .context("Failed to query tag by name")?
        {
            Some(id) => id,
            None => {
                let new_id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
                    params![new_id, name, "#6B7280"],
                )
                .context("Failed to insert new tag")?;
                new_id
            }
        };

        conn.execute(
            "INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)",
            params![media_id, tag_id],
        )
        .context("Failed to insert media_tag")?;
    }

    refresh_media_search_document(conn, media_id)?;
    Ok(())
}

/// 设置素材分类（不存在则自动创建）
pub fn set_media_category(conn: &Connection, media_id: &str, category_name: &str) -> Result<()> {
    log::info!("[db] Setting category for item {}: {}", media_id, category_name);
    // 查找或创建 category
    let category_id: String = match conn
        .query_row("SELECT id FROM categories WHERE name = ?", params![category_name], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .context("Failed to query category by name")?
    {
        Some(id) => id,
        None => {
            let new_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO categories (id, name, sort_order) VALUES (?1, ?2, ?3)",
                params![new_id, category_name, 0],
            )
            .context("Failed to insert new category")?;
            new_id
        }
    };

    conn.execute(
        "UPDATE media_files SET category_id = ? WHERE id = ?",
        params![category_id, media_id],
    )
    .context("Failed to update media category")?;

    Ok(())
}

/// 获取素材完整详情
pub fn get_item_detail(conn: &Connection, id: &str) -> Result<Option<ItemDetail>> {
    let row_opt: Option<(
        String, String, String, String, Option<i32>, Option<i32>,
        i64, Option<String>, Option<String>,
        Option<String>, Option<String>, Option<String>, Option<String>,
        i64,
    )> = conn.query_row(
        "SELECT mf.id, mf.filename, mf.filepath, mf.filetype,
                mf.width, mf.height, mf.file_size,
                mf.thumbnail_path, mf.color_dominant,
                am.prompt_text, am.model_name, am.platform,
                c.name as category_name,
                mf.imported_at
         FROM media_files mf
         LEFT JOIN ai_metadata am ON am.media_id = mf.id
         LEFT JOIN categories c ON c.id = mf.category_id
         WHERE mf.id = ?",
        params![id],
        |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?,
                row.get(7)?, row.get(8)?,
                row.get(9)?, row.get(10)?, row.get(11)?,
                row.get(12)?, row.get(13)?,
            ))
        },
    ).optional().context("Failed to query item detail")?;

    let (id, filename, filepath, filetype, width, height, file_size,
         thumbnail_path, color_dominant, ai_prompt, ai_model, ai_platform, category_name, created_at) = match row_opt {
        Some(t) => t,
        None => return Ok(None),
    };

    // 获取标签列表
    let mut tag_stmt = conn.prepare(
        "SELECT t.name FROM tags t INNER JOIN media_tags mt ON mt.tag_id = t.id WHERE mt.media_id = ?"
    )?;
    let tags: Vec<String> = tag_stmt
        .query_map(params![id], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Some(ItemDetail {
        id,
        filename,
        filepath,
        filetype,
        width,
        height,
        file_size,
        thumbnail_path,
        color_dominant,
        ai_prompt,
        ai_model,
        ai_platform,
        tags,
        category_name,
        created_at,
    }))
}

/// 更新素材的 AI 提示词
pub fn update_ai_prompt_text(conn: &Connection, media_id: &str, prompt: &str) -> Result<()> {
    log::info!("[db] Updating AI prompt for item: {}", media_id);
    // 检查是否存在 ai_metadata 记录
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_metadata WHERE media_id = ?)",
        params![media_id],
        |r| r.get(0),
    ).context("Failed to check ai_metadata existence")?;

    if exists {
        conn.execute(
            "UPDATE ai_metadata SET prompt_text = ? WHERE media_id = ?",
            params![prompt, media_id],
        )
        .context("Failed to update ai_metadata prompt")?;
    } else {
        let new_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO ai_metadata (id, media_id, prompt_text) VALUES (?1, ?2, ?3)",
            params![new_id, media_id, prompt],
        )
        .context("Failed to insert ai_metadata")?;
    }

    refresh_media_search_document(conn, media_id)?;
    Ok(())
}

/// 批量获取素材摘要
pub fn batch_get_item_summaries(conn: &Connection, ids: &[String]) -> Result<Vec<ItemSummary>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT mf.id, mf.filename, mf.filetype, mf.thumbnail_path,
                am.prompt_text, mf.created_at,
                GROUP_CONCAT(t.name, '|') as tag_names,
                c.name as category_name
         FROM media_files mf
         LEFT JOIN ai_metadata am ON am.media_id = mf.id
         LEFT JOIN media_tags mt ON mt.media_id = mf.id
         LEFT JOIN tags t ON t.id = mt.tag_id
         LEFT JOIN categories c ON c.id = mf.category_id
         WHERE mf.id IN ({})
         GROUP BY mf.id",
        placeholders
    );

    let mut stmt = conn.prepare(&sql).context("Failed to prepare batch query")?;

    let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params.as_slice(), |row| {
            let tag_names: Option<String> = row.get(6)?;
            let tags: Vec<String> = tag_names
                .unwrap_or_default()
                .split('|')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            Ok(ItemSummary {
                id: row.get(0)?,
                filename: row.get(1)?,
                filetype: row.get(2)?,
                thumbnail_path: row.get(3)?,
                ai_prompt: row.get(4)?,
                tags,
                category_name: row.get(7)?,
                created_at: row.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// 获取提示词反推数据
pub fn get_reverse_prompt_data(conn: &Connection, item_id: &str) -> Result<Option<ReversePromptData>> {
    let row_opt: Option<(String, String, String, Option<String>, Option<String>, i64, Option<String>, Option<String>)> = conn.query_row(
        "SELECT mf.id, mf.filename, mf.filepath, mf.thumbnail_path,
                mf.color_dominant, mf.file_size, mf.mime_type,
                am.prompt_text
         FROM media_files mf
         LEFT JOIN ai_metadata am ON am.media_id = mf.id
         WHERE mf.id = ?",
        params![item_id],
        |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?,
            ))
        },
    ).optional().context("Failed to query reverse prompt data")?;

    let (item_id, filename, filepath, thumbnail_path, color_dominant, file_size, mime_type, existing_prompt) = match row_opt {
        Some(t) => t,
        None => return Ok(None),
    };

    Ok(Some(ReversePromptData {
        item_id,
        filename,
        filepath,
        thumbnail_path,
        existing_prompt,
        color_dominant,
        file_size,
        mime_type,
    }))
}

/// 获取库统计信息
pub fn get_library_stats(conn: &Connection) -> Result<LibraryStats> {
    let total_items: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_files WHERE is_trashed = 0",
        [],
        |r| r.get(0),
    ).context("Failed to count total items")?;

    let total_with_prompt: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media_files mf WHERE mf.is_trashed = 0 AND EXISTS (SELECT 1 FROM ai_metadata am WHERE am.media_id = mf.id AND am.prompt_text IS NOT NULL AND TRIM(am.prompt_text) != '')",
        [],
        |r| r.get(0),
    ).context("Failed to count items with prompt")?;

    let total_without_prompt = total_items - total_with_prompt;

    let total_tags: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tags",
        [],
        |r| r.get(0),
    ).context("Failed to count tags")?;

    let total_categories: i64 = conn.query_row(
        "SELECT COUNT(*) FROM categories",
        [],
        |r| r.get(0),
    ).context("Failed to count categories")?;

    let mut tag_stmt = conn.prepare(
        "SELECT t.name, COUNT(mt.media_id) as cnt
         FROM tags t
         INNER JOIN media_tags mt ON mt.tag_id = t.id
         GROUP BY t.id
         ORDER BY cnt DESC
         LIMIT 10"
    ).context("Failed to prepare top tags query")?;

    let top_tags: Vec<TagCount> = tag_stmt
        .query_map([], |row| {
            Ok(TagCount {
                name: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    let recent_items = ai_search_items(conn, "", None, None, 5)?;

    Ok(LibraryStats {
        total_items,
        total_with_prompt,
        total_without_prompt,
        total_tags,
        total_categories,
        top_tags,
        recent_items,
    })
}

/// 保存搜索结果到书签表
pub fn insert_search_bookmark(conn: &mut Connection, title: &str, url: &str, content: &str, tags: Option<&[String]>) -> Result<i64> {
    let tx = conn.transaction().context("Failed to begin transaction for search bookmark")?;

    tx.execute(
        "INSERT INTO bookmarks (url, title, description, tags) VALUES (?1, ?2, ?3, ?4)",
        params![url, title, content, tags.map(|t| t.join(",")).unwrap_or_default()],
    )
    .context("Failed to insert bookmark")?;

    let record_id = tx.last_insert_rowid();

    // 如果有标签，创建标签关联
    if let Some(tag_list) = tags {
        for name in tag_list {
            let name = name.trim();
            if name.is_empty() { continue; }

            let tag_id: String = match tx
                .query_row("SELECT id FROM tags WHERE name = ?", params![name], |r| {
                    r.get::<_, String>(0)
                })
                .optional()
                .context("Failed to query tag by name")?
            {
                Some(id) => id,
                None => {
                    let new_id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
                        params![new_id, name, "#6B7280"],
                    )
                    .context("Failed to insert new tag")?;
                    new_id
                }
            };

            // 使用 record_id 作为 media_id（书签和素材共用标签系统）
            tx.execute(
                "INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)",
                params![record_id.to_string(), tag_id],
            )
            .context("Failed to insert bookmark tag")?;
        }
    }

    tx.commit().context("Failed to commit search bookmark transaction")?;
    Ok(record_id)
}
