//! 破坏性操作的服务端二次确认 (confirmation token)
//!
//! 设计动机: 前端只能在 UI 层提示"确认删除",但任何有 devtools 经验的用户都能
//! 直接调 Tauri invoke。所以真正不可绕过的是后端:每一个真正的破坏性命令
//! (`empty_trash` / `delete_file_permanently` / `clear_all_media` / `batch_delete_...` /
//! `emergency_cleanup_invalid_files` 等)都必须拿到一个与 `operation` 绑定的、30 秒内
//! 有效的一次性 token 才能执行。
//!
//! 这就是为什么这个文件独立成模块——所有破坏性命令都会引用它,如果它藏在 `mod.rs`
//! 里,审计"哪些命令被 token 保护"时一眼扫不到。

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{command, AppHandle, Manager};
use uuid::Uuid;

/// 破坏性命令服务端二次确认:保存一次性 confirmation token。
/// key = token,value = (operation_name, issued_at)。
pub struct DestructiveTokenStore(pub Mutex<HashMap<String, (String, std::time::Instant)>>);

/// confirmation token 有效期,超时即视为失效。
pub const DESTRUCTIVE_TOKEN_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// 给定当前时间戳与 token store,向其中签发一个绑定 `operation` 的新 token。
///
/// 同时清理已过期的旧 token,避免 map 无限增长。抽出为纯函数以便测试。
pub fn issue_destructive_token(
    map: &mut HashMap<String, (String, std::time::Instant)>,
    operation: &str,
    now: std::time::Instant,
) -> String {
    map.retain(|_, (_, issued)| now.duration_since(*issued) < DESTRUCTIVE_TOKEN_TTL);
    let token = Uuid::new_v4().to_string();
    map.insert(token.clone(), (operation.to_string(), now));
    token
}

/// 在给定时间戳下尝试消费一个 token。
///
/// - token 不存在 → Not found
/// - token 已过期(自签发超过 TTL) → Expired
/// - token 存在但绑定的 operation 与 expected 不匹配 → Operation mismatch
/// - 消费成功 → Ok(()) 并从 map 中移除(一次性)
///
///   抽出为纯函数以便测试。
pub fn try_consume_destructive_token(
    map: &mut HashMap<String, (String, std::time::Instant)>,
    token: &str,
    expected_operation: &str,
    now: std::time::Instant,
) -> Result<(), DestructiveTokenError> {
    match map.remove(token) {
        None => Err(DestructiveTokenError::NotFound),
        Some((bound_op, issued)) => {
            if now.duration_since(issued) >= DESTRUCTIVE_TOKEN_TTL {
                Err(DestructiveTokenError::Expired)
            } else if bound_op != expected_operation {
                Err(DestructiveTokenError::OperationMismatch {
                    expected: expected_operation.to_string(),
                    actual: bound_op,
                })
            } else {
                Ok(())
            }
        }
    }
}

/// token 消费失败的原因细分。仅供后端日志与单元测试断言使用;
/// 前端只看到统一字符串。
#[derive(Debug, PartialEq, Eq)]
pub enum DestructiveTokenError {
    NotFound,
    Expired,
    OperationMismatch { expected: String, actual: String },
}

impl DestructiveTokenError {
    pub fn to_user_message(&self) -> String {
        match self {
            Self::NotFound => "Confirmation token not found".to_string(),
            Self::Expired => "Confirmation token expired".to_string(),
            Self::OperationMismatch { .. } => "Confirmation token operation mismatch".to_string(),
        }
    }
}

/// 为某个破坏性操作签发一次性 confirmation token。
/// 前端必须先调用本命令拿到 token,再把它作为 `confirmationToken` 传给对应的破坏性命令。
#[command]
pub async fn request_destructive_token(
    handle: AppHandle,
    operation: String,
) -> Result<String, String> {
    let store = handle.state::<DestructiveTokenStore>();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    Ok(issue_destructive_token(&mut map, &operation, std::time::Instant::now()))
}

/// 校验并消费一个 confirmation token:成功后立即移除(一次性),
/// operation 不匹配或已超时均视为无效。
pub fn consume_destructive_token(
    handle: &AppHandle,
    token: &str,
    expected_operation: &str,
) -> Result<(), String> {
    let store = handle.state::<DestructiveTokenStore>();
    let mut map = store.0.lock().map_err(|e| e.to_string())?;
    try_consume_destructive_token(&mut map, token, expected_operation, std::time::Instant::now())
        .map_err(|e| e.to_user_message())
}

#[cfg(test)]
mod destructive_token_tests {
    //! P0-2 收尾：破坏性命令服务端双确认（confirmation token）的纯函数级测试。
    //!
    //! 这些测试只覆盖 `issue_destructive_token` / `try_consume_destructive_token` 的语义。
    //! AppHandle / Mutex / Tauri state 这些"集成层"不在此处测试——它们在 e2e/ 覆盖。

    use super::{
        DESTRUCTIVE_TOKEN_TTL, DestructiveTokenError, issue_destructive_token,
        try_consume_destructive_token,
    };
    use crate::commands::DestructiveTokenStore;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    fn empty_store() -> HashMap<String, (String, Instant)> {
        HashMap::new()
    }

    #[test]
    fn issue_returns_unique_tokens() {
        let mut map = empty_store();
        let now = Instant::now();
        let t1 = issue_destructive_token(&mut map, "empty_trash", now);
        let t2 = issue_destructive_token(&mut map, "empty_trash", now);
        assert_ne!(t1, t2, "uuid v4 应当保证每次颁发都不同");
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn consume_succeeds_within_ttl_and_matching_operation() {
        let mut map = empty_store();
        let now = Instant::now();
        let token = issue_destructive_token(&mut map, "empty_trash", now);

        assert_eq!(
            try_consume_destructive_token(&mut map, &token, "empty_trash", now),
            Ok(())
        );
        // 一次性：消费后立即失效，map 中应当已移除。
        assert!(!map.contains_key(&token));
    }

    #[test]
    fn consume_is_one_shot() {
        let mut map = empty_store();
        let now = Instant::now();
        let token = issue_destructive_token(&mut map, "delete_file_permanently", now);

        assert!(try_consume_destructive_token(
            &mut map,
            &token,
            "delete_file_permanently",
            now
        )
        .is_ok());
        // 第二次消费同一 token 必须失败（map 中已被移除）。
        assert_eq!(
            try_consume_destructive_token(&mut map, &token, "delete_file_permanently", now),
            Err(DestructiveTokenError::NotFound)
        );
    }

    #[test]
    fn consume_rejects_unknown_token() {
        let mut map = empty_store();
        let now = Instant::now();
        // 不颁发，直接消费。
        assert_eq!(
            try_consume_destructive_token(&mut map, "ghost-token", "empty_trash", now),
            Err(DestructiveTokenError::NotFound)
        );
    }

    #[test]
    fn consume_rejects_empty_token() {
        let mut map = empty_store();
        let now = Instant::now();
        // 即便颁发过一个真 token，空字符串也必须单独视为 NotFound。
        let _ = issue_destructive_token(&mut map, "empty_trash", now);
        assert_eq!(
            try_consume_destructive_token(&mut map, "", "empty_trash", now),
            Err(DestructiveTokenError::NotFound)
        );
    }

    #[test]
    fn consume_rejects_after_ttl() {
        let mut map = empty_store();
        let issued = Instant::now();
        let token = issue_destructive_token(&mut map, "clear_all_media", issued);

        // 刚颁发立刻消费应当成功。
        assert!(try_consume_destructive_token(&mut map, &token, "clear_all_media", issued).is_ok());

        // 再颁发一个，模拟过期。
        let token2 = issue_destructive_token(&mut map, "clear_all_media", issued);
        let after_ttl = issued + DESTRUCTIVE_TOKEN_TTL + Duration::from_millis(1);
        assert_eq!(
            try_consume_destructive_token(&mut map, &token2, "clear_all_media", after_ttl),
            Err(DestructiveTokenError::Expired)
        );
        // 消费即一次性：即使是过期被拒，token 也已从 map 中移除。
        assert!(!map.contains_key(&token2));
    }

    #[test]
    fn consume_rejects_operation_mismatch() {
        let mut map = empty_store();
        let now = Instant::now();
        let token = issue_destructive_token(&mut map, "empty_trash", now);

        // 用错误的 operation 去消费：必须明确报错而不是"碰巧通过"。
        assert_eq!(
            try_consume_destructive_token(
                &mut map,
                &token,
                "delete_file_permanently",
                now
            ),
            Err(DestructiveTokenError::OperationMismatch {
                expected: "delete_file_permanently".to_string(),
                actual: "empty_trash".to_string(),
            })
        );
        // 消费即一次性：即使 operation 不匹配被拒，token 也已移除，前端需重新 request。
        assert!(!map.contains_key(&token));
    }

    #[test]
    fn issue_cleans_up_expired_tokens() {
        let mut map = empty_store();
        let t0 = Instant::now();
        // 颁发一个老 token。
        let _ = issue_destructive_token(&mut map, "empty_trash", t0);

        // 颁发新 token 时传入远晚于 t0 的 now，老 token 应被 retain 清理。
        let far_future = t0 + DESTRUCTIVE_TOKEN_TTL + Duration::from_secs(5);
        let new_token = issue_destructive_token(&mut map, "empty_trash", far_future);
        assert_eq!(map.len(), 1, "过期的老 token 应当在 issue 时被清掉");
        assert!(map.contains_key(&new_token));
    }

    #[test]
    fn error_messages_are_distinguishable() {
        // 前端 toast 依赖这些字符串做用户提示；这里确保三个错误互不混淆。
        let not_found = DestructiveTokenError::NotFound.to_user_message();
        let expired = DestructiveTokenError::Expired.to_user_message();
        let mismatch = DestructiveTokenError::OperationMismatch {
            expected: "a".to_string(),
            actual: "b".to_string(),
        }
        .to_user_message();
        assert_ne!(not_found, expired);
        assert_ne!(expired, mismatch);
        assert_ne!(not_found, mismatch);
    }

    #[test]
    fn store_wrapper_struct_is_constructible() {
        // DestructiveTokenStore 暴露在 AppHandle 的 state 中；
        // 这里只确保它能裸构造（防止后续重构把它改成不可构造的形态）。
        let _ = DestructiveTokenStore(std::sync::Mutex::new(HashMap::new()));
    }
}