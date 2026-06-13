# 灵感库文件夹：`NocturneGallery` → `GegaGallery`

## 行为

| 场景 | 结果 |
|------|------|
| 新用户选择父目录（如 `~/Documents`） | 创建 **`…/GegaGallery`** 并初始化子目录与 `.nocturne` |
| 已有 **`…/NocturneGallery`** 且为有效库 | 启动或 `init_library` 时 **重命名为 `GegaGallery`**，并更新 `config.json` |
| 用户直接选择 **`…/GegaGallery`** 或旧库根路径 | 若末级为 `NocturneGallery` 则先迁移；已是有效库根则沿用 |
| 数据库中的文件路径 | `update_library_root_prefixes` 将路径中的 **`NocturneGallery`** 前缀替换为当前库根（含 **`GegaGallery`**） |

## 历史路径兼容

代码中仍保留少量 Windows 反斜杠路径替换 SQL，用于修复旧版数据库里已经写入的 `\媒体库\`、`\项目文件\` 等历史记录。这些分支只在迁移时处理旧数据，不代表运行时依赖 Windows 盘符、Windows 用户目录或反斜杠路径。

## 未改名（刻意保留）

- 库内数据目录 **`.nocturne/`** 与 **`nocturne.db`** 文件名（避免破坏现有 DB 与配置路径逻辑）
- AppData 下的 **`.nocturne/config.json`** 路径

## 手动迁移

若自动重命名失败（例如目标 `GegaGallery` 已存在且不是有效库），请手动：

1. 关闭应用  
2. 将 `NocturneGallery` 重命名为 `GegaGallery`（或合并内容后只保留一个有效库根）  
3. 确认库根下存在 `.nocturne/`  
4. 重新打开应用
