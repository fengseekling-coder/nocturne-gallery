#!/usr/bin/env bash
# 修复库迁到 ~/gega 后 DB 仍指向 ~/Documents 导致缩略图/原图无法加载。
# 使用前请完全退出 Gega Gallery。

set -euo pipefail

DB="/Users/azhuilab/gega/.nocturne/nocturne.db"
OLD="/Users/azhuilab/Documents"
NEW="/Users/azhuilab/gega"

if [[ ! -f "$DB" ]]; then
  echo "找不到数据库: $DB"
  exit 1
fi

echo "==> 退出 Gega 后再继续"
sleep 1

for col in filepath thumbnail_path thumbnail_micro_path thumbnail_preview_path; do
  n=$(sqlite3 "$DB" "SELECT COUNT(*) FROM media_files WHERE $col LIKE '${OLD}%';")
  echo "$col 仍含 Documents 前缀: $n 条"
  if [[ "$n" -gt 0 ]]; then
    sqlite3 "$DB" "UPDATE media_files SET $col = REPLACE($col, '$OLD', '$NEW') WHERE $col LIKE '${OLD}%';"
  fi
  # macOS：误写成反斜杠会导致缩略图加载失败
  sqlite3 "$DB" "UPDATE media_files SET $col = REPLACE($col, char(92), '/') WHERE instr($col, char(92)) > 0;"
done

echo ""
echo "修复后抽样:"
sqlite3 "$DB" "SELECT filepath FROM media_files LIMIT 1;"
sqlite3 "$DB" "SELECT thumbnail_micro_path FROM media_files WHERE thumbnail_micro_path IS NOT NULL LIMIT 1;"
echo ""
echo "完成。请重新打开 Gega。"