"""滚动性能验证脚本 - 基于数据库和文件系统

由于 Tauri 应用需要原生环境，此脚本通过以下方式验证性能：
1. 检查数据库中 micro 缩略图的补全进度
2. 验证文件系统中实际存在的缩略图数量
3. 分析后端日志中的性能指标
4. 提供优化建议
"""

import argparse
import sqlite3
import os
import sys
import json
from pathlib import Path
from datetime import datetime


def resolve_paths() -> tuple[Path, Path]:
    parser = argparse.ArgumentParser(description="验证素材库滚动性能相关的缩略图状态")
    parser.add_argument("--root", type=Path, help="素材库根目录")
    parser.add_argument("--db", type=Path, help="nocturne.db 的完整路径")
    args = parser.parse_args()

    if args.db is not None:
        db_path = args.db
        root_dir = args.root if args.root is not None else db_path.parent.parent
        return root_dir, db_path

    root_value = args.root or os.environ.get("GEGA_LIBRARY_ROOT") or os.environ.get("NOCTURNE_LIBRARY_ROOT")
    root_dir = Path(root_value) if root_value else Path.cwd()
    return root_dir, root_dir / ".nocturne" / "nocturne.db"

def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn

def check_micro_progress(conn: sqlite3.Connection) -> dict:
    """检查 micro 缩略图的补全进度"""
    print("\n" + "=" * 80)
    print("📊 Micro 缩略图补全进度检查")
    print("=" * 80)

    # 总素材数
    total = conn.execute("SELECT COUNT(*) as count FROM media_files WHERE is_trashed = 0").fetchone()["count"]

    # 已有 micro 的素材数
    with_micro = conn.execute(
        "SELECT COUNT(*) as count FROM media_files WHERE is_trashed = 0 AND thumbnail_micro_path IS NOT NULL AND thumbnail_micro_path != ''"
    ).fetchone()["count"]

    # 空值数量
    missing = total - with_micro

    # 百分比
    progress_pct = (with_micro / total * 100) if total > 0 else 0

    print(f"\n总素材数（未删除）: {total}")
    print(f"已有 micro 缩略图: {with_micro} ({progress_pct:.1f}%)")
    print(f"缺失 micro 缩略图: {missing} ({100 - progress_pct:.1f}%)")

    # 按分组统计
    print("\n【按分组统计】")
    groups = conn.execute("""
        SELECT
            source_folder,
            COUNT(*) as total,
            SUM(CASE WHEN thumbnail_micro_path IS NOT NULL AND thumbnail_micro_path != '' THEN 1 ELSE 0 END) as with_micro
        FROM media_files
        WHERE is_trashed = 0
        GROUP BY source_folder
    """).fetchall()

    for group in groups:
        folder = group["source_folder"] or "未分类"
        g_total = group["total"]
        g_with = group["with_micro"]
        g_pct = (g_with / g_total * 100) if g_total > 0 else 0
        print(f"  {folder}: {g_with}/{g_total} ({g_pct:.1f}%)")

    return {
        "total": total,
        "with_micro": with_micro,
        "missing": missing,
        "progress_pct": progress_pct,
    }

def check_filesystem_thumbnails(root_dir: Path) -> dict:
    """检查文件系统中实际存在的缩略图"""
    print("\n" + "=" * 80)
    print("📁 文件系统缩略图检查")
    print("=" * 80)

    meta_dirs = list(root_dir.rglob(".nocturne_meta"))

    if not meta_dirs:
        print(f"\n⚠️  未在 {root_dir} 下找到 .nocturne_meta 目录")
        return {"main_count": 0, "micro_count": 0, "thumbhash_count": 0}

    main_count = 0
    micro_count = 0
    thumbhash_count = 0

    for meta_dir in meta_dirs:
        if not meta_dir.is_dir():
            continue

        for file in meta_dir.iterdir():
            if not file.is_file():
                continue
            name = file.name.lower()
            if "_micro.webp" in name:
                micro_count += 1
            elif "_thumbhash" in name or ".thumbhash" in name:
                thumbhash_count += 1
            elif file.suffix.lower() in ['.jpg', '.jpeg', '.webp', '.png']:
                # 排除 micro 和 preview
                if "_micro" not in name and "_preview" not in name:
                    main_count += 1

    print(f"\n主缩略图 (_thumb.jpg/webp): {main_count}")
    print(f"Micro 缩略图 (_micro.webp): {micro_count}")
    print(f"ThumbHash 文件: {thumbhash_count}")

    return {
        "main_count": main_count,
        "micro_count": micro_count,
        "thumbhash_count": thumbhash_count,
    }

def analyze_backend_logs(log_output: str) -> dict:
    """分析后端日志中的性能指标"""
    print("\n" + "=" * 80)
    print("📝 后端日志分析")
    print("=" * 80)

    metrics = {
        "regenerate_progress": None,
        "scan_completed": False,
        "warnings": [],
    }

    # 查找 regenerate_missing_micro 进度
    for line in log_output.split('\n'):
        if 'regenerate_missing_micro' in line and 'progress' in line:
            try:
                # 提取 processed/updated 等信息
                if 'processed=' in line:
                    parts = line.split()
                    for part in parts:
                        if part.startswith('processed='):
                            metrics['regenerate_progress'] = int(part.split('=')[1])
            except:
                pass

        if '[scanner]' in line and 'Phase' in line and 'complete' in line:
            metrics['scan_completed'] = True

        if 'WARN' in line or 'error' in line.lower():
            metrics['warnings'].append(line.strip())

    if metrics['regenerate_progress']:
        print(f"\n✅ Micro 补全进度: {metrics['regenerate_progress']} 个文件已处理")
    else:
        print(f"\n⚠️  未检测到 micro 补全进度日志")

    if metrics['scan_completed']:
        print(f"✅ 扫描已完成")
    else:
        print(f"⏳ 扫描可能仍在进行中")

    if metrics['warnings']:
        print(f"\n⚠️  警告/错误 ({len(metrics['warnings'])} 条):")
        for w in metrics['warnings'][:5]:  # 只显示前 5 条
            print(f"  {w}")

    return metrics

def generate_recommendations(micro_stats: dict, fs_stats: dict, log_metrics: dict) -> list:
    """生成优化建议"""
    print("\n" + "=" * 80)
    print("💡 优化建议")
    print("=" * 80)

    recommendations = []

    # 1. Micro 补全进度
    if micro_stats['progress_pct'] < 50:
        recommendations.append({
            "priority": "P0",
            "issue": f"Micro 缩略图补全进度较低 ({micro_stats['progress_pct']:.1f}%)",
            "action": "等待后台补全完成，或检查 LIGHT_ENRICH_SEMAPHORE 配置是否合理",
        })
    elif micro_stats['progress_pct'] < 90:
        recommendations.append({
            "priority": "P1",
            "issue": f"Micro 缩略图补全进行中 ({micro_stats['progress_pct']:.1f}%)",
            "action": "继续等待补全完成，预计剩余时间取决于文件大小和 CPU 性能",
        })
    else:
        recommendations.append({
            "priority": "✅",
            "issue": f"Micro 缩略图补全基本完成 ({micro_stats['progress_pct']:.1f}%)",
            "action": "无需额外操作",
        })

    # 2. 文件系统一致性
    db_micro = micro_stats['with_micro']
    fs_micro = fs_stats['micro_count']
    if abs(db_micro - fs_micro) > db_micro * 0.1:
        recommendations.append({
            "priority": "P1",
            "issue": f"数据库与文件系统不一致 (DB: {db_micro}, FS: {fs_micro})",
            "action": "运行数据库清理或重新扫描以同步状态",
        })
    else:
        recommendations.append({
            "priority": "✅",
            "issue": "数据库与文件系统一致",
            "action": "无需额外操作",
        })

    # 3. 扫描状态
    if not log_metrics['scan_completed']:
        recommendations.append({
            "priority": "P2",
            "issue": "初始扫描可能未完成",
            "action": "等待扫描完成后再进行大规模滚动测试",
        })

    # 打印建议
    for i, rec in enumerate(recommendations, 1):
        print(f"\n{i}. [{rec['priority']}] {rec['issue']}")
        print(f"   → {rec['action']}")

    return recommendations

def main():
    root_dir, db_path = resolve_paths()

    print("=" * 80)
    print("🚀 Gega Gallery 滚动性能验证")
    print("=" * 80)
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    if not db_path.exists():
        print(f"\n❌ 数据库不存在: {db_path}")
        print("请使用 --root /path/to/library 或 --db /path/to/nocturne.db")
        sys.exit(1)

    print(f"\n数据库路径: {db_path}")
    print(f"库根目录: {root_dir}")

    # 1. 连接数据库
    try:
        conn = connect_db(db_path)
    except Exception as e:
        print(f"\n❌ 数据库连接失败: {e}")
        sys.exit(1)

    # 2. 检查 micro 进度
    micro_stats = check_micro_progress(conn)

    # 3. 检查文件系统
    fs_stats = check_filesystem_thumbnails(root_dir)

    # 4. 分析后端日志（从标准输入读取）
    print("\n" + "=" * 80)
    print("📋 请粘贴后端日志内容（Ctrl+D 结束，或直接回车跳过）:")
    print("=" * 80)
    try:
        log_lines = []
        for line in sys.stdin:
            log_lines.append(line)
        log_output = ''.join(log_lines)
    except EOFError:
        log_output = ""

    if log_output:
        log_metrics = analyze_backend_logs(log_output)
    else:
        print("\n⏭️  跳过日志分析")
        log_metrics = {"regenerate_progress": None, "scan_completed": False, "warnings": []}

    # 5. 生成建议
    recommendations = generate_recommendations(micro_stats, fs_stats, log_metrics)

    # 6. 汇总报告
    print("\n" + "=" * 80)
    print("📈 性能验证汇总")
    print("=" * 80)

    print(f"\n【数据库状态】")
    print(f"  总素材: {micro_stats['total']}")
    print(f"  Micro 补全: {micro_stats['with_micro']} ({micro_stats['progress_pct']:.1f}%)")

    print(f"\n【文件系统状态】")
    print(f"  主缩略图: {fs_stats['main_count']}")
    print(f"  Micro 缩略图: {fs_stats['micro_count']}")
    print(f"  ThumbHash: {fs_stats['thumbhash_count']}")

    print(f"\n【后端状态】")
    print(f"  扫描完成: {'是' if log_metrics['scan_completed'] else '否/未知'}")
    print(f"  警告数量: {len(log_metrics['warnings'])}")

    # 综合评估
    issue_count = sum(1 for r in recommendations if r['priority'].startswith('P'))
    if issue_count == 0:
        print(f"\n✅ 综合评估: 优秀 - 无明显性能问题")
    elif issue_count <= 2:
        print(f"\n⚠️  综合评估: 良好 - 存在 {issue_count} 个待优化项")
    else:
        print(f"\n❌ 综合评估: 较差 - 存在 {issue_count} 个严重问题")

    conn.close()

    # 保存报告
    report = {
        "timestamp": datetime.now().isoformat(),
        "micro_stats": micro_stats,
        "fs_stats": fs_stats,
        "log_metrics": {k: v for k, v in log_metrics.items() if k != 'warnings'},
        "recommendations": recommendations,
        "issue_count": issue_count,
    }

    report_path = Path(__file__).parent.parent / "test-results" / "performance-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n💾 详细报告已保存: {report_path}")

if __name__ == "__main__":
    main()
