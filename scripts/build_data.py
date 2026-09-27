#!/usr/bin/env python3
"""GPX -> web data pipeline.

Reads data/gpx/*.gpx (+ optional data/hikes.csv metadata),
writes web/data/tracks/<id>.json and web/data/index.json.

Usage: python3 scripts/build_data.py
"""
import csv
import hashlib
import json
import math
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GPX_DIR = ROOT / "data" / "gpx"
META_CSV = ROOT / "data" / "hikes.csv"
OUT_DIR = ROOT / "web" / "data"
TRACKS_DIR = OUT_DIR / "tracks"

SIMPLIFY_TOLERANCE_M = 5.0
PROFILE_POINTS = 200
ELE_SMOOTH_WINDOW = 5
ELE_GAIN_THRESHOLD = 3.0

# 참고자료 폴더(공식 코스, POI 모음, 전구간 개요) — 실제 산행 기록이 아니므로 제외
EXCLUDE_DIR_NAMES = {"산.고개.재.봉", "1+9전구간"}
EXCLUDE_DIR_PREFIXES = ("남파랑길 (1-65구간)", "Terrain 전구간")


def nfc(s):
    return unicodedata.normalize("NFC", s)


def collect_gpx_files():
    """Recursive scan with reference-folder exclusion and content dedup.

    대전둘레길/ 폴더에 최상위 488개 파일이 통째로 복사돼 있는 등 내용이 같은
    파일이 여러 경로에 존재하므로, md5로 중복을 제거하고 '실제' 폴더 > 최상위
    > 기타 서브폴더 > 대전둘레길 순으로 대표 경로를 고른다.
    """
    def priority(p):
        parts = [nfc(x) for x in p.relative_to(GPX_DIR).parts[:-1]]
        if any("실제" in x for x in parts):
            return 0
        if not parts:
            return 1
        if parts[0] == "대전둘레길":
            return 3
        return 2

    by_hash = {}
    skipped_dirs = set()
    for p in sorted(GPX_DIR.rglob("*")):
        if not (p.is_file() and p.suffix.lower() == ".gpx"):
            continue
        parts = [nfc(x) for x in p.relative_to(GPX_DIR).parts[:-1]]
        excluded = next(
            (d for d in parts
             if d in EXCLUDE_DIR_NAMES or d.startswith(EXCLUDE_DIR_PREFIXES)),
            None,
        )
        if excluded:
            skipped_dirs.add(excluded)
            continue
        h = hashlib.md5(p.read_bytes()).hexdigest()
        if h not in by_hash or priority(p) < priority(by_hash[h]):
            by_hash[h] = p

    for d in sorted(skipped_dirs):
        print(f"skip dir (참고자료): {d}", file=sys.stderr)
    return sorted(by_hash.values(), key=lambda p: nfc(str(p)))


def strip_ns(tag):
    return tag.split("}")[-1]


def parse_gpx(path):
    """Return list of points [(lon, lat, ele, time_str), ...] and gpx track name."""
    tree = ET.parse(path)
    root = tree.getroot()
    points = []
    name = None
    for el in root.iter():
        tag = strip_ns(el.tag)
        if tag == "name" and name is None:
            name = (el.text or "").strip() or None
        elif tag == "trkpt":
            lat = float(el.get("lat"))
            lon = float(el.get("lon"))
            ele = None
            time = None
            for child in el:
                ctag = strip_ns(child.tag)
                if ctag == "ele" and child.text:
                    ele = float(child.text)
                elif ctag == "time" and child.text:
                    time = child.text.strip()
            points.append((lon, lat, ele, time))
    return points, name


def haversine_m(lon1, lat1, lon2, lat2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def douglas_peucker(pts, tolerance_m):
    """Simplify on (lon, lat); keeps full tuples. Iterative to avoid recursion limits."""
    if len(pts) < 3:
        return pts
    # meters-per-degree approximation at track latitude
    lat0 = pts[0][1]
    mlat = 111320.0
    mlon = 111320.0 * math.cos(math.radians(lat0))

    def perp_dist(p, a, b):
        ax, ay = a[0] * mlon, a[1] * mlat
        bx, by = b[0] * mlon, b[1] * mlat
        px, py = p[0] * mlon, p[1] * mlat
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax, imax = -1.0, -1
        for k in range(i + 1, j):
            d = perp_dist(pts[k], pts[i], pts[j])
            if d > dmax:
                dmax, imax = d, k
        if dmax > tolerance_m:
            keep[imax] = True
            stack.append((i, imax))
            stack.append((imax, j))
    return [p for p, k in zip(pts, keep) if k]


def smooth(values, window):
    if len(values) < window:
        return values[:]
    out = []
    half = window // 2
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def track_stats(pts):
    dist = 0.0
    cum = [0.0]
    for i in range(1, len(pts)):
        dist += haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
        cum.append(dist)

    eles = [p[2] for p in pts if p[2] is not None]
    gain = 0.0
    ele_min = ele_max = None
    if eles:
        s = smooth(eles, ELE_SMOOTH_WINDOW)
        ele_min, ele_max = min(s), max(s)
        last = s[0]
        for e in s[1:]:
            if e - last >= ELE_GAIN_THRESHOLD:
                gain += e - last
                last = e
            elif last - e >= ELE_GAIN_THRESHOLD:
                last = e
    return dist, cum, gain, ele_min, ele_max


def build_profile(pts, cum):
    """Downsample to PROFILE_POINTS of [dist_km, ele]."""
    if not pts or pts[0][2] is None:
        return []
    n = min(PROFILE_POINTS, len(pts))
    out = []
    for i in range(n):
        idx = round(i * (len(pts) - 1) / max(1, n - 1))
        ele = pts[idx][2]
        if ele is not None:
            out.append([round(cum[idx] / 1000, 3), round(ele, 1)])
    return out


def extract_date(pts, filename):
    for p in pts:
        if p[3]:
            m = re.match(r"(\d{4}-\d{2}-\d{2})", p[3])
            if m:
                return m.group(1)
    m = re.search(r"(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})", filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


def clean_mountain_name(text):
    """Strip leading dates and app-generated suffixes from track/file names."""
    text = re.sub(r"__\d{8}_\d{4}$", "", text)
    text = re.sub(r"^\d{4}[-_.]\d{2}[-_.]\d{2}\s*", "", text)
    return text.strip() or text


def slugify(text):
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[^\w\uac00-\ud7a3-]+", "-", text).strip("-")
    return text or "track"


def load_report_lens():
    """data/cafe_bodies/<fldid>_<dataid>.json -> text_len (산행기 본문 길이)."""
    lens = {}
    bodies = ROOT / "data" / "cafe_bodies"
    if bodies.is_dir():
        for f in bodies.glob("*.json"):
            try:
                lens[f.stem] = json.loads(f.read_text(encoding="utf-8")).get("text_len", 0)
            except (ValueError, OSError):
                pass
    return lens


def load_meta():
    """Optional data/hikes.csv: file,date,mountain,title,cafe_url columns (header required)."""
    meta = {}
    if META_CSV.exists():
        with open(META_CSV, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                # NFC-normalize: macOS filenames are NFD, CSV text is usually NFC
                key = unicodedata.normalize("NFC", (row.get("file") or "").strip())
                if key:
                    meta[key] = {k: (v or "").strip() for k, v in row.items()}
    return meta


def main():
    gpx_files = collect_gpx_files()
    if not gpx_files:
        print(f"No GPX files in {GPX_DIR}", file=sys.stderr)
    meta_all = load_meta()
    report_lens = load_report_lens()
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)

    index = []
    ids = set()
    for gpx in gpx_files:
        try:
            pts, gpx_name = parse_gpx(gpx)
        except ET.ParseError as e:
            print(f"skip (XML parse error): {gpx.name}: {e}", file=sys.stderr)
            continue
        if len(pts) < 2:
            print(f"skip (no track points): {gpx.name}", file=sys.stderr)
            continue

        source = nfc(gpx.relative_to(GPX_DIR).as_posix())
        meta = meta_all.get(source) or meta_all.get(nfc(gpx.name)) or {}
        date = meta.get("date") or extract_date(pts, gpx.name)
        mountain = meta.get("mountain") or clean_mountain_name(gpx_name or gpx.stem)
        title = meta.get("title") or (f"{mountain} 산행" + (f" ({date})" if date else ""))
        cafe_url = meta.get("cafe_url") or ""
        rm = re.search(r"woosengzlsamo/(\w+)/(\w+)", cafe_url)
        report_len = report_lens.get(f"{rm.group(1)}_{rm.group(2)}") if rm else None

        dist, cum, gain, ele_min, ele_max = track_stats(pts)
        profile = build_profile(pts, cum)
        simplified = douglas_peucker(pts, SIMPLIFY_TOLERANCE_M)

        coords = [
            [round(p[0], 6), round(p[1], 6)] + ([round(p[2], 1)] if p[2] is not None else [])
            for p in simplified
        ]
        lons = [p[0] for p in simplified]
        lats = [p[1] for p in simplified]

        hike_id = slugify(f"{date or 'nodate'}-{mountain}")
        # dedupe id
        base, n = hike_id, 2
        while hike_id in ids:
            hike_id = f"{base}-{n}"
            n += 1
        ids.add(hike_id)

        track_geojson = {
            "type": "Feature",
            "properties": {"id": hike_id, "title": title, "profile": profile},
            "geometry": {"type": "LineString", "coordinates": coords},
        }
        with open(TRACKS_DIR / f"{hike_id}.json", "w", encoding="utf-8") as f:
            json.dump(track_geojson, f, ensure_ascii=False, separators=(",", ":"))

        # summit marker at highest point (fallback: midpoint)
        ele_pts = [p for p in simplified if p[2] is not None]
        top = max(ele_pts, key=lambda p: p[2]) if ele_pts else simplified[len(simplified) // 2]

        index.append({
            "id": hike_id,
            "title": title,
            "mountain": mountain,
            "date": date,
            "cafe_url": cafe_url,
            "report_len": report_len,
            "source": source,
            "distance_km": round(dist / 1000, 2),
            "elevation_gain_m": round(gain),
            "ele_min": round(ele_min) if ele_min is not None else None,
            "ele_max": round(ele_max) if ele_max is not None else None,
            "marker": [round(top[0], 6), round(top[1], 6)],
            "bounds": [round(min(lons), 6), round(min(lats), 6), round(max(lons), 6), round(max(lats), 6)],
            "points": len(coords),
        })
        print(f"ok: {source} -> {hike_id} ({len(pts)} -> {len(coords)} pts, {dist/1000:.1f} km)")

    index.sort(key=lambda h: h["date"] or "", reverse=True)
    with open(OUT_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump({"hikes": index}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"\nwrote {len(index)} hikes -> {OUT_DIR / 'index.json'}")


if __name__ == "__main__":
    main()
