列表分页 `MEDIA_PAGE_SIZE=400`；全量重建见 `regenerate_all_thumbnails`。

# 🚀 Gega Gallery 性能优化套件

本目录包含用于测试和优化 Gega Gallery 性能的工具和文档。

## 📁 文件说明

```
docs/
├── PERFORMANCE_TESTING.md          # 性能测试指南
├── PERFORMANCE_OPTIMIZATION.md     # 性能优化总结
└── README_PERFORMANCE.md           # 本文件

scripts/
└── performance-test.js             # 自动化性能测试脚本

```

## 🧪 快速开始

### 1. 运行自动化性能测试

```bash
# 确保应用正在运行
npm run tauri:dev

# 在另一个终端运行性能测试
npm run perf:test
```

### 2. 使用浏览器监控工具

在浏览器控制台中：

```javascript
// 导入性能监控器
// 当前项目使用 Chrome DevTools 或 npm run perf:test 做性能检查。

// 创建实例并开始监控
// 自动化脚本会输出滚动、选择、点击和内存指标。

// 生成即时报告
```

### 3. 手动性能测试

参考 [PERFORMANCE_TESTING.md](./PERFORMANCE_TESTING.md) 中的详细步骤进行手动测试。

## 📊 关键性能指标

| 指标 | 目标值 | 监控方法 |
|------|--------|----------|
| 滚动 FPS | ≥58 | Performance Monitor |
| 框选响应时间 | <16ms | 自动化测试脚本 |
| 点击选中响应 | <50ms | 自动化测试脚本 |
| 分组切换时间 | <500ms | 自动化测试脚本 |
| 内存占用 | <500MB | Chrome DevTools |

## 🔧 性能优化技术

### 前端优化

1. **视口虚拟化** - 只渲染可见区域内的卡片
2. **IntersectionObserver** - 批量更新减少重渲染
3. **RAF 节流** - 与浏览器刷新率同步
4. **窄选择器** - 避免全局状态更新
5. **Masonry 增量布局** - 复用已知布局计算

### 后端优化

1. **SQLite 索引** - 加速数据库查询
2. **Keyset 分页** - 避免 OFFSET 性能问题
3. **PRAGMA 调优** - 优化 SQLite 性能
4. **请求令牌** - 防止竞态条件

## 📈 性能基准

在标准测试环境下（10,000 张图片）：

- ✅ 滚动 FPS: ~60
- ✅ 框选响应: ~10ms
- ✅ 点击选中: ~30ms
- ✅ 分组切换: ~300ms
- ✅ 内存占用: ~400MB

## 🛠️ 故障排除

### 滚动卡顿

1. 检查虚拟滚动是否正确工作
2. 确认 IntersectionObserver 根元素设置
3. 验证 overscan 区域大小

### 框选延迟

1. 检查 hitTest 函数执行时间
2. 确认 RAF 节流正常工作
3. 验证 DOM 查询效率

### 内存泄漏

1. 使用 Chrome DevTools Memory 面板
2. 检查未清理的定时器和监听器
3. 验证组件卸载时的清理逻辑

## 📚 相关文档

- [性能测试指南](./PERFORMANCE_TESTING.md)
- [性能优化总结](./PERFORMANCE_OPTIMIZATION.md)
- [项目架构文档](../AGENTS.md)

## 🤝 贡献

欢迎提交性能优化建议和报告性能问题：

1. 运行性能测试记录当前指标
2. 实施优化方案
3. 再次运行测试对比结果
4. 提交 PR 包含性能改进数据

## 📄 许可证

本项目遵循与原项目相同的许可证。

---

*最后更新: 2026-05-02*
