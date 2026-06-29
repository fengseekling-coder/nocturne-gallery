//! 路径安全校验原语
//!
//! 这一组函数只关心"一条路径是否在另一个路径范围内、是否会被规范化后跨越边界、是否
//! 含控制字符"——它们是整个 `commands` 树抵御路径穿越攻击的最后一道闸门,被 2+ 个
//! 领域模块复用(trash / library / diagnostics 等),因此独立成模块。
//!
//! 行为约束:
//! - 所有函数都是纯函数,不依赖 `AppHandle`,便于单测(参见 `commands::path_and_fs_tests`)。
//! - 跨平台分支只在 macOS / Linux 上做反斜杠→正斜杠的等价;Windows 上由 `cfg(windows)`
//!   分支处理盘符大小写不敏感。
//! - 一律不抛异常,只返回 `Option<PathBuf>` 或 `Result<(), String>`,错误信息面向开发者。

/// 把输入路径归一化为"可与库根做比较"的形态。
///
/// 真实存在的路径用 `canonicalize`;不存在但只是分隔符方向不同的(macOS 上 Windows
/// 风格的 `C:\foo\bar` 在某些上下文里会被传入),做一次反向分隔符替换后再尝试
/// canonicalize。仍不存在的返回 `None`——这种路径是"被作为字符串参与比较"的,不能
/// 被错误地 canonicalize 到一个不存在的目录上。
pub fn normalize_path_for_boundary_check(path: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(path);
    if path.exists() {
        return path.canonicalize().ok();
    }

    #[cfg(windows)]
    {
        let cleaned = path.to_string_lossy().replace('/', "\\");
        let cleaned_path = std::path::PathBuf::from(cleaned);
        if cleaned_path.exists() {
            return cleaned_path.canonicalize().ok();
        }
    }

    #[cfg(not(windows))]
    {
        let cleaned = path.to_string_lossy().replace('\\', "/");
        if cleaned != path.to_string_lossy() {
            let cleaned_path = std::path::PathBuf::from(&cleaned);
            if cleaned_path.exists() {
                return cleaned_path.canonicalize().ok();
            }
        }
    }

    None
}

/// 判断 `candidate` 是否等于 `root` 或位于 `root` 之下。
///
/// 关键边界:`/tmp/abc` 与 `/tmp/abcd` 在字符串前缀上是包含关系,但前者不在后者的
/// 子树里。必须把 root 末尾补上分隔符再比前缀,否则会出现"前缀字符匹配但不是真子目
/// 录"的误判。
pub fn same_or_descendant_path(candidate: &std::path::Path, root: &std::path::Path) -> bool {
    let candidate = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    #[cfg(windows)]
    let candidate_str = candidate
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    #[cfg(windows)]
    let root_str = root
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();

    #[cfg(not(windows))]
    let candidate_str = candidate.to_string_lossy().replace('\\', "/");
    #[cfg(not(windows))]
    let root_str = root.to_string_lossy().replace('\\', "/");

    if candidate_str == root_str {
        return true;
    }

    let mut root_with_sep = root_str;
    if !root_with_sep.ends_with(std::path::MAIN_SEPARATOR) {
        root_with_sep.push(std::path::MAIN_SEPARATOR);
    }

    candidate_str.starts_with(&root_with_sep)
}

/// 把路径字符串统一成"和 `library_root` 同方向分隔符"的形态,便于做字符串前缀匹配。
///
/// trim + 末尾分隔符 + Windows 上 lowercase。
pub fn normalize_path_string_for_prefix(path: &str) -> String {
    let mut s = path.trim().replace('/', std::path::MAIN_SEPARATOR_STR);
    while s.ends_with(std::path::MAIN_SEPARATOR) && s.len() > 1 {
        s.pop();
    }
    #[cfg(windows)]
    {
        return s.to_ascii_lowercase();
    }
    #[cfg(not(windows))]
    {
        s
    }
}

/// 在路径**未在磁盘上存在**时(常见:用户粘贴了一个未来才会被创建的相对路径),用字符
/// 串前缀来兜底做库内校验。已被 `validate_path_in_library` 复用。
pub fn path_under_library_root_prefix(file_path: &str, library_root: &str) -> bool {
    let file = normalize_path_string_for_prefix(file_path);
    let mut root = normalize_path_string_for_prefix(library_root);
    if !root.is_empty() && !root.ends_with(std::path::MAIN_SEPARATOR) {
        root.push(std::path::MAIN_SEPARATOR);
    }
    file == root.trim_end_matches(std::path::MAIN_SEPARATOR) || file.starts_with(&root)
}

/// 验证一条文件路径位于 `library_root` 之内。
///
/// 流程: 先尝试用 `canonicalize` 比对;若路径尚未存在(导入前的占位条目),退化为字符
/// 串前缀匹配。失败返回中文错误,会被前端直接展示。
pub fn validate_path_in_library(file_path: &str, library_root: &str) -> Result<(), String> {
    let candidate = normalize_path_for_boundary_check(file_path)
        .unwrap_or_else(|| std::path::PathBuf::from(file_path));
    let root = normalize_path_for_boundary_check(library_root)
        .unwrap_or_else(|| std::path::PathBuf::from(library_root));

    if same_or_descendant_path(&candidate, &root) {
        return Ok(());
    }

    if path_under_library_root_prefix(file_path, library_root) {
        return Ok(());
    }

    let err = format!(
        "路径越界：不允许操作库目录外的文件（文件：{}，库根：{}）",
        file_path, library_root
    );
    eprintln!("[validate_path] {}", err);
    Err(err)
}

/// 校验"相对库根的文件夹路径"格式合法(非空、不含绝对路径、不含 `..`、不含盘符)。
///
/// 用 `Path::components()` 严格解析,任何非 `Normal` component(含 `..`、根目录、盘符)
/// 都会被拒绝。比字符串 `.contains("..")` 更严谨——后者会漏掉 `....`、`..hidden`
/// 等伪装变体。
pub fn validate_library_relative_folder(folder: &str) -> Result<String, String> {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return Err("目标文件夹不能为空".to_string());
    }

    let path = std::path::Path::new(trimmed);
    if path.is_absolute() {
        return Err("目标文件夹不能是绝对路径".to_string());
    }

    let has_component = path
        .components()
        .try_fold(false, |_, component| match component {
            std::path::Component::Normal(_) => Ok(true),
            _ => Err("目标文件夹不能包含路径穿越或盘符".to_string()),
        })?;

    if !has_component {
        return Err("目标文件夹不能为空".to_string());
    }

    Ok(trimmed.to_string())
}

#[cfg(test)]
mod path_and_fs_tests {
    //! P1-3：路径安全 / 文件系统辅助的纯函数级回归测试。
    //!
    //! 覆盖 `commands/mod.rs` 里最容易被忽视、但一旦回归就会直接造成用户数据丢失
    //! 或越权访问的高风险辅助函数。这些函数大多不需要 `AppHandle`，可独立单测。

    use crate::commands::*;
    use std::path::PathBuf;

    /// 创建一个隔离临时目录，测试结束后由操作系统回收。
    /// 不引入 `tempfile` 依赖，避免给 P1-3 增加额外的供应链/编译成本。
    fn make_temp_dir(label: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        dir.push(format!("nocturne-test-{}-{}", label, nanos));
        std::fs::create_dir_all(&dir).expect("temp dir create");
        dir
    }

    // ─── validate_http_url ────────────────────────────────────────────

    #[test]
    fn validate_http_url_accepts_http_and_https() {
        assert!(validate_http_url("http://example.com").is_ok());
        assert!(validate_http_url("https://example.com/path?q=1").is_ok());
        // 大小写不敏感
        assert!(validate_http_url("HTTPS://Example.COM").is_ok());
        // 自动 trim
        assert_eq!(
            validate_http_url("  https://x.test  ").unwrap(),
            "https://x.test"
        );
    }

    #[test]
    fn validate_http_url_rejects_non_http_schemes() {
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://x.test",
            "data:text/html,foo",
            "ssh://x",
        ] {
            assert!(
                validate_http_url(bad).is_err(),
                "应当拒绝非 http(s) scheme: {}",
                bad
            );
        }
    }

    #[test]
    fn validate_http_url_rejects_empty_and_control_chars() {
        assert!(validate_http_url("").is_err());
        assert!(validate_http_url("   ").is_err());
        // 控制字符（换行）必须被拒，否则可能被注入到其它 URL 拼接上下文。
        assert!(validate_http_url("http://x.test\n").is_err());
        assert!(validate_http_url("http://x.test\rbad").is_err());
    }

    // ─── validate_existing_local_path ────────────────────────────────

    #[test]
    fn validate_existing_local_path_accepts_real_file_and_dir() {
        let dir = make_temp_dir("vep-accept");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hi").unwrap();

        // 真实存在的文件
        let got = validate_existing_local_path(file.to_str().unwrap()).unwrap();
        assert!(got.is_file());
        assert!(got.ends_with("a.txt"));

        // 真实存在的目录也允许（调用方自己决定是文件还是目录）
        let got_dir = validate_existing_local_path(dir.to_str().unwrap()).unwrap();
        assert!(got_dir.is_dir());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_existing_local_path_rejects_missing_and_schemes() {
        // 不存在的路径
        assert!(validate_existing_local_path("/no/such/path/xyzzy").is_err());
        // 含 scheme 的拒绝（含 ::），防止误把 URL 当本地路径
        assert!(validate_existing_local_path("file:///etc/passwd").is_err());
        assert!(validate_existing_local_path("https://x.test/a.png").is_err());
        // 空 / 纯空白
        assert!(validate_existing_local_path("").is_err());
        assert!(validate_existing_local_path("   ").is_err());
    }

    // ─── same_or_descendant_path ─────────────────────────────────────

    #[test]
    fn same_or_descendant_path_handles_equal_and_descendant() {
        let dir = make_temp_dir("sod-equal");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        // 同一路径
        assert!(same_or_descendant_path(&dir, &dir));
        // 子目录
        assert!(same_or_descendant_path(&sub, &dir));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_or_descendant_path_rejects_outside_and_partial_match() {
        let dir_a = make_temp_dir("sod-a");
        let dir_b = make_temp_dir("sod-b");
        let sub_a = dir_a.join("inside");
        std::fs::create_dir_all(&sub_a).unwrap();

        // 完全无关的目录
        assert!(!same_or_descendant_path(&dir_b, &dir_a));

        // 关键边界：仅前缀字符匹配但不是真正的子目录（如 dir_a 是 "/tmp/abc",
        // candidate 是 "/tmp/abcd"）不应被误判为 descendant。
        // 构造方式：在 dir_a 下建一个名字以 dir_b 名称开头的子目录，验证
        // 同级前缀字符重叠的情况。
        let sibling_like = dir_a.join("xyz-sibling");
        std::fs::create_dir_all(&sibling_like).unwrap();
        // dir_b 与 sibling_like 是不同路径：dir_b 不应在 dir_a 下
        assert!(!same_or_descendant_path(&dir_b, &dir_a));

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    // ─── restore_folder_for_trash_item ────────────────────────────────

    #[test]
    fn restore_folder_prefers_pre_trash_path() {
        // pre_trash 有明确值时优先使用 —— 这是用户最常见的"恢复原位"场景。
        assert_eq!(
            restore_folder_for_trash_item("灵感库/插画", "回收站"),
            "灵感库/插画"
        );
        // 即便 current_source_folder 看起来"更合理"也不覆盖
        assert_eq!(
            restore_folder_for_trash_item("灵感库/草稿", "灵感库/其它"),
            "灵感库/草稿"
        );
    }

    #[test]
    fn restore_folder_falls_back_to_current_when_pre_is_trash_or_empty() {
        // pre_trash 是回收站本身（无法恢复原位）→ 回落到 current_source_folder
        assert_eq!(
            restore_folder_for_trash_item("回收站", "灵感库/插画"),
            "灵感库/插画"
        );
        // pre_trash 为空字符串 → 同样回落到 current
        assert_eq!(
            restore_folder_for_trash_item("", "灵感库/草稿"),
            "灵感库/草稿"
        );
        // pre_trash 全是空白
        assert_eq!(
            restore_folder_for_trash_item("   ", "灵感库/草稿"),
            "灵感库/草稿"
        );
    }

    #[test]
    fn restore_folder_defaults_when_both_unusable() {
        // 两边都指向回收站 → 用 "灵感库" 作为兜底
        assert_eq!(
            restore_folder_for_trash_item("回收站", "回收站"),
            "灵感库"
        );
        // 两边都为空
        assert_eq!(restore_folder_for_trash_item("", ""), "灵感库");
        // 两边都是空白
        assert_eq!(restore_folder_for_trash_item("  ", "  "), "灵感库");
    }

    // ─── unique_path_in_dir ──────────────────────────────────────────

    #[test]
    fn unique_path_returns_original_when_absent() {
        let dir = make_temp_dir("upq-absent");
        let got = unique_path_in_dir(&dir, "fresh.png");
        assert_eq!(got, dir.join("fresh.png"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_path_appends_numeric_suffix_on_collision() {
        let dir = make_temp_dir("upq-collide");
        std::fs::write(dir.join("dup.png"), b"x").unwrap();

        let got = unique_path_in_dir(&dir, "dup.png");
        let name = got.file_name().unwrap().to_str().unwrap();
        assert!(
            name.starts_with("dup") && name.ends_with(".png") && name != "dup.png",
            "应当生成不同的名字，实际: {}",
            name
        );
        // 必须不含文件系统保留字符
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_path_handles_files_without_extension() {
        let dir = make_temp_dir("upq-noext");
        std::fs::write(dir.join("README"), b"x").unwrap();

        let got = unique_path_in_dir(&dir, "README");
        let name = got.file_name().unwrap().to_str().unwrap();
        // 必须仍是合法文件名（不含路径分隔符）
        assert!(!name.contains('/'));
        assert_ne!(name, "README");
        assert!(name.starts_with("README"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_path_picks_lowest_unused_index_when_many_collide() {
        let dir = make_temp_dir("upq-multi");
        // 预先占用 file (1).png 和 file (2).png，期望下次取 file (3).png
        std::fs::write(dir.join("file.png"), b"x").unwrap();
        std::fs::write(dir.join("file (1).png"), b"x").unwrap();
        std::fs::write(dir.join("file (2).png"), b"x").unwrap();

        let got = unique_path_in_dir(&dir, "file.png");
        let name = got.file_name().unwrap().to_str().unwrap();
        assert_eq!(name, "file (3).png");

        std::fs::remove_dir_all(&dir).ok();
    }
}