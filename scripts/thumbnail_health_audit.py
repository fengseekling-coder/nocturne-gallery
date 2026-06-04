"""只读缩略图健康度诊断脚本。

说明：
- 只执行只读诊断，不会修改数据库或文件。
- 只使用 SELECT 查询数据库。
- 只检查文件是否存在，不会生成、删除、移动任何缩略图文件。
- 输出中文报告，便于快速定位缩略图路径健康问题。
"""

from __future__ import annotations

import argparse
import configparser
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import unquote, urlparse


@dataclass(frozen=True)
class MediaRow:
    id: str
    filename: str
    filepath: str
    thumbnail_micro_path: Optional[str]
    thumbnail_path: Optional[str]
    thumbnail_preview_path: Optional[str]
    source_folder: Optional[str]
    is_trashed: int
    imported_at: int


@dataclass(frozen=True)
class BadPathSample:
    id: str
    filename: str
    bad_field: str
    path: str
    reason: str
    exists: bool
    source_folder: str


@dataclass(frozen=True)
class UrlMatchSample:
    url: str
    decoded_path: str
    matched_field: str
    media_id: str
    filename: str
    exists: bool


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def normalize_path_text(value: str) -> str:
    return value.strip().strip('"').strip("'")


def is_probably_windows_abs_path(path_text: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:[\\/].+", path_text))


def decode_asset_url_to_path(raw_url: str) -> str:
    text = raw_url.strip()
    if not text:
        return ""

    if text.startswith("asset.localhost"):
        text = "http://" + text

    if text.startswith("http://") or text.startswith("https://"):
        parsed = urlparse(text)
        path_part = parsed.path or ""
        path_part = unquote(path_part)

        # Tauri asset URL 常见形态：/C:/path/to/file 或 /_tauri/... 之类。
        # 这里优先剥掉前导斜杠，保留 Windows 盘符路径。
        if re.match(r"^/[A-Za-z]:[\\/].+", path_part):
            path_part = path_part[1:]
        elif path_part.startswith("/") and is_probably_windows_abs_path(path_part[1:]):
            path_part = path_part[1:]
        return normalize_path_text(path_part)

    return normalize_path_text(unquote(text))


def read_bad_url_file(path: Path) -> list[str]:
    urls: list[str] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            urls.append(line)
    return urls


def load_config_root(app_data_dir: Path) -> Optional[Path]:
    config_path = app_data_dir / ".nocturne" / "config.json"
    if not config_path.exists():
        return None
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    root_path = data.get("root_path")
    if not isinstance(root_path, str) or not root_path.strip():
        return None
    return Path(root_path.strip())


def default_app_data_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata)
    localappdata = os.environ.get("LOCALAPPDATA")
    if localappdata:
        return Path(localappdata)
    return Path.home()


def resolve_db_path(explicit_db: Optional[Path], explicit_root: Optional[Path]) -> tuple[Path, Path, str]:
    """返回 (db_path, root_dir, source_label)。"""
    if explicit_db is not None:
        db_path = explicit_db
        root_dir = explicit_root if explicit_root is not None else explicit_db.parent.parent
        return db_path, root_dir, "--db"

    app_data_dir = default_app_data_dir()
    if explicit_root is not None:
        candidate = explicit_root / ".nocturne" / "nocturne.db"
        if candidate.exists():
            return candidate, explicit_root, "--root"
        fallback = app_data_dir / "nocturne.db"
        return fallback, explicit_root, "--root(fallback)"

    config_root = load_config_root(app_data_dir)
    if config_root is not None:
        candidate = config_root / ".nocturne" / "nocturne.db"
        if candidate.exists():
            return candidate, config_root, "config.json"

    fallback = app_data_dir / "nocturne.db"
    return fallback, (config_root if config_root is not None else app_data_dir), "AppData fallback"


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def fetch_media_rows(conn: sqlite3.Connection) -> list[MediaRow]:
    rows = conn.execute(
        """
        SELECT
            id,
            filename,
            filepath,
            thumbnail_micro_path,
            thumbnail_path,
            thumbnail_preview_path,
            source_folder,
            is_trashed,
            imported_at
        FROM media_files
        """
    ).fetchall()

    result: list[MediaRow] = []
    for row in rows:
        result.append(
            MediaRow(
                id=str(row["id"]),
                filename=str(row["filename"]),
                filepath=str(row["filepath"]),
                thumbnail_micro_path=row["thumbnail_micro_path"],
                thumbnail_path=row["thumbnail_path"],
                thumbnail_preview_path=row["thumbnail_preview_path"],
                source_folder=row["source_folder"],
                is_trashed=int(row["is_trashed"]),
                imported_at=int(row["imported_at"]),
            )
        )
    return result


def is_empty(value: Optional[str]) -> bool:
    return value is None or not str(value).strip()


def is_in_meta(path_text: str) -> bool:
    return ".nocturne_meta" in path_text.replace("\\", "/")


def looks_like_old_naming(path_text: str, filename: str) -> bool:
    normalized = path_text.replace("\\", "/").lower()
    file_name = Path(filename).name
    stem = Path(filename).stem
    lower_file = file_name.lower()
    lower_stem = stem.lower()

    patterns = [
        f"{lower_stem}_thumb.jpg",
        f"{lower_stem}_thumb.jpeg",
        f"{lower_stem}_thumb.webp",
        f"{lower_stem}_micro.jpg",
        f"{lower_stem}_micro.jpeg",
        f"{lower_stem}_micro.webp",
        f"{lower_file}_thumb.jpg",
        f"{lower_file}_thumb.jpeg",
        f"{lower_file}_thumb.webp",
        f"{lower_file}_micro.jpg",
        f"{lower_file}_micro.jpeg",
        f"{lower_file}_micro.webp",
        f"{lower_stem}_preview.jpg",
        f"{lower_stem}_preview.webp",
    ]
    return any(pattern in normalized for pattern in patterns)


def path_exists(path_text: str) -> bool:
    try:
        return Path(path_text).exists()
    except OSError:
        return False


def bad_reason(path_text: str, filename: str, filepath: str) -> str:
    if not path_exists(path_text):
        return "文件不存在"
    if normalize_path_text(path_text) == normalize_path_text(filepath):
        return "误写为原图路径"
    if not is_in_meta(path_text):
        return "不在 .nocturne_meta 下"
    if looks_like_old_naming(path_text, filename):
        return "旧命名格式"
    return "未知异常"


def classify_media_row(row: MediaRow) -> dict[str, object]:
    fields = {
        "thumbnail_micro_path": row.thumbnail_micro_path,
        "thumbnail_path": row.thumbnail_path,
        "thumbnail_preview_path": row.thumbnail_preview_path,
    }
    field_exists = {name: (not is_empty(value) and path_exists(str(value))) for name, value in fields.items()}
    field_nonempty = {name: (not is_empty(value)) for name, value in fields.items()}

    all_empty = all(is_empty(value) for value in fields.values())
    all_nonempty_but_missing = (
        all(field_nonempty.values())
        and not any(field_exists.values())
    )
    original_miswrite = sum(1 for value in fields.values() if not is_empty(value) and normalize_path_text(str(value)) == normalize_path_text(row.filepath))
    outside_meta = sum(1 for value in fields.values() if not is_empty(value) and not is_in_meta(str(value)))
    old_naming = sum(1 for value in fields.values() if not is_empty(value) and looks_like_old_naming(str(value), row.filename))

    return {
        "all_empty": all_empty,
        "all_nonempty_but_missing": all_nonempty_but_missing,
        "original_miswrite": original_miswrite,
        "outside_meta": outside_meta,
        "old_naming": old_naming,
        "field_exists": field_exists,
        "field_nonempty": field_nonempty,
    }


def count_ratio(part: int, total: int) -> str:
    if total <= 0:
        return "0.00%"
    return f"{(100.0 * part / total):.2f}%"


def print_general_summary(rows: list[MediaRow]) -> dict[str, int]:
    total = len(rows)
    micro_missing = 0
    standard_missing = 0
    preview_missing = 0
    all_three_empty = 0
    all_three_nonempty_but_missing = 0
    original_miswrite = 0
    outside_meta = 0
    old_naming = 0

    for row in rows:
        micro_missing += 1 if is_empty(row.thumbnail_micro_path) else 0
        standard_missing += 1 if is_empty(row.thumbnail_path) else 0
        preview_missing += 1 if is_empty(row.thumbnail_preview_path) else 0

        info = classify_media_row(row)
        all_three_empty += 1 if info["all_empty"] else 0
        all_three_nonempty_but_missing += 1 if info["all_nonempty_but_missing"] else 0
        original_miswrite += int(info["original_miswrite"])
        outside_meta += int(info["outside_meta"])
        old_naming += int(info["old_naming"])

    print("=" * 80)
    print("缩略图健康度全库统计")
    print("=" * 80)
    print(f"总素材数: {total}")
    print(f"thumbnail_micro_path 空值: {micro_missing} ({count_ratio(micro_missing, total)})")
    print(f"thumbnail_path 空值: {standard_missing} ({count_ratio(standard_missing, total)})")
    print(f"thumbnail_preview_path 空值: {preview_missing} ({count_ratio(preview_missing, total)})")
    print(f"三档都为空: {all_three_empty} ({count_ratio(all_three_empty, total)})")
    print(f"三档非空但文件不存在: {all_three_nonempty_but_missing} ({count_ratio(all_three_nonempty_but_missing, total)})")
    print(f"三档等于原图 filepath: {original_miswrite}")
    print(f"三档不在 .nocturne_meta 下: {outside_meta}")
    print(f"旧命名格式数量: {old_naming}")
    print()

    return {
        "total": total,
        "micro_missing": micro_missing,
        "standard_missing": standard_missing,
        "preview_missing": preview_missing,
        "all_three_empty": all_three_empty,
        "all_three_nonempty_but_missing": all_three_nonempty_but_missing,
        "original_miswrite": original_miswrite,
        "outside_meta": outside_meta,
        "old_naming": old_naming,
    }


def sample_rows_by_folder(rows: list[MediaRow], folder: str, limit: int = 50) -> list[MediaRow]:
    filtered = [row for row in rows if row.is_trashed == 0 and (row.source_folder or "") == folder]
    filtered.sort(key=lambda r: (-r.imported_at, r.id), reverse=False)
    return sorted(filtered, key=lambda r: (-r.imported_at, r.id))[:limit]


def print_folder_summary(rows: list[MediaRow], folder: str) -> None:
    sample = sample_rows_by_folder(rows, folder, 50)
    micro_missing = 0
    micro_not_exists = 0
    standard_not_exists = 0
    preview_not_exists = 0
    original_miswrite = 0
    outside_meta = 0
    old_naming = 0

    for row in sample:
        if is_empty(row.thumbnail_micro_path):
            micro_missing += 1
        elif not path_exists(str(row.thumbnail_micro_path)):
            micro_not_exists += 1
        if not is_empty(row.thumbnail_path) and not path_exists(str(row.thumbnail_path)):
            standard_not_exists += 1
        if not is_empty(row.thumbnail_preview_path) and not path_exists(str(row.thumbnail_preview_path)):
            preview_not_exists += 1

        info = classify_media_row(row)
        original_miswrite += int(info["original_miswrite"])
        outside_meta += int(info["outside_meta"])
        old_naming += int(info["old_naming"])

    print("=" * 80)
    print(f"导航抽样：{folder}")
    print("=" * 80)
    print(f"抽样数量: {len(sample)}")
    print(f"micro 为空: {micro_missing}")
    print(f"micro 不存在: {micro_not_exists}")
    print(f"standard 不存在: {standard_not_exists}")
    print(f"preview 不存在: {preview_not_exists}")
    print(f"原图误写: {original_miswrite}")
    print(f".nocturne_meta 外路径: {outside_meta}")
    print(f"旧命名混用: {old_naming}")
    print()


def build_bad_path_samples(rows: list[MediaRow], limit: int = 20) -> list[BadPathSample]:
    samples: list[BadPathSample] = []
    seen: set[tuple[str, str]] = set()

    for row in rows:
        fields = [
            ("thumbnail_micro_path", row.thumbnail_micro_path),
            ("thumbnail_path", row.thumbnail_path),
            ("thumbnail_preview_path", row.thumbnail_preview_path),
        ]
        for field_name, value in fields:
            if is_empty(value):
                continue
            path_text = normalize_path_text(str(value))
            exists = path_exists(path_text)
            if exists and normalize_path_text(path_text) != normalize_path_text(row.filepath) and is_in_meta(path_text):
                continue
            reason = bad_reason(path_text, row.filename, row.filepath)
            key = (row.id, field_name)
            if key in seen:
                continue
            seen.add(key)
            samples.append(
                BadPathSample(
                    id=row.id,
                    filename=row.filename,
                    bad_field=field_name,
                    path=path_text,
                    reason=reason,
                    exists=exists,
                    source_folder=row.source_folder or "",
                )
            )
            if len(samples) >= limit:
                return samples

    return samples


def match_bad_urls(conn: sqlite3.Connection, urls: list[str]) -> tuple[Counter[str], list[UrlMatchSample]]:
    counts: Counter[str] = Counter()
    samples: list[UrlMatchSample] = []

    for raw in urls:
        decoded_path = decode_asset_url_to_path(raw)
        if not decoded_path:
            counts["查不到"] += 1
            continue

        row = conn.execute(
            """
            SELECT id, filename, filepath, thumbnail_micro_path, thumbnail_path, thumbnail_preview_path
            FROM media_files
            WHERE filepath = ?
               OR thumbnail_micro_path = ?
               OR thumbnail_path = ?
               OR thumbnail_preview_path = ?
            LIMIT 1
            """,
            (decoded_path, decoded_path, decoded_path, decoded_path),
        ).fetchone()

        if row is None:
            counts["查不到"] += 1
            continue

        matched_field = "查不到"
        if row["thumbnail_micro_path"] == decoded_path:
            matched_field = "thumbnail_micro_path"
        elif row["thumbnail_path"] == decoded_path:
            matched_field = "thumbnail_path"
        elif row["thumbnail_preview_path"] == decoded_path:
            matched_field = "thumbnail_preview_path"
        elif row["filepath"] == decoded_path:
            matched_field = "filepath"

        counts[matched_field] += 1
        samples.append(
            UrlMatchSample(
                url=raw,
                decoded_path=decoded_path,
                matched_field=matched_field,
                media_id=str(row["id"]),
                filename=str(row["filename"]),
                exists=path_exists(decoded_path),
            )
        )

    return counts, samples


def print_url_section(conn: sqlite3.Connection, bad_urls: list[str]) -> None:
    if not bad_urls:
        return

    counts, samples = match_bad_urls(conn, bad_urls)
    print("=" * 80)
    print("404 URL 反查")
    print("=" * 80)
    print(f"总 URL 数: {len(bad_urls)}")
    print(f"匹配 thumbnail_micro_path: {counts['thumbnail_micro_path']}")
    print(f"匹配 thumbnail_path: {counts['thumbnail_path']}")
    print(f"匹配 thumbnail_preview_path: {counts['thumbnail_preview_path']}")
    print(f"匹配 filepath: {counts['filepath']}")
    print(f"查不到: {counts['查不到']}")
    print()

    if samples:
        print("样本：")
        for item in samples[:10]:
            print(f"- matched_field={item.matched_field} exists={item.exists} id={item.media_id} filename={item.filename}")
            print(f"  url={item.url}")
            print(f"  path={item.decoded_path}")
        print()


def print_bad_samples(samples: list[BadPathSample]) -> None:
    print("=" * 80)
    print("Top 20 坏路径样本")
    print("=" * 80)
    if not samples:
        print("未发现明显坏路径样本。")
        print()
        return

    for sample in samples:
        print(f"- id={sample.id}")
        print(f"  filename={sample.filename}")
        print(f"  bad_field={sample.bad_field}")
        print(f"  path={sample.path}")
        print(f"  reason={sample.reason}")
        print(f"  exists={sample.exists}")
        print(f"  source_folder={sample.source_folder}")
    print()


def final_judgement(summary: dict[str, int], rows: list[MediaRow]) -> tuple[str, bool, str]:
    total = summary["total"]
    if total == 0:
        return "库中没有素材，无法判断缩略图健康度。", False, "空值"

    micro_missing_pct = summary["micro_missing"] / total
    all_empty_pct = summary["all_three_empty"] / total
    nonempty_missing_pct = summary["all_three_nonempty_but_missing"] / total

    if summary["original_miswrite"] > 0:
        reason = "原图误写"
        root = "原图误写"
        p0 = True
        text = "检测到缩略图字段疑似指向原图路径，优先修复路径写入或回写逻辑。"
        return text, p0, root

    if summary["old_naming"] > 0:
        reason = "旧命名"
        root = "旧命名"
        p0 = True
        text = "检测到明显旧命名格式混用，旧库/迁移后的路径不一致很可能是主要原因。"
        return text, p0, root

    if nonempty_missing_pct >= 0.2:
        reason = "失效路径"
        root = "失效路径"
        p0 = True
        text = "大量非空缩略图路径实际文件不存在，属于高优先级路径失效问题。"
        return text, p0, root

    if all_empty_pct >= 0.2 or micro_missing_pct >= 0.35:
        reason = "空值"
        root = "空值"
        p0 = True
        text = "首屏相关缩略图空值较多，优先补全 micro / standard 路径可显著改善亮图速度。"
        return text, p0, root

    if summary["outside_meta"] > summary["total"] * 0.1:
        reason = "失效路径"
        root = "失效路径"
        p0 = True
        text = "存在较多不在 .nocturne_meta 下的路径，建议优先核查路径来源与迁移兼容性。"
        return text, p0, root

    # 无法从静态数据直接证明 IO 竞争，但如果路径总体健康，首屏慢更可能是并发抢占。
    if summary["micro_missing"] < total * 0.15 and nonempty_missing_pct < 0.05:
        reason = "IO 竞争"
        root = "IO 竞争"
        p0 = False
        text = "路径整体较健康，但首屏仍慢时，更可能是后台补缩略图与首屏读取发生 IO 竞争。"
        return text, p0, root

    return "缩略图路径存在中度异常，建议先做首屏抽样修复再决定是否扩大修复范围。", True, "失效路径"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="只读缩略图健康度诊断脚本")
    parser.add_argument("--db", type=str, default=None, help="显式数据库路径")
    parser.add_argument("--root", type=str, default=None, help="显式库根目录")
    parser.add_argument("--bad-url-file", type=str, default=None, help="asset.localhost 404 URL 列表文件")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    explicit_db = Path(args.db).expanduser() if args.db else None
    explicit_root = Path(args.root).expanduser() if args.root else None
    bad_url_file = Path(args.bad_url_file).expanduser() if args.bad_url_file else None

    db_path, root_dir, source_label = resolve_db_path(explicit_db, explicit_root)

    print("=" * 80)
    print("只读缩略图健康度诊断")
    print("=" * 80)
    print("说明：只执行 SELECT 和文件存在性检查，不会修改数据库或文件。")
    print(f"数据库来源: {source_label}")
    print(f"推断库根目录: {root_dir}")
    print(f"数据库路径: {db_path}")
    print(f"数据库存在: {db_path.exists()}")
    print()

    if not db_path.exists():
        print("未找到数据库，诊断无法继续。请使用 --db 或 --root 指定正确路径。")
        return 2

    try:
        conn = connect_db(db_path)
    except sqlite3.Error as exc:
        print(f"打开数据库失败: {exc}")
        return 2

    try:
        rows = fetch_media_rows(conn)
    except sqlite3.Error as exc:
        print(f"读取 media_files 失败: {exc}")
        return 2

    summary = print_general_summary(rows)
    print_folder_summary(rows, "灵感库")
    print_folder_summary(rows, "AI 提示词库")
    print_folder_summary(rows, "作品集")

    if bad_url_file is not None:
        if bad_url_file.exists():
            bad_urls = read_bad_url_file(bad_url_file)
            print_url_section(conn, bad_urls)
        else:
            print("=" * 80)
            print("404 URL 反查")
            print("=" * 80)
            print(f"未找到 URL 文件: {bad_url_file}")
            print()

    bad_samples = build_bad_path_samples(rows, limit=20)
    print_bad_samples(bad_samples)

    judgement, p0, root_cause = final_judgement(summary, rows)
    print("=" * 80)
    print("最终判断")
    print("=" * 80)
    print(f"最可能根因: {judgement}")
    print(f"是否建议 P0 修复: {'是' if p0 else '否'}")
    print(f"优先修: {root_cause}")
    print()

    print("建议 Claude 重点检查：")
    print("1. 首屏前 50 条素材的 thumbnail_micro_path / thumbnail_path / thumbnail_preview_path 是否为空或不存在。")
    print("2. 是否存在旧命名混用（stem/filename、jpg/webp 混合）。")
    print("3. 404 URL 是否大量命中 thumbnail_micro_path。")
    print("4. 是否有缩略图字段误写到 filepath 原图。")
    print("5. 若路径整体健康，再看是否存在后台 IO 竞争。")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
