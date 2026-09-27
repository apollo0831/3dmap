#!/usr/bin/env python3
"""Web server + GPX upload API (stdlib only).

Serves web/ and accepts GPX uploads that rebuild the track data.

Usage: python3 scripts/server.py [port]     (default 8931)
Upload passcode: data/upload_key.txt (auto-generated on first run)
"""
import hmac
import json
import re
import secrets
import subprocess
import sys
import unicodedata
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
GPX_DIR = ROOT / "data" / "gpx"
KEY_FILE = ROOT / "data" / "upload_key.txt"
MAX_UPLOAD = 50 * 1024 * 1024

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_data


def load_key():
    if KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
        if key:
            return key
    key = "".join(secrets.choice("0123456789") for _ in range(6))
    KEY_FILE.write_text(key + "\n", encoding="utf-8")
    return key


UPLOAD_KEY = load_key()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        return hmac.compare_digest(self.headers.get("X-Upload-Key", ""), UPLOAD_KEY)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/check":
            if self.authed():
                self.send_json(200, {"ok": True})
            else:
                self.send_json(401, {"ok": False, "error": "비밀번호가 맞지 않습니다"})
        elif path == "/api/upload":
            self.handle_upload()
        elif path == "/api/rebuild":
            self.handle_rebuild()
        else:
            self.send_json(404, {"ok": False, "error": "not found"})

    def handle_upload(self):
        if not self.authed():
            return self.send_json(401, {"ok": False, "error": "비밀번호가 맞지 않습니다"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            return self.send_json(400, {"ok": False, "error": "빈 파일입니다"})
        if length > MAX_UPLOAD:
            return self.send_json(413, {"ok": False, "error": "파일이 너무 큽니다 (50MB 제한)"})

        raw_name = urllib.parse.unquote(self.headers.get("X-Filename", ""))
        name = unicodedata.normalize("NFC", Path(raw_name).name)
        if not re.fullmatch(r"[^/\\]+\.gpx", name, re.IGNORECASE):
            return self.send_json(400, {"ok": False, "error": "GPX 파일만 올릴 수 있습니다"})

        body = self.rfile.read(length)

        GPX_DIR.mkdir(parents=True, exist_ok=True)
        tmp = GPX_DIR / (name + ".part")
        tmp.write_bytes(body)
        try:
            pts, gpx_name = build_data.parse_gpx(tmp)
        except Exception:
            tmp.unlink(missing_ok=True)
            return self.send_json(400, {"ok": False, "error": "GPX 파일을 읽을 수 없습니다 (형식 오류)"})
        if len(pts) < 2:
            tmp.unlink(missing_ok=True)
            return self.send_json(400, {"ok": False, "error": "트랙 좌표가 없는 파일입니다"})

        dest = GPX_DIR / name
        replaced = dest.exists()
        tmp.replace(dest)

        date = build_data.extract_date(pts, name)
        mountain = build_data.clean_mountain_name(gpx_name or Path(name).stem)
        dist = build_data.track_stats(pts)[0]
        self.send_json(200, {
            "ok": True,
            "file": name,
            "replaced": replaced,
            "date": date,
            "mountain": mountain,
            "distance_km": round(dist / 1000, 1),
            "points": len(pts),
        })

    def handle_rebuild(self):
        if not self.authed():
            return self.send_json(401, {"ok": False, "error": "비밀번호가 맞지 않습니다"})
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_data.py")],
            capture_output=True, text=True, timeout=300,
        )
        if proc.returncode != 0:
            return self.send_json(500, {"ok": False, "error": "데이터 생성 중 오류가 났습니다"})
        try:
            with open(WEB_DIR / "data" / "index.json", encoding="utf-8") as f:
                total = len(json.load(f)["hikes"])
        except Exception:
            total = None
        self.send_json(200, {"ok": True, "total_hikes": total})

    def end_headers(self):
        # 브라우저가 옛 html/css/js를 붙들고 있으면 수정이 반영되지 않는다.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not str(args[0] if args else "").startswith("GET /data/"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"서버 시작: http://localhost:{port}")
    print(f"업로드 페이지: http://localhost:{port}/upload.html")
    print(f"업로드 비밀번호: {UPLOAD_KEY}  ({KEY_FILE})")
    server.serve_forever()


if __name__ == "__main__":
    main()
