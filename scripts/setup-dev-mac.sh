#!/usr/bin/env bash
# Nocturne Gallery — 新 Mac 开发环境检查与项目依赖安装
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Nocturne Gallery 环境检查"
echo "    项目目录: $ROOT"
echo ""

missing=0

check_cmd() {
  local name="$1"
  local hint="$2"
  if command -v "$name" >/dev/null 2>&1; then
    echo "  [OK] $name — $($name --version 2>/dev/null | head -1 || echo 'found')"
  else
    echo "  [缺失] $name — $hint"
    missing=$((missing + 1))
  fi
}

check_cmd node "请安装 Node.js LTS: brew install node 或 https://nodejs.org"
check_cmd npm "随 Node 安装"
check_cmd rustc "请安装 Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
check_cmd cargo "随 rustup 安装"

if command -v ffmpeg >/dev/null 2>&1; then
  echo "  [OK] ffmpeg — $(ffmpeg -version 2>/dev/null | head -1)"
else
  echo "  [可选] ffmpeg — 视频缩略图需要: brew install ffmpeg"
fi

if xcode-select -p >/dev/null 2>&1; then
  echo "  [OK] Xcode Command Line Tools"
else
  echo "  [建议] 运行: xcode-select --install"
fi

echo ""
if [ "$missing" -gt 0 ]; then
  echo "请先安装上述缺失项，然后重新运行本脚本。"
  echo "详细说明: docs/00-安装指南.md"
  exit 1
fi

echo "==> npm install"
npm install

echo ""
echo "==> 完成。启动开发版:"
echo "    npm run tauri:dev"
echo ""
echo "Cursor 扩展: 打开本项目后安装 .vscode/extensions.json 中的推荐扩展。"
