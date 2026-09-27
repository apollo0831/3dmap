#!/usr/bin/env python3
"""Match GPX hikes (web/data/index.json) to cafe posts (data/cafe_posts.json).

Signals: date proximity (post is written on/after the hike), title token
overlap, and trail affinity between the GPX source folder and the cafe board
(e.g. 2호남정맥/ <-> 호남정맥-완주).

Outputs:
  data/hikes.csv        auto-accepted matches (pipeline metadata, file=source path)
  data/match_review.csv ambiguous/weak candidates for manual review
Usage: python3 scripts/match_posts.py
"""
import csv
import json
import re
import unicodedata
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 산행일 대비 산행기 작성일 허용 범위 (아버지는 보통 며칠 내에 올림).
# 산행 전에 쓴 글은 그 산행의 기록일 수 없으므로 제외.
DATE_MIN, DATE_MAX = 0, 21

# (패턴, 정규 트레일명). 긴 패턴을 먼저 검사하고 잡힌 자리는 마스킹해서
# '금남호남'이 '금남'/'호남'으로도 잡히는 오염을 막는다. 금남정맥과
# 금남호남정맥은 서로 다른 트레일이므로 부분 포함 매칭은 금물.
TRAIL_PATTERNS = [
    ("금남호남", "금남호남"), ("금호남", "금남호남"),
    ("한남금북", "한남금북"), ("한금", "한남금북"),
    ("백두대간", "백두대간"), ("백두", "백두대간"), ("대간", "백두대간"),
    ("지리산둘레", "지리산둘레"), ("지둘", "지리산둘레"),
    ("속리산둘레", "속리산둘레"), ("속둘", "속리산둘레"),
    ("비슬산둘레", "비슬산둘레"), ("대구둘레", "대구둘레"),
    ("팔공산", "팔공산"), ("해파랑", "해파랑"), ("남파랑", "남파랑"),
    ("낙동", "낙동"), ("호남", "호남"), ("금북", "금북"), ("낙남", "낙남"),
    ("한남", "한남"), ("한북", "한북"), ("금남", "금남"),
    ("청룡", "청룡"), ("왕건", "왕건"),
]

# 개별 산행기가 아닌 현황/자료 게시판 — 모든 산행에 걸리기 쉬우므로 감점
META_BOARDS = {
    "코리아둘레길", "산맥걷기(1+9)현황", "1+9 이후", "기록실",
    "트랙자료실", "지도 자료실", "19종주대방", "대구 걷기 여행길",
}


def norm(s):
    s = unicodedata.normalize("NFC", s or "")
    return re.sub(r"[\s~〜\-_.()<>＜＞,\[\]/]+", "", s.lower())


def to_date(s):
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s or "")
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def trail_keys(text):
    t = norm(text)
    found = set()
    for pat, canon in TRAIL_PATTERNS:
        if pat in t:
            found.add(canon)
            t = t.replace(pat, "§")
    return found


def name_tokens(mountain):
    toks = re.split(r"[\s~〜\-_.,()\[\]/]+", mountain or "")
    # 숫자만 있는 토큰(타임스탬프 이름)은 검색 가치가 없다
    return [t for t in toks if len(t) >= 2 and not t.isdigit()]


def trail_nums(text):
    """차수/구간 번호 추출 (1~99). '백두 34차' -> {34}, '남파랑 28-29' -> {28, 29}."""
    return {int(n) for n in re.findall(r"(?<!\d)(\d{1,2})(?!\d)", text or "")}


def score(hike, hkeys, hnums, post):
    hd, pd = to_date(hike.get("date")), to_date(post.get("date"))
    date_s = None
    if hd and pd:
        dd = (pd - hd).days
        if DATE_MIN <= dd <= DATE_MAX:
            # 가까운 뒷글일수록 높게 — 동점을 없애 주간 에세이도 가장 가까운 글에 붙는다
            if dd <= 3:
                date_s = 3.0 - 0.35 * dd
            elif dd <= 7:
                date_s = 1.5
            elif dd <= 14:
                date_s = 0.8
            else:
                date_s = 0.4

    pkeys = trail_keys(post["board"]) | trail_keys(post["title"])
    # 정맥/대간 차수 매칭: 종주기는 산행 후 한참 뒤에 쓰기도 하고, 트랙을
    # 나중에 다시 만든 경우 GPX 날짜가 실제 산행일과 다르므로 날짜 무관 허용
    num_match = bool(hkeys & pkeys) and bool(hnums & trail_nums(post["title"]))
    if date_s is None and not num_match:
        return 0.0

    s = (date_s or 0.0) + (4.0 if num_match else 0.0)
    ptitle = norm(post["title"])
    toks = name_tokens(hike["mountain"])
    s += 2.0 * sum(1 for t in toks if norm(t) in ptitle)
    nm = norm(hike["mountain"])
    if nm and not nm.isdigit() and nm in ptitle:
        s += 3.0
    if hkeys and pkeys:
        s += 2.0 if hkeys & pkeys else -2.0
    if post["board"] in META_BOARDS:
        s -= 3.0
    # 산행기가 아닌 운영성 게시글
    if any(w in post["title"] for w in ("수입지출", "결산", "회비", "공지", "명단", "일정표", "계획서")):
        s -= 3.0
    return s


def main():
    hikes = json.loads((ROOT / "web" / "data" / "index.json").read_text(encoding="utf-8"))["hikes"]
    posts = json.loads((ROOT / "data" / "cafe_posts.json").read_text(encoding="utf-8"))
    posts = [p for p in posts if not p.get("is_notice") and to_date(p.get("date"))]

    rows, review = [], []
    n_auto = n_amb = n_none = 0
    for h in hikes:
        hkeys = trail_keys(h.get("source", "")) | trail_keys(h["mountain"])
        # 시각(09:55:56) 형태 이름에서 나온 숫자는 차수가 아니다
        m = h["mountain"]
        hnums = set()
        if hkeys and not re.search(r"\d{1,2}:\d{2}", m) and not m.replace(":", "").isdigit():
            hnums = trail_nums(m)
        cands = sorted(
            ((score(h, hkeys, hnums, p), p) for p in posts), key=lambda x: -x[0]
        )
        cands = [c for c in cands if c[0] > 0][:5]
        best = cands[0] if cands else None
        second = cands[1][0] if len(cands) > 1 else 0.0

        top = None
        status = "none"
        if best:
            unique = len(cands) == 1
            # 동점 후보들이 전부 같은 시기의 글이면 같은 산행을 여러 게시판에
            # 올린 것 — 어느 쪽을 링크해도 맞으므로 1순위를 채택한다
            bd = to_date(best[1]["date"])
            near = [c for c in cands if best[0] - c[0] < 0.5]
            same_trip = all(abs((to_date(p["date"]) - bd).days) <= 3 for _, p in near)
            if best[0] >= 1.9 and (best[0] - second >= 0.5 or same_trip):
                top, status = best[1], "auto"
            elif unique and best[0] >= 1.5:
                top, status = best[1], "auto"
            else:
                status = "ambiguous"

        if status == "auto":
            n_auto += 1
        elif status == "ambiguous":
            n_amb += 1
        else:
            n_none += 1

        rows.append({
            "file": h.get("source", ""),
            "date": h["date"] or "",
            "mountain": h["mountain"],
            "title": top["title"] if top else "",
            "cafe_url": top["url"] if top else "",
        })
        if status != "auto":
            review.append({
                "status": status,
                "date": h["date"] or "",
                "mountain": h["mountain"],
                "source": h.get("source", ""),
                **{
                    f"cand{i+1}": f"[{sc:.1f}] {p['date']} [{p['board']}] {p['title']} {p['url']}"
                    for i, (sc, p) in enumerate(cands[:3])
                },
            })

    with open(ROOT / "data" / "hikes.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["file", "date", "mountain", "title", "cafe_url"])
        w.writeheader()
        w.writerows(rows)
    with open(ROOT / "data" / "match_review.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f, fieldnames=["status", "date", "mountain", "source", "cand1", "cand2", "cand3"]
        )
        w.writeheader()
        w.writerows(review)

    print(f"hikes: {len(hikes)}")
    print(f"auto-matched: {n_auto}")
    print(f"ambiguous (review): {n_amb}")
    print(f"no candidate: {n_none}")
    print(f"wrote data/hikes.csv, data/match_review.csv")


if __name__ == "__main__":
    main()
