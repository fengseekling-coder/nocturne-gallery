# Gega Gallery Design System

> Version 5.6
> Updated: 2026-04-29

本设计文档描述当前已经落地的视觉与交互标准。若源码实现与旧文档冲突，以本文件为准。

---

## 1. Creative Direction

Gega Gallery 不是“数据库味”的素材工具，而是偏编辑感、策展感的本地素材画廊。

关键词：

- 深色沉浸
- 极简结构
- 高密度内容
- 清晰层级
- 少而准的荧光绿强调

---

## 2. Layout Architecture

### 2.1 三栏布局

```text
┌──────────┬────────────────────────┬──────────────┐
│ Sidebar  │        Canvas          │  Inspector   │
│ 192px    │        flex-1          │  256px       │
│ 固定     │        自适应          │  240~600px   │
└──────────┴────────────────────────┴──────────────┘
```

### 2.2 顶部对齐

以下区域必须严格 `48px` 高：

- Sidebar Logo 区
- Canvas Topbar
- Inspector Topbar

并统一使用 `border-bottom: 1px solid var(--border)`。

### 2.3 Sidebar 结构

Sidebar 必须拆分为：

1. 顶部主导航固定区
2. 中部自定义分组滚动区
3. 底部设置固定区

自定义分组再多，也不能挤压主导航按钮高度。

---

## 3. Tokens

```css
--bg-primary: #0D0D0D;
--bg-surface: #111111;
--bg-card: #161616;
--bg-hover: rgba(255,255,255,0.04);
--bg-active: rgba(255,255,255,0.07);

--accent: #90FF21;
--accent-dim: rgba(144,255,33,0.1);
--accent-border: rgba(144,255,33,0.15);
--text-on-accent: #0A0A0A;

--text-primary: rgba(255,255,255,0.85);
--text-secondary: rgba(255,255,255,0.45);
--text-muted: rgba(255,255,255,0.25);

--border: rgba(255,255,255,0.05);
--border-hover: rgba(255,255,255,0.09);

--error: #F44336;
--success: #22C55E;

--radius-default: 8px;
--radius-small: 8px;
--radius-pill: 9999px;
--radius-card: 8px;
--radius-media-card: 10px;
```

禁止硬编码颜色值。

---

## 4. Topbar Rules

### 4.1 搜索框

- 高度：`32px`
- 宽度：`260px`
- 圆角：`24px`
- 字号：`13px`
- 背景：`rgba(255,255,255,0.04)`
- 边框：`1px solid rgba(255,255,255,0.06)`
- 搜索图标必须位于输入框内部左侧

### 4.2 缩放滑条

- 轨道：`72px x 3px`
- 滑块：`10px x 10px`
- 必须设置 `WebkitAppRegion: no-drag`

### 4.3 Inspector 顶栏

- 高度：`48px`
- 左侧为 section 标题
- 右侧为 Windows 风格窗口控制按钮

### 4.4 Canvas 顶部工具栏

Canvas 顶部工具栏在所有主导航页面常显，包括灵感库、AI 提示词库、作品集管理、网页管理、回收站。

- 高度固定 `48px`
- 必须使用 `border-bottom: 1px solid var(--border)`
- 左侧显示当前大分组名称与数量徽章
- 中间搜索框常显，并根据当前页面搜索对应内容
- 图片 / 视频等内置筛选仅在当前页面存在多个内置筛选项时显示
- 网格列数与视图密度控制保持常显，网页管理卡片也跟随列数设置

---

## 5. Sidebar Rules

### 5.1 主导航

主导航是大分组：

- 灵感库
- AI 提示词库
- 作品集管理
- 网页管理
- 回收站

点击大分组时，显示该大分组下的全部素材。

### 5.2 自定义分组

自定义分组属于当前大分组的子分组。

点击自定义分组时：

- 只显示该分组素材
- 不显示其他自定义分组素材
- 主导航按钮不再保持高亮

### 5.3 视觉状态

Sidebar 必须是单选视觉状态：

- 主导航与自定义分组不能同时高亮
- 只能有一个当前分组入口处于激活态

### 5.4 底部外观入口

Sidebar 底部只保留「外观调整」与「设置」两个固定入口。

- 主题模式（深色 / 浅色）、品牌主色、背景明度、网格列数、卡片元信息统一放在「外观调整」浮层内
- 禁止在 Sidebar 底部再拆出独立的浅色 / 深色模式切换按钮

---

## 6. Canvas & Media Card

### 6.1 Masonry

- 列间距：`8px`
- 卡片圆角：`8px`
- 卡片之间尽量高密度排布

### 6.2 媒体卡片

媒体卡片当前规范：

- 纯内容导向
- 圆角使用 `--radius-media-card`，当前为 `10px`
- 顶部右上角不再显示收藏图标
- 顶部右上角不保留不可见的选择 / 收藏按钮
- 允许 hover 阴影与轻微上浮
- 允许底部文件名与尺寸渐隐信息条
- 选中态使用荧光绿描边
- 选中切换不做动画缓动，直接切换

### 6.3 选中态

- `outline: 1.5px solid var(--accent)`
- `box-shadow: 0 0 0 1.5px var(--accent)`
- 不使用选中动画

### 6.4 滚动加载

- 滚动中允许新卡片先显示低清层
- 已进入清晰层的卡片不能在滚动时再次降回低清层
- 目标是避免翻页闪屏、闪烁、黑块

---

## 7. Inspector Rules

### 7.1 基础结构

- 默认宽度：`256px`
- 可拖拽范围：`240px ~ 600px`
- 常驻显示，不折叠
- 内容区滚动

### 7.2 Prompt 区

当前 Prompt 区规范：

- 默认可直接编辑
- “查看完整”不是弹窗
- 点击“查看完整”后，在 Inspector 内直接展开文本区域高度
- 长内容通过 Inspector 自身滚动查看

### 7.3 预览联动

以下入口必须统一选中态与详情态：

- 点击卡片
- 双击查看大图
- 右键“查看大图”
- 大图预览内翻页

任何入口都不能导致 Inspector 空白。

---

## 8. Preview Rules

### 8.1 查看大图

大图预览是沉浸式模式，但右侧 Inspector 仍然保留并展示当前素材信息。

### 8.2 翻页

- 左右切图时，预览图与 Inspector 内容必须同步
- 禁止出现“预览图已切换，但 Inspector 还空白/停留上一张”

---

## 9. Toast / Modal System

### 9.1 普通提示

内容区普通反馈统一为：

- 胶囊形
- 位于内容区容器底部居中
- 不压住 Sidebar / Inspector

适用：

- 复制成功
- 导入状态
- 一般成功/失败提示

### 9.2 决策型弹窗

以下场景使用居中弹窗，不使用底部胶囊：

- 删除确认
- 重复素材确认
- 其他需要用户明确选择分支的操作

### 9.3 导入提示

“开始导入 / 导入中 / 导入完成”统一在一个导入提示组件中完成，不拆成多个独立 toast。

---

## 10. Duplicate Import UX

重复素材导入弹窗必须满足：

- 居中显示
- 明确说明这是重复素材
- 显示已有素材所在大分组 / 小分组
- 显示当前导入目标分组
- 提供清晰操作：
  - 继续导入
  - 使用已有素材

---

## 11. Drag & Drop UX

### 11.1 拖入应用

支持：

- 本地文件拖入
- 本地文件夹拖入并递归导入
- 网页素材拖入

要求：

- 必须有即时反馈
- 不能出现“拖进去没反应”
- 导入进度与结果必须可见
- 拖入自定义分组时，导入链路必须传递目标小分组并写入 `category_id`
- `Sidebar` 的小分组 drop target 必须暴露大分组目录与 `data-drop-target-category`，原生文件拖入和应用内素材拖入都要落到同一小分组
- 批量拖入后的哈希、解码、缩略图扫描必须按本批次文件并行处理，不能回退为逐文件串行扫描

### 11.2 从应用拖出

支持：

- 单个素材拖出
- 多个已选素材一起拖出

目标：

- 可拖到本地文件夹
- 可拖到支持拖拽接收的网站或软件

如果对方不接受，是对方行为；我们只负责输出正确拖拽数据。

---

## 12. Motion

- 普通 transition：`150ms ease`
- 页面切换：`opacity 0 → 1`，`200ms`
- Modal：`scale(0.96) + opacity 0 → scale(1) + opacity 1`，`150ms`
- `prefers-reduced-motion` 必须有降级

补充：

- 选中态不做动画
- 反馈要快于“炫技”

---

## 13. Do / Don’t

### Do

- 用层级和间距组织信息
- 用少量荧光绿作为强调
- 保持 Canvas 高密度、Sidebar 清晰、Inspector 稳定
- 把普通反馈统一到底部胶囊
- 把决策操作统一到居中弹窗

### Don’t

- 不要恢复卡片右上角收藏图标
- 不要把查看完整 Prompt 做成弹窗
- 不要让大分组和小分组同时高亮
- 不要让小分组展示其他分组内容
- 不要让右键查看大图时 Inspector 空白
- 不要在滚动中频繁切换图片层级导致闪烁

---

## 14. Current Component Notes

| 组件 | 路径 | 当前设计重点 |
|------|------|-------------|
| Sidebar | `src/components/sidebar/Sidebar.tsx` | 三段结构、主导航固定、分组独立滚动 |
| Canvas | `src/components/canvas/Canvas.tsx` | Masonry、导入拖拽、预览联动 |
| MediaCard | `src/components/canvas/MediaCard.tsx` | 纯内容卡片、无收藏图标、支持多拖出 |
| DetailPanel | `src/components/detail/DetailPanel.tsx` | Prompt 直接编辑、面板内展开 |
| Icon | `src/components/common/Icon.tsx` | Gega SVG 图标系统，替代 Material Symbols |
| Toast | `src/components/common/Toast.tsx` | 内容区底部居中胶囊 |
| ImportProgressBar | `src/components/common/ImportProgressBar.tsx` | 单一导入状态提示 |
| DuplicateModal | `src/components/common/DuplicateModal.tsx` | 居中重复素材确认 |

---

## 15. Final Principle

Gega Gallery 的界面不是“功能堆叠”，而是“低噪音、高密度、稳定反馈”的本地策展工具。
所有新增设计都必须围绕这三个目标展开：

- 看得清
- 反应快
- 不打断

---

## 16. 2026-04-29 Design System Import Notes

本轮已吸收 `C:\Users\Administrator\Downloads\Nocturne Gallery Design System*.zip` 与同目录 `README.md` / `colors_and_type.css` 中可生产化的规则。

落地原则：

- 以当前 Tauri + React + TypeScript 生产代码为准，不直接复制 UI kit 的 `.jsx` 原型代码
- 保留已落地的 Prompt 可编辑、Inspector 附件区、预览联动、重复素材弹窗等生产能力
- 将 UI kit 中的视觉语言合并为 token：`--radius-media-card`、tag 色板、浮层 chip、Toast 背景、overlay gradient、字体尺寸与 tracking token
- 将 UI kit 中的 `icons.jsx` 生产化为 `src/components/common/Icon.tsx`，并移除 Material Symbols 字体依赖
- 默认布局回归规范：Sidebar `192px`，Inspector 默认 `256px`，可拖拽范围仍为 `240px ~ 600px`
- 普通反馈继续限制在内容区底部居中，不覆盖 Sidebar / Inspector
- 决策型操作继续使用居中 Modal，不退化为底部胶囊提示
