#!/usr/bin/env python3
"""Crawl post lists from the Daum cafe (woosengzlsamo) mobile API.

Writes data/cafe/<fldid>.json per board and merged data/cafe_posts.json.
Usage: python3 scripts/crawl_cafe.py
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "cafe"
GRPID = "1Gz7G"
CAFE = "woosengzlsamo"
API = "https://m.cafe.daum.net/api/v1/common-articles"
DELAY_S = 0.3
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

BOARDS = {
    "8I5j": "산행앨범",
    "F7WI": "기록실",
    "FPOx": "종주기-백두대간",
    "FPOz": "종주기-낙동정맥",
    "FPP1": "종주기-금남호남",
    "FPP2": "종주기-호남정맥",
    "FPP3": "종주기-금남정맥",
    "FPP6": "종주기-한남금북",
    "FPP7": "종주기-금북정맥",
    "FPP8": "종주기-한남정맥",
    "FPP9": "종주기-낙남정간",
    "FPPA": "종주기-한북정맥",
    "F8rx": "산맥걷기(1+9)현황",
    "FPOy": "낙동정맥-완주",
    "F8Og": "금남호남정맥-완주",
    "F8Oh": "호남정맥-완주",
    "F8Ol": "금남정맥-완주",
    "F9V0": "한남금북정맥-완주",
    "F9V1": "금북정맥-완주",
    "F9Uz": "한남정맥-완주",
    "F9V2": "낙남정간-완주",
    "F9Uy": "한북정맥-완주",
    "FRz6": "1+9 이후",
    "FSZF": "53",
    "FOOU": "대구 걷기 여행길",
    "FQbX": "청룡지맥",
    "FOOT": "팔공산 올레길",
    "FOOW": "팔공산 힐링길",
    "FOOS": "팔공산 왕건길",
    "FOP7": "팔공산 둘레길",
    "FOOX": "비슬산 둘레길",
    "FOP8": "대구 둘레길",
    "FUsg": "대구둘레길 2차",
    "FSdQ": "코리아둘레길",
    "FSdR": "해파랑길",
    "FTSV": "지리산 둘레길",
    "FVOW": "속리산둘레길",
    "FUqQ": "남파랑길",
    "DbwX": "트랙자료실",
    "AKLc": "지도 자료실",
    "Eqpt": "19종주대방",
}


def api_get(fldid, page, cursor):
    url = f"{API}?grpid={GRPID}&fldid={fldid}&targetPage={page}&pageSize=20"
    if cursor:
        url += f"&afterBbsDepth={cursor}"
    r = subprocess.run(
        ["curl", "-s", "--max-time", "20", "-A", UA, url],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"curl failed: {r.returncode}")
    return json.loads(r.stdout)


def parse_date(elapsed):
    m = re.match(r"^(\d{2})\.(\d{2})\.(\d{2})$", (elapsed or "").strip())
    if m:
        return f"20{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None  # relative time like "3시간 전" — resolve later if needed


def crawl_board(fldid, name):
    posts, seen = [], set()
    page, cursor = 1, None
    while True:
        try:
            data = api_get(fldid, page, cursor)
        except Exception as e:
            print(f"  ! {fldid} p{page}: {e}", file=sys.stderr)
            break
        arts = data.get("articles") or []
        new = [a for a in arts if a["dataid"] not in seen]
        if not new:
            break
        for a in new:
            seen.add(a["dataid"])
            posts.append({
                "board_id": fldid,
                "board": name,
                "dataid": a["dataid"],
                "title": (a.get("title") or "").strip(),
                "date": parse_date(a.get("articleElapsedTime")),
                "date_raw": a.get("articleElapsedTime"),
                "is_notice": bool(a.get("isNotice")),
                "comments": a.get("commentCount"),
                "views": a.get("viewCount"),
                "url": f"https://cafe.daum.net/{CAFE}/{fldid}/{a['dataid']}",
            })
        next_page = data.get("nextPage")
        cursor = arts[-1].get("bbsDepth")
        if not next_page or not cursor or len(arts) < 20:
            break
        page = next_page
        time.sleep(DELAY_S)
    return posts


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    merged = []
    for fldid, name in BOARDS.items():
        posts = crawl_board(fldid, name)
        with open(OUT_DIR / f"{fldid}.json", "w", encoding="utf-8") as f:
            json.dump(posts, f, ensure_ascii=False, indent=1)
        merged.extend(posts)
        print(f"{name} ({fldid}): {len(posts)} posts")
        time.sleep(DELAY_S)
    with open(ROOT / "data" / "cafe_posts.json", "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=1)
    print(f"\ntotal: {len(merged)} posts -> data/cafe_posts.json")


if __name__ == "__main__":
    main()
