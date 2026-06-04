# Gega Gallery — 缩略图架构升级 开发规范 v1.0

> 目标：让 Gega Gallery 在 10K+ / 100GB 素材库下达到苹果相册级别的极致丝滑体验。
> 交付方：Qwen Code
> 审核方：Claude
> 预计工作量：4-5 天

---

## 📋 一、核心目标

用户痛点：
- 现在只有**单档 800px JPEG** 缩略图，在 4K/Retina 屏上看略糊
- 全屏预览直接读原图，大文件（50MP+）卡顿
- IntersectionObserver 只懒加载不卸载，滚到几千张内存爆
- 无渐进占位，滚动时看到空白

升级后达成：
1. **视觉等价原图**：4K/Retina 屏上眼睛贴到屏幕也看不出缩略图和原图的区别
2. **10K 库 60fps 滚动**：永不卡顿，永不内存爆
3. **全屏预览瞬开**：0 延迟显示，后台渐进替换到原图
4. **原图级放大**：全屏 5x 放大依然锐利

---

## 🏗️ 二、整体架构

### 1. 多档位缩略图（LOD 金字塔）

| 档位 | 尺寸 | 格式 | 质量 | 用途 |
|---|---|---|---|---|
| `thumbhash` | ~20 字节 | Base83 文本 | — | 加载前的彩色模糊占位（存 DB 字段） |
| `micro` | 256px 长边 | WebP | q70 | 瀑布流快速滚动 / 初始首屏 |
| `standard` | 800px 长边 | WebP | q80 | 瀑布流正常显示（= 当前唯一档） |
| `preview` | 2048px 长边 | WebP | q85 | Inspector 预览 / 全屏初始显示 |
| `original` | 原图 | 不动 | — | 全屏 zoom > 1x 后台加载 |

存储位置：`{原图目录}/.nocturne_meta/{filename}_{tier}.webp`
- `{filename}_thumb.webp` = Standard 档（**复用现有路径**，向后兼容）
- `{filename}_micro.webp` = Micro 档（新）
- `{filename}_preview.webp` = Preview 档（新，懒生成）

### 2. 渐进加载时序

```
卡片进视口:
  [ThumbHash 模糊色块] → [Micro 256px] → [Standard 800px]
                         瞬间                滚动停止 150ms 后

打开 Inspector:
  [Standard 立即显示] → [Preview 2048px 后台换入]

全屏预览:
  [Preview 立即显示] → [Original 后台换入]
  用户 zoom > 1x: 确保 Original 已加载再允许继续放大
```

### 3. 内存窗口化（双向 IntersectionObserver）

```
进入视口:    加载当前档位
离开视口 8 行外:  img.src = undefined  ← 释放 bitmap
重新进入:    重新加载
```

---

## 📦 三、改动清单（按文件）

### 🦀 后端 Rust

#### 文件 1：`src-tauri/Cargo.toml`
**功能**：新增依赖
- `webp = "0.3"` — WebP 编码
- `thumbhash = "0.1"` — ThumbHash 生成（如果 crate 不可用，用 `blurhash` 替代）

#### 文件 2：`src-tauri/src/db/mod.rs`
**功能**：Schema migration，为 `media_files` 表新增 3 列
- `thumbnail_micro_path TEXT`（可空）
- `thumbnail_preview_path TEXT`（可空）
- `thumbhash TEXT`（可空，存 Base83 编码字符串）

**要求**：
- 用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 形式，兼容旧库打开时自动升级
- `SELECT` 查询同步更新返回这 3 个新字段
- 新增索引：不需要（这 3 列不做查询条件）
- DB 升级前**先备份**原 DB 到 `.nocturne/backup_v{N}_YYYYMMDD.db`

#### 文件 3：`src-tauri/src/media/thumbnail.rs`
**功能**：扩展缩略图生成，从单档变三档 + ThumbHash

新增函数签名：
```rust
pub fn generate_micro_thumbnail(src: &Path, dst: &Path) -> Result<()>;
pub fn generate_preview_thumbnail(src: &Path, dst: &Path) -> Result<()>;
pub fn generate_thumbhash(src: &Path) -> Result<String>; // 返回 Base83 编码
```

改造现有 `generate_thumbnail`：
- 保留函数名，改为生成 WebP 替代 JPEG（降低文件体积）
- **过渡方案**：两种都可以接受 —— 要么改成 WebP（推荐），要么新增一个 `generate_standard_thumbnail` 同时保留旧函数过渡

**常量规范**：
```rust
const MICRO_SIZE: u32 = 256;
const STANDARD_SIZE: u32 = 800;       // 原 THUMB_SIZE
const PREVIEW_SIZE: u32 = 2048;
const MICRO_QUALITY: f32 = 70.0;
const STANDARD_QUALITY: f32 = 80.0;
const PREVIEW_QUALITY: f32 = 85.0;
```

**边缘情况处理**（必须覆盖）：
- SVG：三档都复制原 SVG（保留矢量）
- GIF：三档都取第一帧（用现有逻辑）
- 视频：三档都用 ffmpeg 提取同一帧，resize 到对应尺寸
- 原图尺寸 < Preview 档：Preview 档跳过生成，存 NULL
- 原图尺寸 < Micro 档：Micro 档跳过生成，存 NULL
- 生成失败：对应字段存 NULL + `log::warn!`，不 panic

#### 文件 4：`src-tauri/src/media/scanner.rs`
**功能**：导入/扫描时的生成策略改为分级

- **同步生成**（阻塞导入流程）：`micro` + `standard` + `thumbhash`
- **不生成**：`preview` ← 懒生成，首次进 Inspector 时才触发
- 更新 `import_progress` 事件，将 `standard` 生成完成视为进度 +1（与现状一致，不加新事件）

#### 文件 5：`src-tauri/src/commands/mod.rs`
**功能**：新增 3 个 Tauri Commands

```rust
// 首次进 Inspector 调用，懒生成 Preview 档
generate_preview_thumbnail_for_item(item_id: i64) -> Result<String, String>  // 返回生成后的路径

// 后台任务：扫描全库找缺失的 micro/preview/thumbhash 的条目，增量补齐
rebuild_missing_thumbnails() -> Result<(), String>  // 通过事件推进度

// 查询当前库里缺失多少条需要重建
count_missing_thumbnails() -> Result<u64, String>
```

**事件规范**：
- `thumbnail_rebuild_progress { current, total, current_file }`
- `thumbnail_rebuild_complete { total }`
- `thumbnail_rebuild_error { item_id, error }`

**注意**：
- `rebuild_missing_thumbnails` 必须可取消（用 `AtomicBool` 做 shutdown flag）
- 批大小：一次处理 5 条，避免阻塞 UI
- 每条之间 `sleep(10ms)`，让 IO 喘口气

#### 文件 6：`src-tauri/src/lib.rs`
**功能**：注册新 Commands 到 `tauri::generate_handler!` 宏里

---

### ⚛️ 前端 TypeScript / React

#### 文件 7：`src/types/media.ts`（或 `src/types/index.ts`）
**功能**：扩展 MediaFile 类型

```typescript
// 新增字段（全部可选，兼容旧数据）
thumbnail_micro_path?: string | null;
thumbnail_preview_path?: string | null;
thumbhash?: string | null;
```

**字段命名**：**严格遵守**现有命名风格（snake_case 来自 Rust 序列化），不要改成 camelCase。

#### 文件 8：`src/utils/thumbhash.ts`（新增）
**功能**：ThumbHash 解码工具

```typescript
// 把 Base83 字符串解码为 base64 data URL，可直接喂给 <img src>
export function thumbHashToDataURL(hash: string): string;

// 降级：没有 thumbhash 时返回纯灰占位的 data URL
export function fallbackPlaceholder(width: number, height: number): string;
```

**实现提示**：
- 用 npm 包 `thumbhash`（如果不可用，用 `thumbhash-ts` 或 inline 算法）
- 解码结果缓存到 `Map<string, string>` 避免重复计算
- 缓存上限 2000 条（LRU 淘汰）

#### 文件 9：`src/components/canvas/MediaCard.tsx`
**功能**：渐进加载 + 双向视口窗口化

核心改动：

1. **props 新增**（由 Canvas 传入）
   - `isInViewport: boolean` — 是否在当前视口窗口内（含 buffer）
   - `isScrolling: boolean` — 是否正在快速滚动

2. **加载档位选择逻辑**
   ```
   如果 !isInViewport: 不加载任何图，显示 ThumbHash 占位
   如果 isScrolling: 用 Micro 档
   如果 !isScrolling: 用 Standard 档
   ```

3. **渐进切换**
   - CSS `transition: opacity 200ms` 平滑切换
   - 升级（Micro → Standard）时：Standard 加载完再替换，避免闪烁
   - 降级（Standard → Micro）不发生

4. **视口卸载**
   - 离开视口 8 行外时，`img.src = undefined` 释放 bitmap
   - 重新进入时回到渐进加载流程

5. **背景占位**
   - 未加载时用 `<div style={{ background: thumbhashDataURL }}>` 作为背景（不是 `<img>`，避免解码开销）
   - 图片叠加在占位上，opacity 0 → 1 淡入

6. **fallback 链**
   - 新库有 micro_path → 用 micro
   - 老库只有 thumbnail_path → 用 thumbnail_path（Standard）
   - 都没有 → 用原图（最老代码路径）
   - **禁止删除**现有 fallback，只在链最前端加新选项

#### 文件 10：`src/components/canvas/Canvas.tsx`
**功能**：升级 IntersectionObserver + 滚动速度跟踪

1. **双向 Observer**
   - 现有的共享 Observer 单例保留
   - 改为双向：进入视口回调 + 离开视口回调
   - MediaCard 通过回调获知 `isInViewport` 状态

2. **视口窗口扩展**
   - `rootMargin` 从现有值扩展到 `"800px 0px 800px 0px"`（上下各 8 行预加载/保留）
   - 离开超过此范围才卸载

3. **滚动速度跟踪**
   - 在 Canvas 滚动容器上监听 `scroll` 事件
   - 用简单的 `throttle`：每 150ms 计算一次滚动速度
   - 速度 > 1000px/s 视为"快速滚动"，通过 Context 或 props 广播给 MediaCard
   - 滚动停止 150ms 后标记为 "not scrolling"，触发升级到 Standard 档

4. **保留现有性能优化**
   - 28 个静态样式常量
   - 共享 Observer 单例
   - 100 items / page 分页

#### 文件 11：`src/components/detail/DetailPanel.tsx`
**功能**：Inspector 预览图用 Preview 档

1. **图片 src 选择**
   ```
   优先 preview_path
   如果 preview_path 为空 → 调用 generate_preview_thumbnail_for_item 懒生成
     生成期间显示 Standard 档 + 半透明 loading 覆盖
     生成完成后淡入 Preview 档
   如果生成失败 → 永远 fallback 到 Standard 档
   ```

2. **视频逻辑不变**
   - 视频仍然用现有 ffmpeg 逻辑生成缩略图（复用到 Preview 档即可）

#### 文件 12：`src/components/common/FullScreenPreview/FullScreenPreview.tsx`
**功能**：渐进替换 Preview → Original

1. **初始显示**
   - 立即显示 Preview 档（如果有，无则 Standard）
   - **不等原图加载**，秒开用户体验

2. **后台加载原图**
   - 打开时启动 `new Image()` 预加载原图
   - 加载完成 → opacity crossfade 替换（300ms）
   - 如果原图加载失败：保持 Preview，显示小角标"原图不可用"

3. **Zoom 策略**
   - `zoom <= 1.0`：用当前显示的档位（可能是 Preview，可能已换成 Original）
   - `zoom > 1.0`：强制等原图加载完才允许继续放大
     - 如果原图还在加载：显示 loading spinner 在放大图标附近
     - 放大到 2x+ 必须用原图，避免糊

4. **取消加载**
   - 用户关闭预览时，用 `AbortController` 取消正在进行的原图加载
   - 图片超过 50MB 时显示加载进度（用 fetch + 计算字节）

5. **缓存**
   - 最近浏览的 5 张图的 Original 保留在内存（Map）
   - 切换到下一张时，保留上一张的 Original，快速回退

#### 文件 13：`src/components/common/ThumbnailRebuildBanner.tsx`（新增）
**功能**：老库升级时的进度提示条

- 顶部 40px 高横幅，显示"正在升级缩略图 3421 / 10000"
- 右侧 × 可以暂停（调用后端暂停 command）
- 完成后自动消失
- 监听 `thumbnail_rebuild_progress` / `thumbnail_rebuild_complete` 事件
- 样式：`var(--accent-dim)` 背景 + `var(--text-primary)` 文字 + 3px 高底部进度条用 `var(--accent)`

#### 文件 14：`src/App.tsx`
**功能**：启动时检测老库 + 触发重建

1. App 启动时（库初始化完成后）：
   - 调用 `count_missing_thumbnails`
   - 如果 > 0：
     - 显示 `ThumbnailRebuildBanner`
     - 自动调用 `rebuild_missing_thumbnails` 启动后台任务
   - 如果 = 0：banner 不显示

2. **不阻塞 UI**：用户可以正常浏览（浏览时看到的是 Standard 档，渐进升级为 Micro）

---

## 🔄 四、数据迁移策略

### 4.1 DB 迁移
- `src-tauri/src/db/mod.rs` 的 `init_db` 里检查列是否存在，不存在则 `ALTER TABLE ADD COLUMN`
- 迁移前备份 DB 到 `.nocturne/backup_v{version}_{YYYYMMDD}.db`
- 新列 NULL 值不影响旧代码（旧代码只读 thumbnail_path）

### 4.2 缩略图迁移
- **不删除**旧的 JPEG 缩略图（`_thumb.jpg`）
- 新生成的是 `_thumb.webp`，优先用 WebP，fallback 到 JPG
- 老库打开时后台跑 `rebuild_missing_thumbnails`：
  - 遍历 `thumbnail_micro_path IS NULL OR thumbnail_preview_path IS NULL` 的 item
  - **注意**：只补生成 `micro` + `thumbhash` + 可能的 `standard WebP`，**不强制生成 Preview**（Preview 懒生成）
  - 逐个生成，每 5 张 emit 一次进度事件

### 4.3 回滚
- 新字段全部 NULL 时，代码 fallback 到旧行为
- 如需完全回滚：删除 `.nocturne_meta/*_micro.webp` 和 `*_preview.webp`，不影响旧缩略图
- 数据库新列保留为 NULL，代码自动 fallback

---

## ⚠️ 五、边缘情况清单（必须覆盖）

| 情况 | 处理 |
|---|---|
| 原图是 SVG | 三档都复制原 SVG（矢量本身无尺寸概念） |
| 原图是 GIF | 取第一帧，三档都用该帧生成静态 WebP |
| 原图尺寸 < 256px（极小图） | Micro 档跳过，Standard 档缩不大就按原尺寸生成 |
| 原图尺寸 < 2048px | Preview 档跳过（存 NULL，前端自动 fallback 到 Standard） |
| 视频文件 | ffmpeg 提取第 1 秒帧（失败回退到 0 秒），三档都用该帧 resize |
| 原图损坏 | 所有档位都生成失败，三列都 NULL，log::warn!，前端显示通用占位 |
| 原图是 RAW（.cr2/.nef/.arw 等） | 现阶段视为不支持，所有档位 NULL，log::warn!（后续迭代再处理） |
| WebP 编码失败 | fallback 到 JPEG，但扩展名仍用 `.webp`（反正 Chromium 能识别） → 如果 JPEG 也失败，该档位 NULL |
| 老库某张图生成时文件已被用户删除 | 标记 is_missing=true，skip |
| 前端 ThumbHash 解码失败 | 显示纯灰占位，不崩溃 |
| 重建过程中用户关闭 App | 下次启动检测到 missing 还有，继续重建 |

---

## 🧪 六、验收清单（测试项）

### 性能指标（必须达到）
- [ ] 10000 张图瀑布流，滚动帧率 ≥ 55fps（DevTools Performance 实测）
- [ ] 内存占用：浏览 10000 张后，Chromium 进程 < 1.5GB
- [ ] 初次打开库（10000 张）：首屏可见时间 < 800ms
- [ ] 打开 Inspector：图片显示 < 100ms
- [ ] 打开全屏预览：图片显示 < 200ms
- [ ] 全屏放大到 5x：模糊程度肉眼不可察

### 视觉质量
- [ ] 4K/Retina 屏浏览瀑布流，缩略图和原图肉眼无可辨差异
- [ ] 滚动时无闪烁、无黑块
- [ ] 缩略图渐进加载（ThumbHash → Micro → Standard）观感平滑
- [ ] Inspector 预览锐利，无压缩 artifact
- [ ] 全屏预览打开瞬间可见图像（Preview 档），随后无感切换到原图

### 功能正确性
- [ ] 导入新图：Micro + Standard + ThumbHash 立即生成
- [ ] 首次打开 Inspector：Preview 档懒生成并缓存
- [ ] 老库打开：自动启动后台重建，banner 显示进度
- [ ] 重建可暂停/恢复
- [ ] 视频文件：三档缩略图都正确生成（ffmpeg 第 1 帧）
- [ ] GIF 文件：三档都是静态第一帧
- [ ] SVG 文件：三档都是 SVG（不栅格化）
- [ ] 删除一张图：对应三档 + thumbhash 全部清理
- [ ] 替换一张图（replace_file）：三档 + thumbhash 全部重新生成

### 代码质量（Claude 审核时检查）
- [ ] 无 TypeScript `any`
- [ ] 颜色全部 CSS 变量
- [ ] 新 Rust commands 有错误处理
- [ ] ThumbHash 解码缓存不泄漏
- [ ] IntersectionObserver 单例模式保留
- [ ] 新增组件符合 DESIGN.md v2.8 规范
- [ ] 事件名称符合 CLAUDE.md 命名约定（snake_case）
- [ ] 所有新增 camelCase / snake_case 转换正确（Rust ↔ TS）

---

## 🔙 七、回滚方案

如果某个改动出问题，按以下优先级回滚：

1. **单文件回滚**：git checkout 某个文件到 main 分支
2. **禁用新逻辑**：通过 SQLite 偏好设置或 Rust Command 控制 feature flag，禁止使用 `localStorage`
3. **DB 回滚**：备份 DB 在 `.nocturne/backup_v{N}_{date}.db`，手动替换
4. **缩略图回滚**：删除 `_micro.webp` 和 `_preview.webp`，保留 `_thumb.jpg` 即可回退到 v5.7 行为

---

## 📝 八、实施顺序（建议）

Qwen Code 执行时按此顺序，每步完成后由 Claude 审核：

1. **Step 1（后端底层）**：文件 1-3（依赖 + Schema + thumbnail.rs 多档位函数）
2. **Step 2（后端集成）**：文件 4-6（scanner + commands + lib.rs 注册）
3. **Step 3（前端类型 + 工具）**：文件 7-8（types + thumbhash.ts）
4. **Step 4（前端渲染升级）**：文件 9-10（MediaCard + Canvas 双向 observer + 滚动跟踪）
5. **Step 5（前端大图升级）**：文件 11-12（DetailPanel + FullScreenPreview）
6. **Step 6（迁移 UI）**：文件 13-14（Banner + App.tsx 启动检测）
7. **Step 7（联调）**：完整流程测试，按验收清单跑一遍

每个 Step 完成后 Qwen Code 应：
- 自行编译 `cargo check` 和 `npm run build` 确保通过
- 提交一个带明确消息的 git commit（不要一次性全改完）
- 告知 Claude 审核

---

## 🎨 九、设计规范遵守

参考 `docs/DESIGN.md v2.8`：
- 所有颜色用 CSS 变量，禁止硬编码
- Banner 用 `color-mix(in srgb, var(--accent) 15%, transparent)` 背景
- 进度条填充色用 `var(--accent)`
- 过渡动画用 `transition: opacity 200ms ease` 或 `300ms` 对应 `--transition-standard`
- 字体 Manrope，字号跟随已有规范
- 圆角 `var(--radius-default)` = 8px

---

## 🚫 十、严禁事项

- ❌ 禁止修改原始图片文件（只读源文件）
- ❌ 禁止删除现有的 `thumbnail_path` 字段或相关代码路径（保持 fallback 链）
- ❌ 禁止用 base64 传图（继续用 `convertFileSrc` + Tauri 文件协议）
- ❌ 禁止在生成 Preview 档时阻塞导入流程
- ❌ 禁止将新 WebP 缩略图写入 AppData，必须写库根目录的 `.nocturne_meta/`
- ❌ 禁止 MediaCard 独立创建 IntersectionObserver（继续用 Canvas 单例）
- ❌ 禁止硬编码品牌色 `#F89184`
- ❌ 禁止用 `any` 类型
- ❌ 禁止遗漏 Rust Commands 在 lib.rs 的注册

---

## ✅ 十一、交付标准

Qwen Code 完成后提交给 Claude 审核时，需要：

1. **代码层面**
   - 所有改动分步 commit，每个 commit 消息清晰
   - 通过 `cargo check` 和 `npm run build`
   - 无 TypeScript / Rust 警告（或新增警告有合理解释）

2. **功能层面**
   - 手动跑一遍验收清单中至少 80% 的项目
   - 提供性能对比数据（旧版 vs 新版滚动帧率、内存占用）
   - 提供视觉对比截图（缩略图 vs 原图 100% 放大对照）

3. **文档层面**
   - 更新 `CLAUDE.md` 的「当前优化增强」表格和「已完成功能列表」
   - 新增的 Tauri Commands 在 CLAUDE.md 里简述一行

---

## 🔧 附录 A：依赖版本建议

```toml
# Cargo.toml
webp = "0.3"
thumbhash = "0.1"  # 如无则用: blurhash = "0.2"
```

```json
// package.json
"thumbhash": "^0.1.1"
// 或备选: "blurhash": "^2.0.5"
```

## 🔧 附录 B：关键常量汇总

```
# 缩略图尺寸
MICRO_SIZE = 256 px
STANDARD_SIZE = 800 px
PREVIEW_SIZE = 2048 px

# 质量
MICRO_QUALITY = 70
STANDARD_QUALITY = 80
PREVIEW_QUALITY = 85

# 视口窗口
VIEWPORT_BUFFER = 800 px（上下各加载这么多）
UNLOAD_THRESHOLD = 8 rows（离视口超出此距离卸载）

# 滚动速度阈值
FAST_SCROLL_SPEED = 1000 px/s
SCROLL_STOP_DEBOUNCE = 150 ms

# 重建任务
REBUILD_BATCH_SIZE = 5
REBUILD_BATCH_DELAY = 10 ms

# Original 缓存
ORIGINAL_CACHE_SIZE = 5 张
```

---

## 🔧 附录 C：事件命名总表

| 事件名 | payload | 触发时机 |
|---|---|---|
| `import_progress` | `{current, total, filename}` | 已有，保持不变 |
| `import_complete` | `{total}` | 已有，保持不变 |
| `thumbnail_rebuild_progress` | `{current, total, current_file}` | 新增，后台重建中 |
| `thumbnail_rebuild_complete` | `{total}` | 新增，后台重建完成 |
| `thumbnail_rebuild_error` | `{item_id, error}` | 新增，单条重建失败（不中止整体任务） |

---

**规范结束。开工！**
