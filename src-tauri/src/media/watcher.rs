//! Gega Gallery — 文件监控模块
//!
//! 使用 notify crate 监控灵感库根目录下的文件变化。
//! 自动检测新增文件并入库。

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use rayon::prelude::*;
use rusqlite::OptionalExtension;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::db::open_conn;
use crate::media::scanner;
use tauri::{AppHandle, Emitter};

static IN_FLIGHT_ENRICH: Lazy<Mutex<HashSet<PathBuf>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// 监控器句柄
pub struct LibraryWatcher {
    _watcher: RecommendedWatcher,
    _library_root: PathBuf,
    _db_path: String,
    /// 关闭信号：设置为 true 时后台线程退出
    shutdown: Arc<AtomicBool>,
}

/// 防抖配置
const DEBOUNCE_SECONDS: u64 = 2;

impl LibraryWatcher {
    /// 创建并启动监控器
    pub fn new(library_root: &str, db_path: &str, app: AppHandle) -> Result<Self, String> {
        let library_root_path = PathBuf::from(library_root);
        let db_path_string = db_path.to_string();

        Self::start_watcher(library_root_path, db_path_string, app)
    }

    fn start_watcher(
        library_root: PathBuf,
        db_path: String,
        app: AppHandle,
    ) -> Result<Self, String> {
        let (tx, rx) = channel();

        // 创建监控器
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_secs(2)),
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        // 监控整个库目录
        watcher
            .watch(&library_root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch directory: {}", e))?;

        eprintln!(
            "[watcher] Started file system event loop for: {:?}",
            library_root
        );

        // 创建关闭信号
        let shutdown = Arc::new(AtomicBool::new(false));

        // 在后台启动事件处理循环
        Self::start_event_loop(
            rx,
            library_root.clone(),
            db_path.clone(),
            Arc::clone(&shutdown),
            app,
        );

        Ok(Self {
            _watcher: watcher,
            _library_root: library_root,
            _db_path: db_path,
            shutdown,
        })
    }

    /// 后台事件处理循环
    ///
    /// 批量化设计：先 blocking 接收 1 个事件唤醒，然后 try_recv 在 BATCH_DRAIN_WINDOW
    /// 时间窗口内排干所有 pending 事件，去重 + 防抖后用 rayon par_iter 并行处理整批。
    /// 这样外部 git checkout / rsync 一次性塞进几千文件时，事件不会卡在 channel 里
    /// 串行流过，而是被批量化交给线程池并行 import（CPU-bound 部分如 SHA256/pHash/
    /// 解码可并行；DB 写入 SQLite WAL 自然串行化）。
    fn start_event_loop(
        rx: std::sync::mpsc::Receiver<notify::Event>,
        library_root: PathBuf,
        db_path: String,
        shutdown: Arc<AtomicBool>,
        app: AppHandle,
    ) {
        const BATCH_DRAIN_WINDOW: Duration = Duration::from_millis(200);
        const BATCH_MAX_PARALLEL: usize = 4;

        std::thread::spawn(move || {
            eprintln!(
                "[watcher] Event loop thread started for: {:?}",
                library_root
            );

            let mut recent_events: std::collections::HashMap<PathBuf, u64> =
                std::collections::HashMap::new();

            loop {
                if shutdown.load(Ordering::Relaxed) {
                    eprintln!("[watcher] Shutdown signal received, exiting event loop");
                    break;
                }

                let first_event = match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(e) => e,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        eprintln!("[watcher] Channel disconnected, exiting event loop");
                        break;
                    }
                };

                let mut events: Vec<notify::Event> = vec![first_event];
                let drain_deadline = std::time::Instant::now() + BATCH_DRAIN_WINDOW;
                while std::time::Instant::now() < drain_deadline {
                    if shutdown.load(Ordering::Relaxed) {
                        break;
                    }
                    match rx.try_recv() {
                        Ok(e) => events.push(e),
                        Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(10)),
                        Err(TryRecvError::Disconnected) => break,
                    }
                }

                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or(std::time::Duration::ZERO)
                    .as_secs();

                let mut paths_to_enqueue: Vec<PathBuf> = Vec::new();
                let mut seen_in_batch: HashSet<PathBuf> = HashSet::new();

                for event in &events {
                    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }
                    for path in &event.paths {
                        if !path_is_in_library(path, &library_root) {
                            continue;
                        }

                        if let Some(&last_time) = recent_events.get(path) {
                            if now - last_time < DEBOUNCE_SECONDS {
                                continue;
                            }
                        }

                        recent_events.insert(path.clone(), now);

                        if seen_in_batch.insert(path.clone()) {
                            paths_to_enqueue.push(path.clone());
                        }
                    }
                }

                recent_events.retain(|_, &mut time| now - time < 10);
                if paths_to_enqueue.is_empty() {
                    continue;
                }

                eprintln!(
                    "[watcher] Enqueueing {} stable files ({} raw events)",
                    paths_to_enqueue.len(),
                    events.len()
                );

                let pool = match rayon::ThreadPoolBuilder::new()
                    .num_threads(BATCH_MAX_PARALLEL)
                    .build()
                {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!(
                            "[watcher] Failed to build thread pool: {}, falling back to serial",
                            e
                        );
                        let app_for_batch = app.clone();
                        for p in &paths_to_enqueue {
                            enqueue_enrich_task(p, &db_path, &library_root, app_for_batch.clone());
                        }
                        continue;
                    }
                };

                let db_path_ref = &db_path;
                let library_root_ref = &library_root;
                let app_for_batch = app.clone();
                pool.install(|| {
                    paths_to_enqueue.par_iter().for_each(|p| {
                        enqueue_enrich_task(
                            p,
                            db_path_ref,
                            library_root_ref,
                            app_for_batch.clone(),
                        );
                    });
                });
            }

            eprintln!(
                "[watcher] Event loop thread stopped for: {:?}",
                library_root
            );
        });
    }

    /// 停止监控（消耗 self，触发 Drop）
    pub fn stop(self) {
        eprintln!("[watcher] Stopping file watcher");
        // 设置关闭信号，后台线程会在下一次循环迭代时退出
        self.shutdown.store(true, Ordering::Relaxed);
        // Drop 会在函数返回时自动调用
    }
}

impl Drop for LibraryWatcher {
    fn drop(&mut self) {
        eprintln!(
            "[watcher] Dropping watcher for root: {:?}",
            self._library_root
        );
        // 确保后台线程能收到关闭信号
        self.shutdown.store(true, Ordering::Relaxed);
        // _watcher 会在 drop 时自动停止监控
    }
}

/// 导入单个文件
fn enqueue_enrich_task(path: &Path, db_path: &str, library_root: &Path, app: AppHandle) {
    if !path_is_in_library(path, library_root) {
        return;
    }

    let canonical_key = normalize_watch_path(path).unwrap_or_else(|| fallback_watch_key(path));
    {
        let mut in_flight = IN_FLIGHT_ENRICH.lock().unwrap_or_else(|e| e.into_inner());
        if !in_flight.insert(canonical_key.clone()) {
            return;
        }
    }

    let path_buf = path.to_path_buf();
    let db_path = db_path.to_string();
    let library_root = library_root.to_path_buf();
    std::thread::spawn(move || {
        struct InFlightGuard {
            key: PathBuf,
        }

        impl Drop for InFlightGuard {
            fn drop(&mut self) {
                let mut in_flight = IN_FLIGHT_ENRICH.lock().unwrap_or_else(|e| e.into_inner());
                in_flight.remove(&self.key);
            }
        }

        let _guard = InFlightGuard { key: canonical_key };

        if !is_file_stable(&path_buf) {
            eprintln!("[watcher] File not stable, skipping enrich: {:?}", path_buf);
            return;
        }

        let (media_id, is_new) =
            match ensure_media_record_for_path(&path_buf, &db_path, &library_root) {
                Ok((Some(id), new)) => (id, new),
                Ok((None, _)) => return,
                Err(e) => {
                    eprintln!(
                        "[watcher] Failed to prepare media record for {:?}: {}",
                        path_buf, e
                    );
                    return;
                }
            };
        if is_new {
            let _ = app.emit(
                "library_files_imported",
                serde_json::json!({ "imported": 1_i64 }),
            );
        }
        let filepath = path_buf.to_string_lossy().to_string();
        let library_root_str = library_root.to_string_lossy().to_string();
        if let Err(e) =
            scanner::scan_single_file_enrich(&media_id, &filepath, &db_path, &library_root_str)
        {
            eprintln!("[watcher] Enrich task failed for {:?}: {}", path_buf, e);
        }
        let _ = app.emit(
            "media_metadata_updated",
            serde_json::json!({ "id": media_id }),
        );
    });
}

fn ensure_media_record_for_path(
    path: &Path,
    db_path: &str,
    library_root: &Path,
) -> Result<(Option<String>, bool), String> {
    if !is_supported_watch_file(path) {
        return Ok((None, false));
    }

    let filepath = path.to_string_lossy().to_string();
    if let Some(id) = media_id_for_path(db_path, &filepath)? {
        return Ok((Some(id), false));
    }

    let library_root_str = library_root.to_string_lossy().to_string();
    let inserted_id =
        scanner::scan_single_file_minimal(&filepath, &filepath, db_path, &library_root_str)
            .map_err(|e| format!("minimal scan failed: {}", e))?;

    let id = media_id_for_path(db_path, &filepath)?.unwrap_or(inserted_id);
    Ok((Some(id), true))
}

fn media_id_for_path(db_path: &str, filepath: &str) -> Result<Option<String>, String> {
    let conn = open_conn(db_path).map_err(|e| format!("open db failed: {}", e))?;
    #[cfg(windows)]
    let candidates = {
        let mut candidates = vec![filepath.to_string()];
        let windows_path = filepath.replace('/', "\\");
        if windows_path != filepath {
            candidates.push(windows_path);
        }
        candidates
    };
    #[cfg(not(windows))]
    let candidates = vec![filepath.to_string()];

    for candidate in candidates {
        let id = conn
            .query_row(
                "SELECT id FROM media_files WHERE filepath = ?1 AND COALESCE(is_trashed, 0) = 0 LIMIT 1",
                rusqlite::params![candidate],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("query media id failed: {}", e))?;
        if id.is_some() {
            return Ok(id);
        }
    }

    Ok(None)
}

fn is_supported_watch_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| classify_extension(ext).is_some())
        .unwrap_or(false)
}

fn normalize_watch_path(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    #[cfg(windows)]
    {
        Some(PathBuf::from(
            canonical
                .to_string_lossy()
                .replace('/', "\\")
                .to_lowercase(),
        ))
    }
    #[cfg(not(windows))]
    {
        Some(canonical)
    }
}

fn fallback_watch_key(path: &Path) -> PathBuf {
    let normalized = path
        .components()
        .map(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .replace('/', std::path::MAIN_SEPARATOR_STR)
        })
        .collect::<Vec<_>>()
        .join(std::path::MAIN_SEPARATOR_STR);

    #[cfg(windows)]
    {
        PathBuf::from(normalized.to_lowercase())
    }

    #[cfg(not(windows))]
    {
        PathBuf::from(normalized)
    }
}

fn path_is_in_library(path: &Path, library_root: &Path) -> bool {
    let root = std::fs::canonicalize(library_root).unwrap_or_else(|_| library_root.to_path_buf());
    let candidate = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());

    if !candidate.starts_with(&root) {
        return false;
    }

    !candidate.components().any(|component| {
        matches!(
            component.as_os_str().to_string_lossy().as_ref(),
            ".nocturne" | ".nocturne_meta"
        )
    })
}

fn is_file_stable(path: &Path) -> bool {
    if !path.exists() || !path.is_file() {
        return false;
    }

    let first = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return false,
    };

    std::thread::sleep(Duration::from_millis(300));

    match std::fs::metadata(path) {
        Ok(m) => m.len() == first,
        Err(_) => false,
    }
}

/// 根据扩展名分类
fn classify_extension(ext: &str) -> Option<&'static str> {
    const IMAGE_EXTS: &[&str] = &[
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "avif", "heic", "svg",
    ];
    const VIDEO_EXTS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "flv"];
    const _3D_EXTS: &[&str] = &["obj", "fbx", "glb", "gltf", "blend", "stl"];
    const DOC_EXTS: &[&str] = &["pdf", "psd", "ai", "sketch", "fig", "xd", "zip", "rar"];

    let lower = ext.to_lowercase();
    let lower = lower.as_str();

    if IMAGE_EXTS.contains(&lower) {
        return Some("image");
    }
    if VIDEO_EXTS.contains(&lower) {
        return Some("video");
    }
    if _3D_EXTS.contains(&lower) {
        return Some("3d");
    }
    if DOC_EXTS.contains(&lower) {
        if matches!(lower, "psd" | "ai" | "sketch" | "fig" | "xd") {
            return Some("design");
        }
        return Some("document");
    }
    None
}

/// 初始化库目录结构（在用户选定的库根目录下创建子文件夹与 `.nocturne`）
///
/// 若根目录已存在且含 `.nocturne`，则直接使用（不重复创建）。
/// 此函数只负责创建目录结构，不写入 config.json（由 init_library command 处理）。
pub fn init_library_structure(library_root: &str) -> Result<(), String> {
    let root = Path::new(library_root);

    // 检查是否已存在
    let already_exists = root.exists();

    if already_exists {
        eprintln!("[init] Library directory already exists at: {:?}", root);
        // 验证是否已经是有效的库根（已有 .nocturne 目录）
        if is_valid_library_root(library_root) {
            eprintln!("[init] Using existing library at: {:?}", root);
            // 执行文件夹重命名迁移
            migrate_folder_names(library_root)?;
            return Ok(());
        }
        // 如果已存在但不是有效库，则补充创建缺失的子目录
    }

    // 创建固定子目录（使用新的中文名称）
    let subdirs = ["灵感库", "作品集", "渲染队列", "回收站"];

    for dir in &subdirs {
        let dir_path = root.join(dir);
        std::fs::create_dir_all(&dir_path)
            .map_err(|e| format!("Failed to create directory {}: {}", dir, e))?;
        eprintln!("[init] Created/verified directory: {:?}", dir_path);
    }

    // 创建 .nocturne 数据目录（保留，用于存储库配置）
    let data_dir = root.join(".nocturne");
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create .nocturne directory: {}", e))?;

    eprintln!("[init] Library structure initialized at: {:?}", root);
    Ok(())
}

/// 重命名旧文件夹到新名称
/// - 媒体库 → 灵感库
/// - 项目文件 → 作品集
pub fn migrate_folder_names(library_root: &str) -> Result<(), String> {
    let root = Path::new(library_root);

    // 重命名：媒体库 → 灵感库
    let old_media_lib = root.join("媒体库");
    let new_inspire_lib = root.join("灵感库");
    if old_media_lib.exists() && !new_inspire_lib.exists() {
        std::fs::rename(&old_media_lib, &new_inspire_lib)
            .map_err(|e| format!("Failed to rename 媒体库 to 灵感库：{}", e))?;
        eprintln!("[migrate] Renamed: 媒体库 → 灵感库");
    } else if old_media_lib.exists() && new_inspire_lib.exists() {
        // 两个都存在，合并内容后删除旧的
        eprintln!("[migrate] Both 媒体库 and 灵感库 exist, merging...");
        merge_folders(&old_media_lib, &new_inspire_lib)?;
        std::fs::remove_dir_all(&old_media_lib)
            .map_err(|e| format!("Failed to remove old 媒体库：{}", e))?;
        eprintln!("[migrate] Merged and removed: 媒体库");
    } else {
        eprintln!("[migrate] Skipped rename: 媒体库 does not exist");
    }

    // 重命名：项目文件 → 作品集
    let old_projects = root.join("项目文件");
    let new_portfolio = root.join("作品集");
    if old_projects.exists() && !new_portfolio.exists() {
        std::fs::rename(&old_projects, &new_portfolio)
            .map_err(|e| format!("Failed to rename 项目文件 to 作品集：{}", e))?;
        eprintln!("[migrate] Renamed: 项目文件 → 作品集");
    } else if old_projects.exists() && new_portfolio.exists() {
        // 两个都存在，合并内容后删除旧的
        eprintln!("[migrate] Both 项目文件 and 作品集 exist, merging...");
        merge_folders(&old_projects, &new_portfolio)?;
        std::fs::remove_dir_all(&old_projects)
            .map_err(|e| format!("Failed to remove old 项目文件：{}", e))?;
        eprintln!("[migrate] Merged and removed: 项目文件");
    } else {
        eprintln!("[migrate] Skipped rename: 项目文件 does not exist");
    }

    Ok(())
}

/// 合并文件夹内容（源文件夹 → 目标文件夹）
fn merge_folders(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(to).map_err(|e| format!("Failed to create target folder: {}", e))?;

    for entry in
        std::fs::read_dir(from).map_err(|e| format!("Failed to read source folder: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let from_path = entry.path();
        let to_path = to.join(entry.file_name());

        if from_path.is_file() {
            // 如果目标文件已存在，跳过（不覆盖）
            if !to_path.exists() {
                std::fs::copy(&from_path, &to_path)
                    .map_err(|e| format!("Failed to copy file: {}", e))?;
            }
        } else if from_path.is_dir() {
            merge_folders(&from_path, &to_path)?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct LibraryConfig {
    pub root_path: String,
    pub version: String,
}

/// 读取库目录内可选的本地配置（`{库根}/.nocturne/config.json`）。
/// 注意：应用实际使用的库根路径来自 **App 数据目录** 下的 `.nocturne/config.json`，
/// 与库内该文件不是同一份；库内文件若存在仅作兼容/遗留，不应作为权威来源。
pub fn read_library_config(root_path: &str) -> Result<LibraryConfig, String> {
    let config_path = Path::new(root_path).join(".nocturne/config.json");
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
}

/// 检查路径是否是有效的库根目录
pub fn is_valid_library_root(path: &str) -> bool {
    let data_dir = Path::new(path).join(".nocturne");
    data_dir.exists() && data_dir.is_dir()
}

/// 将配置中的库根规范为绝对路径（不追加 GegaGallery 等子目录）。
pub fn normalize_library_root_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    let p = Path::new(trimmed);
    if p.exists() {
        let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if !canonical.is_dir() {
            return Err(format!("所选路径不是文件夹：{}", trimmed));
        }
        Ok(canonical.to_string_lossy().into_owned())
    } else {
        Ok(trimmed.to_string())
    }
}

/// 从 AppData 下的 config.json 读取已验证、规范化后的库根路径。
pub fn configured_library_root_from_app_data(app_data_dir: &Path) -> Option<String> {
    let config_path = app_data_dir.join(".nocturne/config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let config: LibraryConfig = serde_json::from_str(&content).ok()?;
    if !is_valid_library_root(&config.root_path) {
        return None;
    }
    normalize_library_root_path(&config.root_path).ok()
}

/// 更新数据库中的文件夹路径（媒体库→灵感库，项目文件→作品集）
pub fn update_folder_paths_in_db(db_path: &str, library_root: &str) -> Result<(), String> {
    let mut conn =
        crate::db::open_conn(db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    crate::db::crud::update_folder_paths_in_db(&mut conn)
        .map_err(|e| format!("Failed to update paths in DB: {}", e))?;

    crate::db::crud::repair_unix_path_separators_in_media_paths(&conn)
        .map_err(|e| format!("Failed to repair path separators in DB: {}", e))?;

    crate::db::crud::update_library_root_prefixes(&mut conn, library_root)
        .map_err(|e| format!("Failed to update library root prefixes in DB: {:?}", e))?;

    eprintln!(
        "[watcher] Database paths updated for library: {}",
        library_root
    );
    Ok(())
}
