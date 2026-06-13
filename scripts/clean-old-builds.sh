#!/usr/bin/env bash
# 删除旧编译缓存、多余 AppData 库副本、项目里无用目录。
# 不会删除 ~/gega 里的素材，不会删 config.json。
# 使用前请完全退出 Gega Gallery（⌘Q）。

set -euo pipefail

ROOT="/Users/azhuilab/Nocturne Gallery/nocturne-gallery"
APP_SUPPORT="$HOME/Library/Application Support/com.gega.gallery"

echo "==> 请确认 Gega 已退出"
sleep 1

# 1) AppData 里过期的空库 DB（真实库在 ~/gega/.nocturne/nocturne.db）
if [[ -f "$APP_SUPPORT/nocturne.db" ]]; then
  echo "删除 AppData 冗余 nocturne.db"
  rm -f "$APP_SUPPORT/nocturne.db"
fi

# 2) Rust 编译缓存（约 7GB+，下次 dev/build 会重新编译）
if [[ -d "$ROOT/src-tauri/target" ]]; then
  echo "cargo clean …"
  (cd "$ROOT/src-tauri" && cargo clean)
fi

# 3) 前端 dist（npm run build / tauri 会再生）
if [[ -d "$ROOT/dist" ]]; then
  echo "删除 dist/"
  rm -rf "$ROOT/dist"
fi

# 4) 仓库根下误放的截图目录（与工程无关）
if [[ -d "/Users/azhuilab/Nocturne Gallery/tu" ]]; then
  echo "删除 Nocturne Gallery/tu/"
  rm -rf "/Users/azhuilab/Nocturne Gallery/tu"
fi

echo ""
echo "保留："
echo "  $APP_SUPPORT/.nocturne/config.json  → root_path 仍指向 gega"
echo "  ~/gega/  灵感库与 nocturne.db"
echo ""
echo "重新运行： cd \"$ROOT\" && npm run tauri:dev"