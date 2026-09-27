#!/usr/bin/env python3
"""Fetch article bodies for cafe posts linked in data/hikes.csv.

Saves data/cafe_bodies/<fldid>_<dataid>.json with extracted text and image
count (resumable: existing files are skipped), then merged summary stats.
Usage: python3 scripts/crawl_bodies.py
"""
import csv
import html as ihtml
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "cafe_bodies"
DELAY_S = 0.4
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def fetch(url):
    r = subprocess.run(
        ["curl", "-s", "--max-time", "30", "-A", UA, url],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"curl failed: {r.returncode}")
    return r.stdout


def extract_body(raw):
    i = raw.find('<div id="article"')
    if i < 0:
        return None
    j = raw.find('<div class="view_detail">', i)
    seg = raw[i:j] if j > i else raw[i:]
    imgs = len(re.findall(r"<img\b", seg))
    txt = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", seg)
    # 문단 구분 보존: 블록 태그를 개행으로 바꾼 뒤 태그 제거
    txt = re.sub(r"(?i)<(?:br|/p|/div|/h\d|/li|/tr|/table)[^>]*>", "\n", txt)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = ihtml.unescape(txt)
    lines = [re.sub(r"[ \t\u00a0]+", " ", l).strip() for l in txt.split("\n")]
    txt = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    txt = re.sub(r"\n?다음검색$", "", txt).strip()
    return {"text": txt, "text_len": len(txt.replace("\n", "")), "img_count": imgs}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = {}
    with open(ROOT / "data" / "hikes.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            url = (row.get("cafe_url") or "").strip()
            m = re.match(r"https://cafe\.daum\.net/woosengzlsamo/(\w+)/(\w+)", url)
            if m:
                targets[(m.group(1), m.group(2))] = url

    print(f"unique posts to fetch: {len(targets)}")
    n_ok = n_skip = n_err = 0
    for (fldid, dataid), url in sorted(targets.items()):
        out = OUT_DIR / f"{fldid}_{dataid}.json"
        if out.exists():
            n_skip += 1
            continue
        murl = f"https://m.cafe.daum.net/woosengzlsamo/{fldid}/{dataid}"
        try:
            body = extract_body(fetch(murl))
        except Exception as e:
            print(f"! {fldid}/{dataid}: {e}", file=sys.stderr)
            n_err += 1
            time.sleep(DELAY_S)
            continue
        if body is None:
            print(f"! {fldid}/{dataid}: no article div", file=sys.stderr)
            n_err += 1
            time.sleep(DELAY_S)
            continue
        body.update({"fldid": fldid, "dataid": dataid, "url": url})
        out.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        n_ok += 1
        if n_ok % 50 == 0:
            print(f"  ... {n_ok} fetched")
        time.sleep(DELAY_S)

    print(f"fetched: {n_ok}, skipped(existing): {n_skip}, errors: {n_err}")


if __name__ == "__main__":
    main()
