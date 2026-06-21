# Tauri 命令对照与风险矩阵

前端通过 `invoke('command_name', …)` 调用 Rust 侧在 `src-tauri/src/lib.rs` 的 `generate_handler![…]` 中注册的命令。

## 自动校验

在 `nocturne-gallery/` 目录执行：

```bash
npm run audit:commands
```

- 扫描 `src/**/*.{ts,tsx}` 中所有 `invoke('…')` 名称
- 与 `lib.rs` 中注册的 handler 对比
- **退出码 0**：每个前端 invoke 均有对应 Rust 命令
- **退出码 1**：列出后端缺失的命令名

当前基线（随代码演进会变）：约 **62** 个前端 invoke、**87** 个已注册命令（多出的多为 Rust 内部或尚未从前端调用的 API）。

## 开发注意

- 新增 `invoke` 时必须在 `lib.rs` 的 `generate_handler!` 中注册同名函数（或 `commands::…::fn` 映射）。
- AI 相关命令在 `src-tauri/src/commands/ai_tools.rs`，以 `commands::ai_tools::…` 形式注册。
- 新增任何接收路径或执行文件读写/删除的命令，必须在表中登记风险级别，并复用统一的库根路径校验（见“路径安全约定”）。

---

## 命令风险矩阵

风险标签说明：

- **read**：只读查询（数据库或文件，不改磁盘状态）
- **write**：写数据库或在库内写/改文件（非破坏性）
- **destructive**：移动到回收站、永久删除、清空、批量删改等不可逆或高影响操作
- **shell-open**：调用 `open::that` 或 `std::process::Command` 打开外部程序/资源管理器/子进程
- **network**：发起出网请求（当前仅 `reqwest` 调用第三方 AI endpoint）
- **AI**：AI Agent 工具命令（`commands::ai_tools::…`）
- **path-input**：命令签名直接接收前端传入的路径/URL 字符串

“库根校验”列：`✓` 表示已在实现中调用 `resolve_under_library_root` / `validate_path_in_library` / `validate_existing_local_path` / `validate_http_url` 等校验；`—` 表示无路径入参。当前所有接收外部路径的命令均已接入校验；后续新增此类命令时，须同步登记其校验方式并更新本列状态。

### 媒体扫描与查询

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `scan_directory` | read, write, path-input | 是（path） | ✓（A：resolve_under_library_root，扫描路径须在库根内） |
| `scan_library` | write | 否 | — |
| `sync_library_from_disk` | write | 否 | — |
| `rescan_library` | write | 否 | — |
| `get_media_files` | read | 否 | — |
| `get_media_detail` | read | 否 | — |
| `get_group_item_counts` | read | 否 | — |
| `get_nav_item_counts` | read | 否 | — |
| `get_all_file_paths` | read | 否 | — |
| `check_duplicate` | read, path-input | 是（file_path） | ✓（B：validate_existing_local_path，允许库外待导入项） |
| `get_file_info` | read, path-input | 是（path） | ✓（B：validate_existing_local_path） |
| `backfill_file_hashes` | read, write | 否 | — |

### 媒体读取与预览

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `read_media_file_as_base64` | read | 否（按 media_id） | — |
| `read_attachment_file_as_base64` | read | 否（按 attachment_id） | — |
| `read_attachment_preview` | read | 否（按 attachment_id） | — |
| `get_attachment_preview_data` | read, path-input | 是（path） | ✓（B：validate_existing_local_path，附件可在库外） |
| `extract_colors` | read, path-input | 是（file_path） | ✓（B：validate_existing_local_path） |
| `probe_image_dimensions` | read | 否（按 id） | — |

### 元数据与标签

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `update_ai_metadata` | write | 否 | — |
| `update_tags` | write | 否 | — |
| `update_media_dimensions` | write | 否 | — |
| `repair_missing_dimensions` | write | 否 | — |
| `rehydrate_all_media_metadata` | write | 否 | — |

### 附件

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `add_media_attachments` | write, path-input | 是（paths） | ✓（B：canonical_regular_file_path，附件为库外引用、不复制进库） |
| `remove_media_attachment` | write | 否 | — |

### 缩略图

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `generate_thumbnail` | write | 否 | — |
| `ensure_media_preview_thumbnails` | write | 否 | — |
| `generate_preview_thumbnail_for_item` | write | 否 | — |
| `regenerate_all_thumbnails` | write | 否 | — |
| `regenerate_missing_micro` | write | 否 | — |
| `count_missing_thumbnails` | read | 否 | — |
| `rebuild_missing_thumbnails` | write | 否 | — |
| `cancel_rebuild_thumbnails` | write | 否 | — |
| `force_clear_thumbnails` | destructive | 否 | — |
| `check_ffmpeg_available` | shell-open | 否（spawn ffmpeg） | — |

### 回收站

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `move_to_trash` | destructive | 否（按 id） | ✓ |
| `batch_move_to_trash` | destructive | 否（按 ids） | ✓ |
| `restore_from_trash` | write, destructive | 否（按 id） | ✓ |
| `batch_restore_from_trash` | write, destructive | 否（按 ids） | ✓ |
| `reconcile_trash_with_disk` | write | 否 | ✓ |
| `get_trash_diagnostics` | read | 否 | — |
| `empty_trash` | destructive | 否 | ✓ |

### 永久删除与批量清理

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `delete_file_permanently` | destructive | 否（按 id） | ✓ |
| `batch_delete_files_permanently` | destructive | 否（按 ids） | ✓ |
| `clear_all_media` | destructive | 否 | — |
| `emergency_cleanup_invalid_files` | destructive | 否 | — |

### 文件管理（库内）

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `rename_file` | write, path-input | 否（按 id + new_name） | ✓ |
| `move_file_to_folder` | write, path-input | 是 | ✓ |
| `fix_paste_filenames` | write | 否 | — |
| `replace_file` | write, destructive, path-input | 是（source_path） | ✓（A：目标 resolve_under_library_root；B：source validate_existing_local_path） |
| `import_file_to_library` | write, path-input | 是（source_path） | ✓（A：落盘目标 resolve_under_library_root + 库内相对目录校验） |
| `import_paths_to_library` | write, path-input | 是（paths） | ✓（A：逐项落盘目标 resolve_under_library_root） |
| `save_clipboard_image` | write, path-input | 是（target_folder/file_name） | ✓（A：落盘目标 resolve_under_library_root + 库内相对目录校验） |
| `import_generated_image_to_ai_prompts` | write, path-input | 是（source_path） | ✓（A：落盘目标 resolve_under_library_root） |

### 库根与平台

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `init_library` | write, path-input | 是（parent_path） | ✓（C：ensure_switchable_library_root 定义库根，不套库内校验） |
| `get_library_root` | read | 否 | — |
| `set_library_root` | write, path-input | 是（path） | ✓（C：ensure_switchable_library_root 定义库根，不套库内校验） |
| `get_native_platform` | read | 否 | — |

### 文件输出与系统交互

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `save_file_as` | write, path-input | 是（source_path，目标走对话框可在库外） | ✓（B：source validate_existing_local_path） |
| `write_temp_file` | write | 否（base64 → 临时目录） | 临时目录 |
| `start_file_drag` | shell-open, path-input | 是（paths） | ✓（A：resolve_under_library_root，仅拖出库内已存在文件） |
| `show_in_folder` | shell-open, path-input | 是（path） | ✓ |
| `open_path` | shell-open, path-input | 是（path） | ✓ |

### 书签与浏览器

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `add_bookmark` | write, path-input | 是（url） | ✓（validate_http_url） |
| `get_bookmarks` | read | 否 | — |
| `update_bookmark` | write | 否 | — |
| `delete_bookmark` | destructive | 否（db 行） | — |
| `open_url_in_browser` | shell-open, network, path-input | 是（url） | ✓（validate_http_url + open::that） |

### 偏好与 AI 会话

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `get_preference` | read | 否 | — |
| `set_preference` | write | 否 | — |
| `load_ai_chat_session` | read | 否 | — |
| `save_ai_chat_session` | write | 否 | — |
| `delete_ai_chat_session` | destructive | 否（db 行） | — |

### AI Agent 工具（commands::ai_tools）

| 命令 | 风险标签 | path-input | 库根校验 |
|------|----------|-----------|---------|
| `ai_search_library` | read, AI | 否 | — |
| `ai_get_item_detail` | read, AI | 否 | — |
| `ai_batch_get_items` | read, AI | 否 | — |
| `ai_reverse_prompt` | read, AI | 否 | — |
| `ai_get_library_stats` | read, AI | 否 | — |
| `ai_add_tags` | write, AI | 否 | — |
| `batch_add_tags` | write, AI | 否 | — |
| `ai_set_category` | write, AI | 否 | — |
| `ai_update_prompt` | write, AI | 否 | — |
| `ai_web_search_save` | write, AI | 否（待确认是否出网） | — |
| `openai_get_config` | read, AI | 否（key 应脱敏返回） | — |
| `openai_list_models` | network, AI | 否 | — |
| `openai_chat_completion` | network, AI | 否 | — |
| `openai_generate_image` | network, AI, write | 否（生成图落盘） | — |

---

## 路径安全约定（P0 整改方向）

1. **统一校验入口（已落地）**：落盘类命令统一复用 `resolve_under_library_root(input, library_root) -> Result<PathBuf>`，对输入与库根分别 `canonicalize`（解析符号链接、消除 `..`、借助规范化处理 macOS 大小写不敏感与 Unicode 归一化差异），再用 canonical 结果做 `starts_with` 边界判定；目标尚不存在时规范化最近的已存在祖先目录再拼接剩余段，并拒绝剩余段中的穿越组件。外部来源/外部引用类命令复用 `validate_existing_local_path`（存在性 + 规范化，不强制库内）；库根定义类命令走 `ensure_switchable_library_root`。
2. **路径校验接入（已完成）**：上述命令按语义分三类接入——A 类（落盘目标须在库根内）：`scan_directory`、`import_file_to_library`、`import_paths_to_library`、`import_generated_image_to_ai_prompts`、`save_clipboard_image`、`replace_file`（目标）、`start_file_drag`；B 类（外部来源/引用，仅存在性 + 规范化，允许库外）：`replace_file`（source）、`add_media_attachments`、`extract_colors`、`get_file_info`、`get_attachment_preview_data`、`check_duplicate`、`save_file_as`（source）；C 类（定义库根本身）：`set_library_root`、`init_library`。
3. **破坏性命令服务端二次确认**：`delete_file_permanently`、`batch_delete_files_permanently`、`empty_trash`、`clear_all_media`、`emergency_cleanup_invalid_files` 不应只信任前端 Modal，后端校验目标范围（库内 / 受控回收站）与 confirmation token。
4. **出网最小化**：`network` 命令仅限用户显式配置 provider 后调用；endpoint 白名单与 key 处理集中在后端，日志脱敏。

> 维护提示：本表按 `src-tauri/src/lib.rs` 的 `generate_handler!` 注册顺序与领域归并整理；新增/删除命令时同步更新对应分组与“库根校验”状态。
