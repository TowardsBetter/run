#!/usr/bin/env python3
"""真实 Cursor SDK 健康检查；不经过 coach_talk，不写用户会话或计划。"""

from __future__ import annotations

import json

from cursor_coach import ModelUnavailable, health_check


def main() -> int:
    try:
        reply = health_check()
    except ModelUnavailable as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    ok = "RUNNING_COACH_SDK_OK" in reply.text
    print(
        json.dumps(
            {
                "ok": ok,
                "model": reply.model,
                "agent_id_returned": bool(reply.agent_id),
                "token_verified": ok,
            },
            ensure_ascii=False,
        )
    )
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
