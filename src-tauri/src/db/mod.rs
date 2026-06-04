pub mod crud;

use anyhow::Context;
use rusqlite::Connection;

const SCHEMA_SQL: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL UNIQUE,
    filetype TEXT NOT NULL,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    file_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    imported_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    thumbnail_path TEXT,
    color_dominant TEXT,
    is_trashed INTEGER DEFAULT 0,
    pre_trash_folder TEXT,
    source_folder TEXT,
    sha256 TEXT,
    phash INTEGER
);

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tags (
    media_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (media_id, tag_id),
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_metadata (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL UNIQUE,
    prompt_text TEXT,
    model_name TEXT,
    platform TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_attachments (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    UNIQUE (media_id, filepath)
);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    sort_order INTEGER DEFAULT 0,
    icon TEXT,
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT,
    description TEXT,
    favicon_url TEXT,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
);

-- 原有索引
CREATE INDEX IF NOT EXISTS idx_media_files_trashed ON media_files(is_trashed);
CREATE INDEX IF NOT EXISTS idx_media_files_imported ON media_files(imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_files_trashed_imported ON media_files(is_trashed, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_tags_media ON media_tags(media_id);
CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags(tag_id);

-- 新增性能优化索引
CREATE INDEX IF NOT EXISTS idx_media_files_collection ON media_files(source_folder);
CREATE INDEX IF NOT EXISTS idx_media_files_created ON media_files(created_at);
CREATE INDEX IF NOT EXISTS idx_media_files_type ON media_files(filetype);
CREATE INDEX IF NOT EXISTS idx_media_files_sha256 ON media_files(sha256);
CREATE INDEX IF NOT EXISTS idx_media_files_phash ON media_files(phash);

-- 复合索引：keyset 分页查询加速
CREATE INDEX IF NOT EXISTS idx_media_files_list ON media_files(is_trashed, imported_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_media_files_source_list ON media_files(source_folder, is_trashed, imported_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_media_attachments_media ON media_attachments(media_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_updated ON ai_chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session ON ai_chat_messages(session_id, created_at ASC);
"#;

const SEARCH_INDEX_SQL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS media_search_fts
USING fts5(
    media_id UNINDEXED,
    filename,
    prompt_text,
    tags,
    tokenize = 'unicode61'
);
"#;

/// 初始化数据库：创建表结构，确保缩略图目录存在，并执行迁移。
/// db_path 为完整的 .db 文件路径（例如 /data/nocturne.db）。
pub fn init_db(db_path: &str) -> anyhow::Result<()> {
    // 确保父目录存在
    if let Some(parent) = std::path::Path::new(db_path).parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory: {}", parent.display()))?;
    }

    let conn = open_conn(db_path)?;

    // 性能优化：设置 PRAGMA
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch("PRAGMA cache_size=-64000;")?;  // 64MB cache
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch("PRAGMA temp_store=MEMORY;")?;
    conn.execute_batch("PRAGMA mmap_size=536870912;")?;  // 512MB mmap

    // 执行建表 SQL
    conn.execute_batch(SCHEMA_SQL)
        .context("Failed to execute schema SQL")?;

    // 执行迁移：添加 source_folder 列（如果不存在）
    conn.execute_batch(
        "ALTER TABLE media_files ADD COLUMN source_folder TEXT;",
    ).ok();

    conn.execute(
        "ALTER TABLE media_files ADD COLUMN pre_trash_folder TEXT;",
        [],
    ).ok();

    // 执行迁移：添加 sha256 和 phash 列（重复检测）
    conn.execute_batch(
        "ALTER TABLE media_files ADD COLUMN sha256 TEXT;
         ALTER TABLE media_files ADD COLUMN phash INTEGER;",
    ).ok();

    // 执行迁移：添加 category_id 列（AI Agent 分类管理）
    conn.execute_batch(
        "ALTER TABLE media_files ADD COLUMN category_id TEXT;",
    ).ok();

    // 创建索引（如果不存在）
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_media_files_category ON media_files(category_id);",
    ).ok();

    // 执行迁移：添加缩略图多档位列（v5.8 升级）
    // 备份 DB：只在首次迁移时执行（检查 thumbhash 列是否已存在）
    let has_thumbhash: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('media_files') WHERE name='thumbhash'",
        [],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0;

    if !has_thumbhash {
        // 备份 DB 到 .nocturne/backup_v58_{YYYYMMDD}.db
        let db_path_str = conn.path().unwrap_or("").to_string();
        if !db_path_str.is_empty() {
            let db_path = std::path::Path::new(&db_path_str);
            if let Some(parent) = db_path.parent() {
                let backup_dir = parent.join(".nocturne");
                let _ = std::fs::create_dir_all(&backup_dir);
                let today = chrono::Local::now().format("%Y%m%d");
                let backup_path = backup_dir.join(format!("backup_v58_{}.db", today));
                if let Err(e) = std::fs::copy(&db_path_str, &backup_path) {
                    log::warn!("[init_db] Failed to backup DB before migration: {}", e);
                } else {
                    log::info!("[init_db] DB backed up to: {}", backup_path.display());
                }
            }
        }
    }

    conn.execute_batch(
        "ALTER TABLE media_files ADD COLUMN thumbnail_micro_path TEXT;
         ALTER TABLE media_files ADD COLUMN thumbnail_preview_path TEXT;
         ALTER TABLE media_files ADD COLUMN thumbhash TEXT;",
    ).ok();

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS media_attachments (
            id TEXT PRIMARY KEY,
            media_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            filepath TEXT NOT NULL,
            file_size INTEGER,
            mime_type TEXT,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
            UNIQUE (media_id, filepath)
        );
        CREATE INDEX IF NOT EXISTS idx_media_attachments_media ON media_attachments(media_id, created_at DESC);",
    ).ok();

    if let Err(error) = conn.execute_batch(SEARCH_INDEX_SQL) {
        log::warn!("[init_db] Failed to create media_search_fts: {}", error);
    } else if let Err(error) = crud::ensure_media_search_index(&conn) {
        log::warn!("[init_db] Failed to backfill media_search_fts: {}", error);
    }

    Ok(())
}

/// 打开到指定路径的 SQLite 连接。每次调用均返回独立连接，线程安全。
pub fn open_conn(db_path: &str) -> anyhow::Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("Failed to open SQLite database at: {}", db_path))?;

    // 连接级 PRAGMA 需要在每次 open_conn 时都重放，才能覆盖所有短连接命令。
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch("PRAGMA cache_size=-64000;")?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch("PRAGMA temp_store=MEMORY;")?;
    conn.execute_batch("PRAGMA mmap_size=536870912;")?;
    conn.execute_batch("PRAGMA busy_timeout=15000;")?;

    Ok(conn)
}
