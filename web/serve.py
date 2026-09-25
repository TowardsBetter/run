#!/usr/bin/env python3
"""本地静态服务：页面 + 点「更新」拉数。不要用 file://。"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import unquote

TCPServer.allow_reuse_address = True

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DATA = ROOT / "data"
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from grab_chrome_session import grab as grab_chrome  # noqa: E402
from paths import SESSION_PATH, VENV_PYTHON, ECHARTS_JS, ensure_data_dirs  # noqa: E402
import db as coach_db  # noqa: E402
import coach_talk  # noqa: E402

MAX_BODY = 1_000_000


def parse_creds(payload: dict) -> tuple[str, str]:
    auth = str(payload.get("authorization") or "").strip()
    client_id = str(payload.get("client_id") or "").strip()
    blob = str(payload.get("headers_blob") or "")
    for line in blob.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        value = value.strip().strip("'\"")
        if key == "authorization":
            auth = value
        elif key == "x-client-id":
            client_id = value
    if auth and not auth.lower().startswith("bearer "):
        auth = "Bearer " + auth
    return auth, client_id


def load_session() -> dict:
    if not SESSION_PATH.is_file():
        return {}
    try:
        return json.loads(SESSION_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_session(auth: str, client_id: str) -> None:
    ensure_data_dirs()
    SESSION_PATH.write_text(
        json.dumps({"authorization": auth, "client_id": client_id}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.chmod(SESSION_PATH, 0o600)


def session_public() -> dict:
    sess = load_session()
    cid = sess.get("client_id") or ""
    hint = cid[-4:] if len(cid) >= 4 else ""
    last_pull = None
    try:
        conn = coach_db.connect()
        coach_db.migrate(conn)
        row = conn.execute(
            "SELECT finished_at, ok, activities, details_fetched FROM sync_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        conn.close()
        if row:
            last_pull = {
                "at": row["finished_at"],
                "ok": bool(row["ok"]),
                "activities": row["activities"],
                "details_fetched": row["details_fetched"],
            }
    except Exception:
        last_pull = None
    return {
        "has_session": bool(sess.get("authorization") and cid),
        "client_id_hint": hint,
        "last_pull": last_pull,
    }


def run_script(name: str, env: dict[str, str]) -> dict:
    py = VENV_PYTHON
    if not py.is_file():
        return {"ok": False, "script": name, "error": f"找不到运行环境 {py}"}
    proc = subprocess.run(
        [str(py), str(SCRIPTS / name)],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    return {
        "ok": proc.returncode == 0,
        "script": name,
        "code": proc.returncode,
        "log": out[-2000:],
    }


def refresh(auth: str, client_id: str) -> dict:
    env = os.environ.copy()
    env["HTC_AUTHORIZATION"] = auth
    env["HTC_CLIENT_ID"] = client_id
    # 天气先拉：快、不依赖华为。华为失败时磁盘上至少是今天的预报。
    weather = run_script("pull_weather.py", env)
    huawei = run_script("pull_huawei.py", env)
    fitness = run_script("compute_fitness.py", env)
    steps = [weather, huawei, fitness]
    ok = huawei["ok"] and weather["ok"] and fitness["ok"]
    msg = "已刷新跑步、华为 AI 课表、睡眠、心率、天气和跑力。"
    if not huawei["ok"]:
        log = huawei.get("log") or ""
        if "401" in log or "Invalid Credentials" in log:
            msg = "华为登录已过期。打开训练营重新登录，保持标签开着，再点更新。"
        else:
            msg = "华为数据没拉下来。" + (log.splitlines()[-1] if log else "")
        if weather["ok"]:
            msg += " 天气已更新。"
    elif not weather["ok"]:
        msg = "跑步数据好了，天气失败。"
    return {
        "ok": ok,
        "partial": weather["ok"] or huawei["ok"] or fitness["ok"],
        "message": msg,
        "steps": [{"script": s["script"], "ok": s["ok"]} for s in steps],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        raw = path.split("?", 1)[0].split("#", 1)[0]
        if raw.startswith("/data/"):
            rel = raw[len("/data/") :]
            candidate = (DATA / rel).resolve()
            if DATA.resolve() in candidate.parents or candidate == DATA.resolve():
                return str(candidate)
        if raw in ("/vendor/echarts.min.js", "/vendor/echarts/echarts.min.js"):
            return str(ECHARTS_JS)
        if raw in ("", "/"):
            return str(WEB / "index.html")
        return super().translate_path(path)

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0]
        if route == "/api/health":
            self._json(200, {"ok": True, "service": "running-coach", "url": "http://127.0.0.1:18765/"})
            return
        if route == "/api/status":
            self._json(200, session_public())
            return
        if route == "/api/coach":
            self._json(200, coach_talk.state())
            return
        if route.startswith("/api/activity/"):
            aid = unquote(route[len("/api/activity/") :]).strip("/")
            if not aid:
                self._json(400, {"ok": False, "message": "缺少 activity_id。"})
                return
            conn = coach_db.connect()
            coach_db.migrate(conn)
            payload = coach_db.activity_series(conn, aid)
            conn.close()
            self._json(200 if payload.get("ok") else 404, payload)
            return
        super().do_GET()

    def do_POST(self) -> None:
        route = self.path.split("?", 1)[0]
        if route == "/api/coach":
            payload, err = self._read_json()
            if err:
                self._json(400, {"ok": False, "message": err})
                return
            result = coach_talk.dispatch(payload)
            self._json(200 if result.get("ok") else 400, result)
            return
        if route != "/api/refresh":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._json(413, {"ok": False, "message": "粘贴内容太长。"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "message": "请求不是 JSON。"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "message": "请求格式不对。"})
            return
        auth, client_id = parse_creds(payload)
        chrome_err = ""
        if not auth or not client_id:
            try:
                grabbed = grab_chrome()
                auth = grabbed["authorization"]
                client_id = grabbed["client_id"]
            except Exception as err:
                chrome_err = str(err)
        if not auth or not client_id:
            sess = load_session()
            auth = auth or sess.get("authorization") or ""
            client_id = client_id or sess.get("client_id") or ""
        if not auth or not client_id:
            self._json(
                400,
                {
                    "ok": False,
                    "message": chrome_err
                    or "还没有凭证。用 Chrome 打开华为训练营并登录，保持标签开着，再点更新。",
                },
            )
            return
        save_session(auth, client_id)
        try:
            result = refresh(auth, client_id)
        except subprocess.TimeoutExpired:
            self._json(504, {"ok": False, "message": "拉取超时，再点一次更新。"})
            return
        self._json(200 if result["ok"] else 502, result)

    def _read_json(self) -> tuple[dict, str]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return {}, "内容太长。"
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return {}, "请求不是 JSON。"
        if not isinstance(payload, dict):
            return {}, "请求格式不对。"
        return payload, ""

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        text = format % args if args else format
        if "Authorization" in text or "Bearer" in text:
            text = "(redacted)"
        print("[%s] %s" % (self.log_date_time_string(), text), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    os.chdir(WEB)
    port = args.port
    httpd = None
    last_err: OSError | None = None
    for candidate in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = candidate
            break
        except OSError as err:
            last_err = err
            httpd = None
    if httpd is None:
        raise SystemExit(f"无法绑定 127.0.0.1:{args.port}–{args.port + 19}：{last_err}")
    url = f"http://127.0.0.1:{port}/"
    print(f"跑步教练仪表盘 {url}", flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
        httpd.server_close()


if __name__ == "__main__":
    main()
