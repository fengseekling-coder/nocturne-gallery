#!/usr/bin/env bash
# 在本机终端执行（Cursor 内置终端若杀不掉 1420 端口，请用系统「终端.app」）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if lsof -ti :1420 >/dev/null 2>&1; then
  echo "==> 释放 1420 端口（旧 Vite / tauri dev）..."
  lsof -ti :1420 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "==> 启动 Gega Gallery 桌面开发（npm run tauri:dev）..."
echo "    请等待独立窗口出现，不要用浏览器打开 localhost:1420"
exec npm run tauri:dev