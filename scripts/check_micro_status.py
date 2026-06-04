import argparse
import os
import sqlite3
from pathlib import Path


def resolve_db_path() -> Path:
    parser = argparse.ArgumentParser(description="检查 micro 缩略图补全进度")
    parser.add_argument("--db", type=Path, help="nocturne.db 的完整路径")
    parser.add_argument("--root", type=Path, help="素材库根目录，脚本会读取 .nocturne/nocturne.db")
    args = parser.parse_args()

    if args.db is not None:
        return args.db

    root_value = args.root or os.environ.get("GEGA_LIBRARY_ROOT") or os.environ.get("NOCTURNE_LIBRARY_ROOT")
    if root_value:
        return Path(root_value) / ".nocturne" / "nocturne.db"

    return Path.cwd() / ".nocturne" / "nocturne.db"


db_path = resolve_db_path()
if not db_path.exists():
    raise SystemExit(f"Database not found: {db_path}\nUse --root /path/to/library or --db /path/to/nocturne.db")

conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row

total = conn.execute("SELECT COUNT(*) as count FROM media_files WHERE is_trashed = 0").fetchone()["count"]
with_micro = conn.execute("SELECT COUNT(*) as count FROM media_files WHERE is_trashed = 0 AND thumbnail_micro_path IS NOT NULL AND thumbnail_micro_path != ''").fetchone()["count"]
missing = total - with_micro
progress_pct = (with_micro / total * 100) if total > 0 else 0

print(f"Total files (not trashed): {total}")
print(f"With micro thumbnails: {with_micro} ({progress_pct:.1f}%)")
print(f"Missing micro: {missing} ({100 - progress_pct:.1f}%)")

conn.close()
