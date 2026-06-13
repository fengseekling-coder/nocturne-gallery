# Tauri 命令对照

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

当前基线（随代码演进会变）：约 **62** 个前端 invoke、**81** 个已注册命令（多出的多为 Rust 内部或尚未从前端调用的 API）。

## 开发注意

- 新增 `invoke` 时必须在 `lib.rs` 的 `generate_handler!` 中注册同名函数（或 `commands::…::fn` 映射）。
- AI 相关命令在 `src-tauri/src/commands/ai_tools.rs`，以 `commands::ai_tools::…` 形式注册。