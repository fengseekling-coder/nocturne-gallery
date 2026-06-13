#!/usr/bin/env python3
"""One-off: replace product name Nocturne Gallery -> Gega Gallery in docs/agent files."""
import os

root = os.path.join(os.path.dirname(__file__), "..")
skip_dirs = {"node_modules", "dist", "target", ".git", ".audit"}
replacements = [
    ("Nocturne Gallery", "Gega Gallery"),
    ("问 Nocturne ", "问 Gega Gallery "),
    ("Nocturne Demo Library", "Gega Gallery Demo Library"),
]
exts = {".md", ".yml", ".yaml", ".html", ".css", ".sh", ".tsx", ".ts", ".rs"}

for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in skip_dirs]
    for fn in filenames:
        if os.path.splitext(fn)[1] not in exts:
            continue
        if fn == "Gega Gallery - standalone.html":
            continue
        p = os.path.join(dirpath, fn)
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                t = f.read()
        except OSError:
            continue
        orig = t
        for a, b in replacements:
            t = t.replace(a, b)
        if t != orig:
            with open(p, "w", encoding="utf-8") as f:
                f.write(t)
            print("updated:", os.path.relpath(p, root))

outer = os.path.normpath(os.path.join(root, "..", "README.md"))
if os.path.isfile(outer):
    with open(outer, encoding="utf-8") as f:
        t = f.read()
    t2 = t.replace("Nocturne Gallery", "Gega Gallery")
    if t2 != t:
        with open(outer, "w", encoding="utf-8") as f:
            f.write(t2)
        print("updated: ../README.md")