#!/usr/bin/env bash
# 将灵感库从 ~/Documents 剪切到 ~/gega，并清空 Documents 中的库数据。
# 使用前请先完全退出 Gega Gallery。

set -euo pipefail

FROM="/Users/azhuilab/Documents"
TO="/Users/azhuilab/gega"
CONFIG="$HOME/Library/Application Support/com.gega.gallery/.nocturne/config.json"
NAMES=(.nocturne 灵感库 作品集 回收站 渲染队列 媒体库 项目文件)

echo "==> 请先确认 Gega Gallery 已完全退出"
sleep 1

mkdir -p "$TO"

for name in "${NAMES[@]}"; do
  src="$FROM/$name"
  dst="$TO/$name"
  if [[ ! -e "$src" ]]; then
    continue
  fi
  echo "MOVE: $src -> $dst"
  if [[ -e "$dst" ]]; then
    rm -rf "$dst"
  fi
  mv "$src" "$dst"
done

mkdir -p "$(dirname "$CONFIG")"
cat > "$CONFIG" <<'JSON'
{
  "root_path": "/Users/azhuilab/gega",
  "version": "1.0"
}
JSON

DB="$TO/.nocturne/nocturne.db"
if [[ -f "$DB" ]]; then
  echo "==> 更新数据库路径前缀 Documents -> gega"
  sqlite3 "$DB" "UPDATE media_files SET filepath = REPLACE(filepath, '/Users/azhuilab/Documents', '/Users/azhuilab/gega') WHERE filepath LIKE '/Users/azhuilab/Documents%';"
  sqlite3 "$DB" "UPDATE media_files SET thumbnail_path = REPLACE(thumbnail_path, '/Users/azhuilab/Documents', '/Users/azhuilab/gega') WHERE thumbnail_path LIKE '/Users/azhuilab/Documents%';"
  sqlite3 "$DB" "UPDATE media_files SET thumbnail_micro_path = REPLACE(thumbnail_micro_path, '/Users/azhuilab/Documents', '/Users/azhuilab/gega') WHERE thumbnail_micro_path LIKE '/Users/azhuilab/Documents%';"
  sqlite3 "$DB" "UPDATE media_files SET thumbnail_preview_path = REPLACE(thumbnail_preview_path, '/Users/azhuilab/Documents', '/Users/azhuilab/gega') WHERE thumbnail_preview_path LIKE '/Users/azhuilab/Documents%';"
  echo "media_files 条数: $(sqlite3 "$DB" 'SELECT COUNT(*) FROM media_files;')"
fi

echo ""
echo "完成。新库根: $TO"
echo "Documents 中库目录应已移除（Adobe、Codex 等未动）。"
ls -la "$TO"
echo "灵感库文件数: $(ls -1 "$TO/灵感库" 2>/dev/null | wc -l | tr -d ' ')"