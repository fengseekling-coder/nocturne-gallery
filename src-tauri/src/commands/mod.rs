// ────────────────────────────────────────────────────────────────────
//  P1-1 模块组织：领域模块声明 + 测试需要辅助函数的 re-export
// ────────────────────────────────────────────────────────────────────

pub mod ai_tools;
pub(crate) mod destructive;
pub(crate) mod path_safety;
pub(crate) mod state;
pub(crate) mod ai_chat;
pub(crate) mod attachments;
pub(crate) mod backfill;
pub(crate) mod bookmarks;
pub(crate) mod diagnostics;
pub(crate) mod drag;
pub(crate) mod filesystem;
pub(crate) mod import_export;
pub(crate) mod library;
pub(crate) mod media;
pub(crate) mod platform;
pub(crate) mod preferences;
pub(crate) mod thumbnails;
pub(crate) mod trash;

// pub use 子模块的 pub 项到 `commands::` 命名空间,
// 让 `tauri::generate_handler![init_library, ...]` 在 lib.rs 中能找到命令符号。
pub use ai_tools::*;
pub use destructive::*;
pub use path_safety::*;
pub use state::*;
pub use ai_chat::*;
pub use attachments::*;
pub use backfill::*;
pub use bookmarks::*;
pub use diagnostics::*;
pub use drag::*;
pub use filesystem::*;
pub use import_export::*;
pub use library::*;
pub use media::*;
pub use platform::*;
pub use preferences::*;
pub use thumbnails::*;
pub use trash::*;

// ────────────────────────────────────────────────────────────────────
//  mod.rs 顶层保留类型 (仅 BatchFileOperationResult,因为被多模块使用)
// ────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct BatchFileOperationResult {
    pub succeeded: usize,
    pub failed: usize,
    /// 首个失败原因（便于前端 Toast，而非仅「失败」）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_error: Option<String>,
}

// ────────────────────────────────────────────────────────────────────
//  P1-3 回归测试：核心安全辅助函数 + 破坏性命令 token 语义
// ────────────────────────────────────────────────────────────────────
