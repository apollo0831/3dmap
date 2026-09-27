#!/usr/bin/env python3
"""Publish crawled cafe bodies (data/cafe_bodies/) to web/data/reports/.

Usage: python3 scripts/build_reports.py  (run after crawl_bodies.py)
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "cafe_bodies"
DST = ROOT / "web" / "data" / "reports"


def main():
    DST.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in sorted(SRC.glob("*.json")):
        b = json.loads(f.read_text(encoding="utf-8"))
        out = {"text": b["text"], "text_len": b["text_len"], "img_count": b["img_count"]}
        (DST / f.name).write_text(
            json.dumps(out, ensure_ascii=False), encoding="utf-8"
        )
        n += 1
    print(f"wrote {n} reports -> {DST}")


if __name__ == "__main__":
    main()
