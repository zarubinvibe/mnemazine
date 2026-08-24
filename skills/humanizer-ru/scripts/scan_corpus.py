#!/usr/bin/env python3
"""Батч-драйвер сканера: JSONL {path, score, band, hard_ban_count} по всем .md
корпуса. Переиспользует humanizer_metrics (analyze + cleanliness_score) — своего
измерителя канцелярита не строит (запрет ДОПОЛНЕНИЯ-1). Один процесс на весь
корпус вместо N спавнов scan.py.

    python skills/humanizer-ru/scripts/scan_corpus.py <vault-dir>
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from humanizer_metrics import analyze, cleanliness_score

SKIP_DIR_MARK = "graphify-out"
# Длинное тире сквозное в корпусе (даты/заголовки), считаем его отдельно от
# настоящего слопа — иначе 78% нот «грязные» только из-за типографики.
EM_DASH_BAN = "Длинное тире"


def iter_md(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        # graphify-каталоги (и их бэкапы/снапшоты) — не знание
        dirnames[:] = [d for d in dirnames if SKIP_DIR_MARK not in d]
        for name in filenames:
            if name.endswith(".md"):
                yield os.path.join(dirpath, name)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: scan_corpus.py <vault-dir>", file=sys.stderr)
        return 2
    root = sys.argv[1]
    if not os.path.isdir(root):
        print(f"not a directory: {root}", file=sys.stderr)
        return 2
    for md in iter_md(root):
        try:
            text = Path(md).read_text(encoding="utf-8")
        except Exception as err:  # нечитаемый файл — не роняем весь прогон
            print(json.dumps({"path": md, "error": str(err)[:120]}, ensure_ascii=False))
            continue
        rep = analyze(text)
        sc = cleanliness_score(rep)
        slop = sum(h.count for h in rep.hard_bans if h.marker != EM_DASH_BAN)
        print(json.dumps(
            {"path": md, "score": sc.score, "band": sc.band,
             "hard_ban_count": rep.hard_ban_count, "slop_ban_count": slop},
            ensure_ascii=False,
        ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
