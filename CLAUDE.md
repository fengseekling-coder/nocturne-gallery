# Gega Gallery — Claude 协作说明

> 版本：2026-04-21

本文件定义 Claude 在 Gega Gallery 项目中的职责、协作边界与文档维护方式。

---

## 1. 角色定位

Claude 负责：

- 需求拆解与方案判断
- 跨模块架构决策
- UI / 交互方向把关
- 代码审查与回归风险识别
- 文档更新与规范维护

Claude 不默认承担大规模实现工作。常规代码修改优先交给实现型 Agent 执行，Claude 只在以下情况直接改代码：

- 文档更新
- 小范围修复
- 多轮委派后仍未落地
- 需要统一多个实现结果时

---

## 2. 开工前必读

处理任何需求前，必须先对齐以下文档：

1. [AGENTS.md](./AGENTS.md)
2. [docs/DESIGN.md](./docs/DESIGN.md)
3. 当前需求涉及的源码文件

如果文档与现状冲突，以“已落地实现 + 最新产品决策”为准，并在交付中同步更新文档。

---

## 3. 当前产品事实

以下内容已经是当前实现的一部分，后续方案不得回退：

- 三栏布局固定：Sidebar 192px、Canvas 自适应、Inspector 默认 256px，可拖拽到 240~600px
- 三栏顶部严格 48px 对齐
- Sidebar 分为三段：主导航固定、分组列表独立滚动、底部操作固定
- 主导航是大分组，自定义分组是小分组
- 点击大分组显示其下全部素材
- 点击自定义分组只显示该分组素材，不能混出其他分组内容
- 内容区普通提示统一为“内容区底部居中胶囊提示”
- 删除确认、重复素材确认等需要决策的提示使用居中弹窗，不走底部胶囊
- 重复素材导入会弹出居中确认框，并显示已有素材所在分组
- Prompt 区“查看完整”是面板内展开，不使用弹窗
- 双击查看大图与右键“查看大图”都必须同步右侧属性面板
- 媒体卡片右上角收藏图标已移除
- 素材选中态不再使用缓动动画，直接切换高亮
- 已支持从本地文件、文件夹、网页向应用内拖入
- 已支持从应用内将单个或多个已选素材拖出到外部

---

## 4. Claude 的输出要求

### 4.1 与用户沟通

- 用中文
- 先说结论，再说关键依据
- 非必要不抛开放式问题
- 如果存在明显分支，只给 2~3 个清晰选项

### 4.2 给实现型 Agent 的任务描述

应包含：

- 修改目标文件
- 期望行为
- 需要避免的回归
- 验证方式

不应包含：

- 冗长背景
- 整段 diff
- 与当前任务无关的重构要求

---

## 5. 文档维护规则

以下情况必须同步更新文档：

- 交互规则变化
- 视觉规范变化
- 数据流或分组逻辑变化
- 拖拽、导入、预览、提示系统变化
- 新增明确禁用项

优先更新：

1. `AGENTS.md`：项目统一规则
2. `docs/DESIGN.md`：视觉与交互规范
3. `CLAUDE.md`：协作方式、当前事实、决策边界

---

## 6. 审查重点

Claude 在交付前至少检查以下项目：

- 是否违反设计 Token 规则
- 是否出现硬编码颜色
- 是否把决策型弹窗做成了 toast
- 是否破坏大分组 / 小分组的数据隔离
- 是否破坏拖入 / 拖出链路
- 是否让 Inspector 与预览态再次不同步
- 是否引入窗口拖拽区与交互区冲突
- 是否新增无反馈、静默失败或“看起来没反应”的交互

---

## 7. 当前已知优先方向

- 继续提升大库滚动稳定性与加载体感
- 统一所有导入入口的重复素材处理策略
- 强化多素材拖出到外部时的稳定性验证
- 继续清理文档与实现之间的历史偏差

---

## 性能不可回退红线

以下任意一项被改动都会让数千~万级库立刻退化，PR 审查必须挡住：

1. **MediaCard 主容器禁止内联 style**：所有视觉态（hover/selected/active/dragging/drag-preview）都走 `.media-card.is-xxx` CSS class；禁止再用 `useState(isHovered)` + onMouseEnter/Leave；鼠标在网格里划过会经过几十张卡，每张走 React state = 几十次 re-render
2. **MediaCard 视频禁止 fallback 到原文件**：`<img src=video.mp4>` 会持续触发 onError + 浪费 fetch/decode；视频必须有 ffmpeg 抽帧的 thumbnailPath 才显示，否则返回 `''` 由占位 div 渲染
3. **MediaCard 图片只在 fileSize ≤ 2MB 才回落原图**：超过 2MB 的图必须有缩略图才显示；上限常量 `MAX_INLINE_ORIGINAL_PREVIEW_BYTES`，要降不要升
4. **框选拖动期间禁止 setSelectedIds**：拖动中改 store → 所有 MediaCard 的 `selectedIds.has()` selector 都重算 = 60Hz × N 卡级联 re-render；必须用本地 `Set<string>` + 直接 `classList.add('is-drag-preview')` 维护视觉，仅在 mouseup 才 commit 到 store
5. **virtualizedCards 启动 fallback ≤ 30**：viewportHeight 还没测量出来时不要预渲染 200 张（卡启动）
6. **Canvas / MediaCard 传给 React.memo 子组件的 callback 必须引用稳定**：禁止 `onDragStart={() => ...}` 内联箭头；用 useCallback 且依赖项不能含 files 等高频变化的 array
7. **批量操作必须走 batch IPC**：禁止 `for (const id of selectedIds) await invoke('xxx', { id })`；后端有 `batch_move_to_trash` / `batch_add_tags` / `import_paths_to_library`；新增其它批量场景必须先在 Rust 加 batch 命令
8. **MediaCard wrapper 必须带 `content-visibility: auto` + `containIntrinsicSize`**：虚拟化外的双保险，让浏览器跳过缓冲区内卡片的 paint/layout；改动这个 wrapper 时别误删
9. **watcher 事件必须批量化处理**：`start_event_loop` 用 200ms drain window 汇集事件后用 rayon 并发 import；禁止退回到"recv 一个 import 一个"的串行循环——外部 git checkout / rsync 一次塞几千文件时会让 UI 看起来卡住几分钟
10. **MediaCard 列数自适应缩略图档位**：`columnCount ≥ 5` 时卡片 < 240px，必须用 micro（256px WebP Q70，1.1×+ oversampling）；`columnCount ≤ 4` 时卡片 240-600px，需用 main（800px JPEG Q90）。禁止固定单一档位——5+ 列用 main 会让 30 张卡同时解码 800px JPEG（150-300ms 主线程阻塞），2-4 列用 micro 会让 400px 卡片拉伸 256px 缩略图（明显模糊）
11. **sentinel rootMargin 不要小于 1500px**：触底加载提前量太小（如 600px ≈ 3 行）会让快速滚动时用户能看到底部短暂白屏；1500px 给 SQL 查询 + IPC + 解码足够提前量
12. **enrich 图片分支必须用单读管线**：`enrich_image_single_read` 一次 `image::open` 后所有图像产物（main / micro / thumbhash / colors）共享同一 DynamicImage；禁止在 enrich 路径上重新引入"按 filepath 各自重新打开"的写法（每次 `image::open(filepath)` 对 4MB+ PNG 要 1.5s 解码）。视频走 ffmpeg 抽帧产物作为源，不走 image::open。
13. **LIGHT_ENRICH_SEMAPHORE 必须按 CPU 核数自适应**：固定 4 在 8+ 核机器上 worker 不够；用 `available_parallelism() - 1` 在 [4, 12] 范围内自适应，避免大批量导入时用户看着 fallback 等几十秒
14. **micro/thumbhash backfill 必须优先从 thumbnail_path 派生**：`regenerate_missing_micro` 路径上，凡是 `thumbnail_path` 存在且可读的行，一律 `image::open(thumbnail_path)` 后单读管线派生 micro + thumbhash；仅当 `thumbnail_path` 缺失/不可读且 mime 是图片时才回退到原图 `filepath`。禁止在 backfill 路径上无条件读 `filepath`——4MB+ 原图解码会让 1900 张旧库 backfill 退化到 30+ 分钟（实测从 30+ 分钟降到 < 60s）

---

## 8. 一句话原则

Claude 的工作目标不是”写更多”，而是让产品方向、实现质量和文档状态始终保持一致。

---

## 当前优化增强

| 优化项目 | 文件 | 说明 |
|------|----------|------|
| 颜色提取缓存 | `src/components/detail/DetailPanel.tsx` | 为颜色提取功能添加缓存机制，解决滚动时色块闪烁问题 |
| 瀑布流滚动 | `src/components/canvas/Canvas.tsx` | 优化滚动容器设置，确保内容区可正确滚动 |
| Inspector 滚动条隐藏 | `src/components/detail/DetailPanel.tsx` | scrollbar-width: none + webkit 伪元素 |
| Inspector 预览图自适应 | `src/components/detail/DetailPanel.tsx` | height: auto + max-height: 400px + object-fit: contain |
| 顶部工具栏固定 | `src/components/detail/DetailPanel.tsx` | flex 布局分离工具栏和滚动区，工具栏 flex-shrink: 0 |
| 重复检测 | `src-tauri/src/media/hash.rs` | SHA256（字节级）+ pHash（感知哈希，汉明距离≤3），导入/文件监控时自动检测 |
| replace_file | `src-tauri/src/commands/mod.rs` | 文件替换事务保护，先提交数据库再删除旧文件，失败时回滚 |
| 窗口拖拽 | `src/styles/globals.css` | data-tauri-drag-region 覆盖侧边栏/工具栏/Inspector顶部，交互元素用 no-drag 排除 |
| 虚拟滚动 | `src/components/canvas/Canvas.tsx` | IntersectionObserver 触底加载，每页100条，切换 section 重置 |
| user_preferences 表 | `src-tauri/src/db/mod.rs` | 所有 UI 偏好持久化到 SQLite，localStorage 零残留 |
| AI 锁定模式 | `src/stores/uiStore.ts` | isAIMode=true 时面板锁定 AI 对话，点击图片只更新 system prompt 上下文 |
| 品牌重塑 | 全局 | 已启用 Gega Gallery 品牌视觉与荧光绿配色方案 |
| 共享 IntersectionObserver | `src/components/canvas/Canvas.tsx` + `MediaCard.tsx` | Canvas 维护单例 observer + Map<Element, cb>，MediaCard 通过 observe/unobserve props 注册，消除百卡并发 observer |
| Canvas 静态样式常量 | `src/components/canvas/Canvas.tsx` | 28 个纯静态 style 对象提升为模块级常量，动态样式改用 useMemo（8 个），消除每帧重建开销 |
| ThumbnailQueue 退出机制 | `src-tauri/src/media/thumbnail_queue.rs` | 添加 shutdown: Arc<AtomicBool>，loop 头部检查，Drop 时发送信号；所有 lock().unwrap() 改为 unwrap_or_else 防 PoisonError panic |
| replace_file 安全顺序 | `src-tauri/src/commands/mod.rs` | 操作顺序改为：copy→.tmp、rename 覆盖旧文件、DB 事务更新，彻底消除旧文件已删但 DB 未更新的窗口期 |
| 缩略图失败补救注释 | `src-tauri/src/media/scanner.rs` | 缩略图生成失败改用 log::warn! 并注明：DB 记录保留 thumbnail_path=NULL，下次扫描通过 load_and_migrate_meta_json 自动补生成 |
| DB 查询错误可观测 | `src-tauri/src/media/thumbnail.rs` | sha256/phash/color_dominant 三处静默 unwrap_or(None) 改为 unwrap_or_else + log::warn!，错误不再静默丢失 |
| fetchFiles 去重 | `src/App.tsx` | 删除与 checkAndScanLibrary 重复的第二个 libraryRoot useEffect，启动时 fetchFiles 只调用一次 |
| messagesRef 模式注释 | `src/hooks/useAgentChat.ts` | 添加注释说明 messagesRef 镜像 messages 的原因（stale closure 问题），防止后续维护者误删 |
| PDF.js 本地 Worker | `src/components/detail/DetailPanel.tsx` | workerSrc 改用 new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href，消除 CDN 依赖和版本不匹配问题 |
| 视频缩略图（ffmpeg） | `src-tauri/src/media/thumbnail.rs` | ffmpeg 提取第一帧（1s→0s 回退），保存至 .nocturne_meta/{filename}_thumb.jpg，失败时 thumbnail_path=NULL + log::warn! |
| ffmpeg 状态 UI | `src/components/detail/DetailPanel.tsx` | 视频无缩略图显示 ▶ + “暂无预览”占位；ffmpeg 缺失时显示 var(--error) 10% 半透明横幅 |
| 导入进度事件 | `src-tauri/src/commands/mod.rs` + `scanner.rs` | scan/rescan/import 均发送 import_progress {current,total,filename} 和 import_complete {total}，total 仅计新文件（HashSet 预统计） |
| check_ffmpeg_available | `src-tauri/src/commands/mod.rs` | 新增 Tauri Command，运行 ffmpeg -version 返回 bool，前端首次选中视频时调用一次并缓存结果 |
| ModelCombobox 选中排序 | `src/components/detail/ModelCombobox.tsx` | 选中模型始终排列表第一；× 按钮（visibility 控制）取消选中留空 |
| ChatMessageContent | `src/components/detail/ChatMessageContent.tsx`（新增） | 用户消息 pre-wrap，AI/工具消息 GFM Markdown + rehype-highlight + 代码块复制按钮 |
| AI 对话交互增强 | `src/hooks/useAgentChat.ts` + `DetailPanel.tsx` | textarea 自动增高、AbortController 停止生成、消息悬停操作、新对话、context chip、回到底部 FAB |
| AI 对话扁平布局 | `src/components/detail/DetailPanel.tsx` | AI 消息去气泡改扁平（● Gega AI 身份行 + 常驻时间戳）；用户气泡限 max-width:85%；间距 12→20px |
| 百炼模型修复 | `src/components/detail/DetailPanel.tsx` | 从 `model_configs` 读用户配置的百炼模型；去掉误报”拉取失败”文案 |
| 单读管线 | `src-tauri/src/media/scanner.rs` | `scan_single_file` 改为单次读取管线：fs::read → SHA256 → load_from_memory → 尺寸/pHash/缩略图/micro/thumbhash 全部复用同一 DynamicImage，消除 5 次重复磁盘 IO |
| 缩略图算法优化 | `src-tauri/src/media/thumbnail.rs` | 新增 generate_micro_from_image 和 generate_thumbhash_from_image（接受 &DynamicImage，不重读磁盘）；Lanczos3 → CatmullRom（~3× 更快）；JPEG 质量 90→82（~30% 更快编码） |
| import_paths_to_library 批量导入 | `src-tauri/src/commands/mod.rs` | 批量路径导入，复制完成后再发完成进度，避免 DB 占位成功但物理文件尚未复制完成 |
| 拖放流程 | `src/components/canvas/Canvas.tsx` | 先查重，再按单文件/多路径导入，重复素材走居中确认弹窗 |
| DB 连接级 pragma | `src-tauri/src/db/mod.rs:open_conn` | 补全 5 个pragma（cache_size=-64000、synchronous=NORMAL、temp_store=MEMORY、mmap_size=512MB、busy_timeout=5000）——原来只在 init_db 设置，每次短连接都用 2MB 默认缓存 |
| DB 复合索引 | `src-tauri/src/db/mod.rs` | 新增复合索引 (is_trashed, imported_at DESC) 覆盖主查询排序，移除重复索引 idx_media_files_status |
| 跳过 COUNT 查询 | `src-tauri/src/db/crud.rs` | query_media_files 增加 skip_count: bool 参数，page > 1 时跳过 COUNT 查询，返回 total=-1 |
| 热路径日志降级 | `src-tauri/src/commands/mod.rs` | get_media_files、import_file_to_library、check_duplicate 内 eprintln! 降级为 log::debug!，消除热路径阻塞 I/O |
| targetFile useMemo | `src/components/canvas/Canvas.tsx` | targetFile 改为 useMemo（O(n)→O(1)）；IntersectionObserver rootMargin 200→400px（更早预加载） |
| MediaCard 静态 style | `src/components/canvas/MediaCard.tsx` | 主容器静态 style 提取为模块常量，消除每次 render 重建内存分配 |
| detailCache LRU | `src/stores/mediaStore.ts` | detailCache 新增 LRU 50 条上限；fetchFiles 兼容 total=-1（保留缓存 totalCount） |
| micro 源派生策略 | `src-tauri/src/media/thumbnail.rs` + `commands/mod.rs` | regenerate_missing_micro 优先从 thumbnail_path 派生 micro + thumbhash，旧库 1900 张 backfill 从分钟级降至秒级，对齐红线 #14 |

---

### 已完成功能列表 (v5.8)
- **架构**：`.nocturne_meta/` 侧边存储架构，实现元数据与素材目录共存
- **标签**：全自动标签编辑系统，支持实时保存与 JSON 复本持久化
- **引擎**：全自动颜色主色提取引擎，支持感知哈希（pHash）去重
- **搜索**：多维度本地搜索（文件名、标签、AI 提示词 LIKE 匹配）
- **数据库**：DB 跟随库根目录移动，支持空库自动从 JSON 备份重建
- **交互**：框选多选功能完善，支持批量操作与 Inspector 联动
- **布局**：Masonry 瀑布流核心逻辑重构
- **性能**：共享 IntersectionObserver 单例（百卡懒加载从 N 个 observer 降为 1 个）
- **性能**：Canvas 28 个静态样式常量 + 8 个 useMemo 动态样式，消除每帧对象重建
- **稳定性**：replace_file 文件操作顺序修复（copy→tmp→rename→DB，消除数据不一致窗口期）
- **可观测**：缩略图/DB 查询失败从静默降级改为 log::warn! + 自动补生成注释
- **正确性**：App 启动时 fetchFiles 去重（从两次降为一次）
- **视频支持**：ffmpeg 视频缩略图提取（1s→0s 回退），Inspector 占位图 + ffmpeg 缺失横幅提示
- **进度反馈**：导入流程全面支持 import_progress / import_complete 事件推送
- **AI 优化**：Prompt Caching 接入，系统提示和工具定义缓存，AI 对话成本降低 90%
- **AI 优化**：Tool Streaming 实时状态，工具调用显示动态文案和脉冲动画
- **批量打标**：批量分析功能，支持 Ollama/Claude 双路径，结果以对话形式呈现
- **交互修复**：缩放滑块脱离绝对定位，本地 state 解耦，快速拖动不再回弹
- **交互修复**：工具栏点击不触发框选矩形（排除 .no-drag / input / button）
- **布局重构**：瀑布流改为行式布局（类 Eagle 模式），横竖图混排零空白，间距 4px
- **AI 配置重构**：PreferencesPanel AI 区块改为动态模型列表（`model_configs` JSON），每行一个模型，支持无限添加/删除，同厂商可多模型并存，含 Ollama/Claude/百炼/Tavily/自定义五种提供商
- **Ollama 自动扫描**：首选项面板打开时自动扫描本地已安装模型（3s 超时，去重合并，静默失败），无需手动逐个添加
- **模型配置迁移**：首次打开自动从旧 individual preference keys（`ollama_url` 等）迁移至 `model_configs` JSON；同时保持向旧代码（DetailPanel）的个别 key 向下兼容写入
- **ModelCombobox 交互优化**：选中模型永远排列表第一；选中行右侧新增 × 按钮可取消选中（留空）；× 使用 `visibility: hidden` 维持列对齐
- **AI 对话 Markdown 渲染**：新增 `ChatMessageContent` 组件，用户消息 pre-wrap 保留格式，AI/工具消息走 GFM（表格/列表/删除线）+ rehype-highlight 代码高亮 + 代码块一键复制按钮
- **AI 对话交互增强**：textarea 自动增高（80→240px）、停止生成按钮（AbortController 网络 + UI 双层中断）、消息悬停显示复制/重试/时间戳、新对话按钮（clearHistory）、当前图片 context chip、回到底部 FAB
- **AI 对话布局重构**：扁平 AI + 气泡 User 设计（类 Claude.ai 风格）；AI 消息去掉气泡背景，改为顶部 “● Gega AI” 身份行 + 时间戳 + 操作按钮；用户气泡 max-width 限为 85%；消息间距 12px→20px
- **百炼模型修复**：模型选择菜单改从 `model_configs` 读用户已配置的百炼模型，不再误报”拉取失败”；无配置时提示”请在首选项添加”
- **上传优化**：单读管线（5次IO→1次）、CatmullRom缩略图（~3×更快）、JPEG质量优化（~30%更快编码）、导入完成事件等待物理复制成功
- **DB 全面调优**：open_conn补全pragma（连接级缓存64MB）、复合索引覆盖主查询、skip COUNT(page>1)、hot path eprintln→log::debug
- **前端零分配优化**：targetFile useMemo、MediaCard静态style常量、detailCache LRU-50、IntersectionObserver rootMargin 400px
- **backfill 策略优化**：micro/thumbhash 派生源优先 thumbnail_path（800px 主缩略图），仅在缺失时回退原图，旧库回填吞吐数量级提升

---

## 当前已知问题

### 当前审查遗留
详见 `.audit/findings.md`。当前仍需架构设计的是 Tauri CSP / asset scope 收敛；文档原型和历史测试产物也需要继续清理，避免误导后续实现。

---

## 下次优先处理

1. 继续提升大库（5000+ 文件）滚动体感
2. 优化 AI 对话在长上下文（>20条消息）时的响应延迟
3. 补全导出功能（目前仅支持导入）
