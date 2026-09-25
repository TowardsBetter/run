"""从本机 Chrome 已打开的华为训练营标签读 accessToken。

训练营把登录态放在 sessionStorage.accessToken，x-client-id 是网页公开的应用号。
不打印 token 本身。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

# SYS_GLOBAL_CONFIG.login.viteClientId，网页公开，不是用户密钥
HTC_WEB_CLIENT_ID = "106533743"

CHROME_ROOT = Path.home() / "Library/Application Support/Google/Chrome"


def _read_varint(data: bytes, i: int) -> tuple[int, int]:
    n = 0
    shift = 0
    while i < len(data):
        b = data[i]
        i += 1
        n |= (b & 0x7F) << shift
        if b < 0x80:
            return n, i
        shift += 7
        if shift > 35:
            break
    return 0, i


def _map_values(blob: bytes, field: str) -> list[str]:
    key = field.encode("ascii")
    found: list[str] = []
    start = 0
    while True:
        i = blob.find(key, start)
        if i < 0:
            break
        n, j = _read_varint(blob, i + len(key))
        start = i + 1
        if n < 2 or n > 8000 or j + n > len(blob) or n % 2:
            continue
        raw = blob[j : j + n]
        if raw[1::2].strip(b"\x00"):
            continue
        try:
            text = raw.decode("utf-16-le")
        except UnicodeDecodeError:
            continue
        if text and "\x00" not in text:
            found.append(text)
    return found


def _session_storage_dirs() -> list[Path]:
    if not CHROME_ROOT.is_dir():
        return []
    out: list[Path] = []
    for child in CHROME_ROOT.iterdir():
        folder = child / "Session Storage"
        if folder.is_dir():
            out.append(folder)
    return out


def _read_blobs(folder: Path) -> list[bytes]:
    blobs: list[bytes] = []
    for name in ("000003.log", "000005.log", "000007.log"):
        path = folder / name
        if path.is_file():
            try:
                blobs.append(path.read_bytes())
            except OSError:
                continue
    for path in sorted(folder.glob("*.log")) + sorted(folder.glob("*.ldb")):
        try:
            blobs.append(path.read_bytes())
        except OSError:
            continue
    return blobs


def grab() -> dict:
    best: tuple[int, str] | None = None
    fallback_token = ""
    saw_host = False
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    for folder in _session_storage_dirs():
        for blob in _read_blobs(folder):
            if b"health.cloud.huawei.com" in blob:
                saw_host = True
            tokens = _map_values(blob, "accessToken")
            expires = []
            for raw in _map_values(blob, "expireTime"):
                try:
                    expires.append(int(raw))
                except ValueError:
                    continue
            if tokens:
                fallback_token = tokens[-1]
            if tokens and expires:
                exp_ms = max(expires)
                if best is None or exp_ms >= best[0]:
                    best = (exp_ms, tokens[-1])
    token = (best[1] if best else "") or fallback_token
    if not token:
        if saw_host:
            raise RuntimeError("Chrome 里有训练营页面，但没读到 accessToken。刷新训练营后再试。")
        raise RuntimeError("Chrome 里没有训练营登录态。先打开训练营并登录，保持标签开着。")
    exp_ms = best[0] if best else None
    if exp_ms and exp_ms < now_ms:
        raise RuntimeError("训练营登录已过期。打开训练营重新登录，保持标签开着再更新。")
    auth = token if token.lower().startswith("bearer ") else "Bearer " + token
    result = {
        "authorization": auth,
        "client_id": HTC_WEB_CLIENT_ID,
        "token_len": len(token),
        "expires_at": (
            datetime.fromtimestamp(exp_ms / 1000, tz=timezone.utc).isoformat()
            if exp_ms
            else None
        ),
        "source": "chrome-session-storage",
    }
    return result


def save_session(auth: str, client_id: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        json.dumps({"authorization": auth, "client_id": client_id}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.chmod(dest, 0o600)


if __name__ == "__main__":
    from paths import SESSION_PATH

    info = grab()
    save_session(info["authorization"], info["client_id"], SESSION_PATH)
    print(
        json.dumps(
            {
                "ok": True,
                "token_len": info["token_len"],
                "expires_at": info["expires_at"],
                "client_id": info["client_id"],
                "saved": str(SESSION_PATH),
            },
            ensure_ascii=False,
        )
    )
