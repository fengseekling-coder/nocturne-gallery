use anyhow::Result;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::Emitter;

pub struct ThumbnailTask {
    pub media_id: String,
    pub filepath: String,
    pub thumbs_dir: String,
    pub db_path: String,
}

impl ThumbnailTask {
    pub fn new(media_id: &str, filepath: &str, thumbs_dir: &str, db_path: &str) -> Option<Self> {
        if !std::path::Path::new(filepath).exists() {
            return None;
        }
        Some(Self {
            media_id: media_id.to_string(),
            filepath: filepath.to_string(),
            thumbs_dir: thumbs_dir.to_string(),
            db_path: db_path.to_string(),
        })
    }
}

/// 缩略图队列管理器
///
/// 用 Condvar + Mutex 替代 sleep 轮询：
/// - 无任务时 worker 阻塞在 condvar.wait()，CPU 占用 0%
/// - enqueue / wake_processor 调用 condvar.notify_one() 立即唤醒 worker
pub struct ThumbnailQueue {
    queue: Arc<Mutex<VecDeque<ThumbnailTask>>>,
    condvar: Arc<Condvar>,
    shutdown: Arc<AtomicBool>,
}

impl ThumbnailQueue {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            condvar: Arc::new(Condvar::new()),
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 添加任务到队列并立即唤醒 worker
    pub fn enqueue(&self, task: ThumbnailTask) {
        {
            let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            q.push_back(task);
            eprintln!("[thumbnail_queue] Task added, queue size: {}", q.len());
        }
        self.condvar.notify_one();
    }

    /// 批量添加任务并唤醒 worker
    pub fn enqueue_batch(&self, tasks: Vec<ThumbnailTask>) {
        {
            let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            let count = tasks.len();
            for task in tasks {
                q.push_back(task);
            }
            eprintln!(
                "[thumbnail_queue] Batch added {} tasks, queue size: {}",
                count,
                q.len()
            );
        }
        self.condvar.notify_one();
    }

    /// 启动后台处理线程
    pub fn start_processor<R: tauri::Runtime>(&self, app_handle: tauri::AppHandle<R>) {
        let queue = Arc::clone(&self.queue);
        let condvar = Arc::clone(&self.condvar);
        let shutdown = Arc::clone(&self.shutdown);

        std::thread::spawn(move || {
            eprintln!("[thumbnail_queue] Processor thread started");

            loop {
                // 获取下一个任务，无任务时用 condvar 阻塞（不消耗 CPU）
                let task = {
                    let mut guard = queue.lock().unwrap_or_else(|e| e.into_inner());
                    // 等待直到队列非空或收到关闭信号
                    while guard.is_empty() {
                        if shutdown.load(Ordering::Relaxed) {
                            eprintln!("[thumbnail_queue] Shutdown received, exiting processor");
                            return;
                        }
                        guard = condvar.wait(guard).unwrap_or_else(|e| e.into_inner());
                    }
                    // 再次检查关闭信号（wait 返回后）
                    if shutdown.load(Ordering::Relaxed) {
                        eprintln!("[thumbnail_queue] Shutdown received, exiting processor");
                        return;
                    }
                    guard.pop_front()
                };

                if let Some(task) = task {
                    eprintln!(
                        "[thumbnail_queue] Processing task for media_id: {}",
                        task.media_id
                    );
                    match generate_thumbnail_task(&task) {
                        Ok(thumb_path) => {
                            eprintln!("[thumbnail_queue] Thumbnail generated: {}", thumb_path);
                            let _ = app_handle.emit(
                                "thumbnail-generated",
                                serde_json::json!({
                                    "mediaId": task.media_id,
                                    "thumbnailPath": thumb_path,
                                }),
                            );
                        }
                        Err(e) => {
                            eprintln!("[thumbnail_queue] Failed to generate thumbnail: {}", e);
                            let _ = app_handle.emit(
                                "thumbnail-failed",
                                serde_json::json!({
                                    "mediaId": task.media_id,
                                    "error": e.to_string(),
                                }),
                            );
                        }
                    }
                }
            }
        });
    }

    /// 唤醒处理器（用于批量入队后一次性唤醒）
    pub fn wake_processor(&self) {
        eprintln!("[thumbnail_queue] Waking processor");
        self.condvar.notify_one();
    }

    /// 暂停处理器（保留接口兼容性，Condvar 模式下无实际效果）
    pub fn pause_processor(&self) {
        eprintln!("[thumbnail_queue] pause_processor called (no-op in condvar mode)");
    }

    /// 获取队列长度
    pub fn queue_len(&self) -> usize {
        let q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        q.len()
    }

    /// 检查是否正在处理（Condvar 模式下始终返回 true，兼容接口）
    pub fn is_processing(&self) -> bool {
        true
    }
}

impl Drop for ThumbnailQueue {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        // 唤醒 worker 让它看到 shutdown 信号并退出
        self.condvar.notify_all();
        eprintln!("[thumbnail_queue] ThumbnailQueue dropped, shutdown signal sent");
    }
}

impl Default for ThumbnailQueue {
    fn default() -> Self {
        Self::new()
    }
}

fn generate_thumbnail_task(task: &ThumbnailTask) -> Result<String> {
    generate_thumbnail(
        &task.media_id,
        &task.filepath,
        &task.thumbs_dir,
        &task.db_path,
    )
}

/// 生成缩略图，保存到素材所在目录的 `.nocturne_meta/{filename}_thumb.jpg`，并更新数据库。
pub fn generate_thumbnail(
    media_id: &str,
    filepath: &str,
    _thumbs_dir: &str,
    db_path: &str,
) -> Result<String> {
    crate::media::thumbnail::generate_thumbnail_and_meta(media_id, filepath, db_path)
}

/// 创建缩略图任务（用于导入时不立即生成）
pub fn create_thumbnail_task(
    media_id: &str,
    filepath: &str,
    thumbs_dir: &str,
    db_path: &str,
) -> Option<ThumbnailTask> {
    let ext = Path::new(filepath)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    let is_supported = matches!(
        ext.as_deref(),
        Some("jpg")
            | Some("jpeg")
            | Some("png")
            | Some("gif")
            | Some("webp")
            | Some("bmp")
            | Some("tiff")
            | Some("avif")
            | Some("heic")
            | Some("svg")
            | Some("mp4")
            | Some("mov")
            | Some("avi")
            | Some("mkv")
            | Some("webm")
    );

    if !is_supported {
        return None;
    }

    Some(ThumbnailTask {
        media_id: media_id.to_string(),
        filepath: filepath.to_string(),
        thumbs_dir: thumbs_dir.to_string(),
        db_path: db_path.to_string(),
    })
}
