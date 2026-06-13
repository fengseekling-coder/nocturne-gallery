# Gega Gallery 性能测试指南

## 测试环境准备

### 1. 导入一万张图片进行测试

```bash
# 确保你有足够的测试图片
# 可以使用脚本生成大量占位图片，或复制现有图片多次

# PowerShell 示例：复制图片创建测试集
$sourceFolder = "C:\path\to\your\images"
$targetFolder = "F:\Gega Gallery\nocturne-gallery\test-images"

# 创建目标文件夹
New-Item -ItemType Directory -Force -Path $targetFolder

# 复制图片（假设源文件夹有100张图，复制100次得到10000张）
for ($i = 1; $i -le 100; $i++) {
    Copy-Item "$sourceFolder\*" $targetFolder -Recurse -Force
    Write-Host "Batch $i completed"
}
```

### 2. 启动开发服务器

```bash
npm run tauri:dev
```


## 列表分页与缩略图策略（2026-06）

| 项 | 值 / 行为 |
|----|-----------|
| `MEDIA_PAGE_SIZE` | **400**（keyset 追加，避免一次加载 1500 条拖慢内存与 reconcile） |
| 网格默认档 | Retina（DPR≥2）优先 **Standard 800** WebP；否则 Micro |
| 网格升档 | 可见 **280ms** 后，且 **滚动停止约 180ms** 才升到 Standard/Preview |
| 并发解码 | 网格同时最多 **8** 路（`imageDecodeLimiter`） |
| 大图 | Preview → 原图，**120ms** 延迟 + `decode()` + 可 abort |

### 重建缩略图（旧库吃到新 Micro/Quality）

后端命令（Tauri `invoke`）：

- `regenerate_missing_micro` — 启动时 idle 补全缺失 Micro（不清已有档）
- `rebuild_missing_thumbnails` — 仅补缺失 micro（横幅「补全 Micro」）
- `regenerate_all_thumbnails` — **清空** `.nocturne_meta` 缩略图与 DB 路径后全库重生成（横幅「全量重建（新画质参数）」）

Dev 模式下缩略图队列需手动触发或走上述命令；Release 启动后会跑 micro backfill。


## 四大核心性能测试点

### 1. 滚动体感测试 🔄

**测试目标**: 确保滚动丝滑无掉帧 (60fps)

**测试步骤**:
1. 导入10,000张图片后，进入主界面
2. 快速上下滚动页面
3. 观察是否有卡顿、掉帧现象
4. 使用浏览器开发者工具 Performance 面板记录滚动过程

**预期结果**:
- FPS 保持在 55-60 之间
- 无明显卡顿或白屏
- 虚拟滚动正常工作（只渲染可见区域）

**监控方法**:
```javascript
// 在浏览器控制台运行
window.perfMonitor.start();
```

### 2. 框选拖动测试 🖱️

**测试目标**: Mouse 移动时不卡顿

**测试步骤**:
1. 在画布空白处按下鼠标左键开始框选
2. 快速拖动鼠标创建选择框
3. 观察选择框跟随鼠标的流畅度
4. 注意选中状态的实时更新是否流畅

**预期结果**:
- 选择框实时跟随鼠标移动
- 选中状态更新无明显延迟
- CPU 使用率不会激增

**性能指标**:
- 框选操作应在 16ms 内完成一帧 (<60fps)
- hitTest 函数执行时间 < 5ms

### 3. 任意点击选中测试 👆

**测试目标**: 点击卡片时无顿挫感

**测试步骤**:
1. 随机点击不同位置的图片卡片
2. 观察选中状态的即时反馈
3. 连续快速点击多个卡片
4. 测试 Ctrl/Cmd + 点击多选

**预期结果**:
- 点击后立即显示选中状态
- 无视觉延迟或卡顿
- 多选操作流畅

**优化要点**:
- MediaCard 组件窄选择器避免全局重渲染
- 选中状态直接通过 CSS 类切换，无动画过渡

### 4. 快速切换大分组测试 📁

**测试目标**: fetchFiles 翻页时不卡顿

**测试步骤**:
1. 快速点击不同的导航项（灵感库、AI提示词库等）
2. 在不同分组间快速切换
3. 观察数据加载和界面更新的流畅度
4. 检查是否有闪烁或空白状态

**预期结果**:
- 分组切换响应时间 < 500ms
- 无明显的 loading 状态闪烁
- 数据加载平滑过渡

**技术保障**:
- applyFilters 综合过滤，一次请求完成
- 请求令牌机制防止竞态条件
- 不清空 files 避免闪烁空状态

## 性能监控工具

### 内置性能监控器

```typescript
// 在浏览器控制台中使用
// 当前项目使用 Chrome DevTools 或 npm run perf:test 做性能检查。

monitor.start(); // 开始监控
monitor.generateReport(); // 生成即时报告
```

### 手动性能测试脚本

```javascript
// 测试滚动性能
function testScrollPerformance() {
  const canvas = document.querySelector('.canvas-content');
  const startTime = performance.now();
  
  // 模拟快速滚动
  let scrollPos = 0;
  const interval = setInterval(() => {
    scrollPos += 100;
    canvas.scrollTop = scrollPos;
    
    if (scrollPos >= canvas.scrollHeight - canvas.clientHeight) {
      clearInterval(interval);
      const endTime = performance.now();
      console.log(`Scroll test completed in ${(endTime - startTime).toFixed(2)}ms`);
    }
  }, 16); // ~60fps
}

// 测试选择性能
function testSelectionPerformance() {
  const cards = document.querySelectorAll('[data-card-id]');
  console.log(`Testing selection on ${cards.length} cards`);
  
  const startTime = performance.now();
  const selectedIds = [];
  
  cards.forEach(card => {
    const rect = card.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      selectedIds.push(card.getAttribute('data-card-id'));
    }
  });
  
  const endTime = performance.now();
  console.log(`Selection test: ${selectedIds.length} cards selected in ${(endTime - startTime).toFixed(2)}ms`);
}
```

## 性能优化清单

### ✅ 已实现的优化

- [x] 视口虚拟化 (Viewport Virtualization)
- [x] IntersectionObserver 批量更新
- [x] RAF 节流滚动状态更新
- [x] 二分查找优化虚拟范围计算
- [x] Masonry 布局增量更新
- [x] 媒体卡片窄选择器
- [x] 请求令牌防竞态
- [x] 综合过滤减少请求次数

### 🔧 可进一步优化

- [ ] Web Workers 处理复杂计算
- [x] 网格分级缩略图 + 滚动 idle 升档 + 解码并发上限
- [x] 列表 keyset 分页 400/页
- [ ] 数据库查询索引优化
- [ ] 内存缓存策略调整
- [ ] GPU 加速渲染

## 常见问题排查

### 滚动卡顿
1. 检查虚拟滚动是否正确工作
2. 确认 IntersectionObserver 根元素设置正确
3. 验证 overscan 区域大小合适

### 框选延迟
1. 检查 hitTest 函数执行时间
2. 确认 RAF 节流正常工作
3. 验证 DOM 查询效率

### 点击响应慢
1. 检查 React 组件重渲染次数
2. 确认窄选择器正确实现
3. 验证事件处理函数复杂度

### 分组切换闪烁
1. 检查 applyFilters 是否正确合并请求
2. 确认请求令牌机制工作正常
3. 验证状态更新顺序

## 基准性能指标

| 操作 | 目标性能 |  acceptable |
|------|----------|-------------|
| 滚动 FPS | ≥58 | ≥50 |
| 框选响应 | <16ms | <33ms |
| 点击选中 | <50ms | <100ms |
| 分组切换 | <500ms | <1000ms |
| 内存占用 | <500MB | <1GB |

## 持续改进

定期运行性能测试，记录关键指标变化：
- 每次重大更新后进行完整测试
- 建立性能回归检测机制
- 收集真实用户反馈

---

*最后更新: 2026-06-03*
