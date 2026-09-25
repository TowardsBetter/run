"""页面进程跑在边注阅读的 Python 里，一句回复走 CursorReplier。

和边注阅读 `app.py` 的 `_run_isolated_reply` 同一条路：这次回复单独拉起 bridge，
调用 `CursorReplier.run`，用完关掉。不另起子进程，不留常驻 agent。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from paths import PROJECT

VAULT = PROJECT.parents[2]
MARGIN_READER = PROJECT.parent / "边注阅读"
for path in (str(MARGIN_READER), str(VAULT / "tools")):
    if path not in sys.path:
        sys.path.insert(0, path)

try:
    from asset_root import running_coach_root  # noqa: E402
    from reader.cursor_reply import CursorReplier, ReplyError  # noqa: E402
    from reader.secrets import read_cursor_api_key  # noqa: E402
except ImportError:
    running_coach_root = None
    CursorReplier = None
    ReplyError = Exception

    def read_cursor_api_key() -> str:
        return ""

# 与边注阅读当前保存的模型相同，一次回复用这一个字符串。
DEFAULT_MODEL = "composer-2.5"
DEFAULT_TIMEOUT = 180
_CALL = threading.Lock()


@dataclass
class ModelReply:
    text: str
    agent_id: str
    model: str


class ModelUnavailable(RuntimeError):
    """SDK、凭证、bridge 或模型运行未接通。"""


def model_label(model: str | dict[str, Any]) -> str:
    if isinstance(model, str):
        return model
    effort = next(
        (
            str(item.get("value") or "")
            for item in model.get("params") or []
            if isinstance(item, dict) and item.get("id") == "reasoning_effort"
        ),
        "",
    )
    return f"{model.get('id') or ''} {effort}".strip()


def _bridge_command() -> tuple[str, str]:
    from cursor_sdk._bridge import resolve_bridge_path

    wrapper = Path(resolve_bridge_path())
    node = wrapper.parent / "node"
    script = wrapper.parent.parent / "dist" / "bin" / "cursor-sdk-bridge.js"
    return str(node), str(script)


async def _drain_stderr(client: Any) -> None:
    bridge = getattr(client, "_owned_bridge", None)
    process = getattr(bridge, "process", None)
    stderr = getattr(process, "stderr", None)
    if stderr is None:
        return
    while True:
        chunk = await stderr.read(8192)
        if not chunk:
            return


async def _close_client(client: Any) -> None:
    bridge = getattr(client, "_owned_bridge", None)
    process = getattr(bridge, "process", None)
    try:
        await asyncio.wait_for(client.aclose(), timeout=5)
        return
    except Exception:  # noqa: BLE001
        pass
    if process is None or process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


def _chosen_model(model: str | dict[str, Any] | None) -> str | dict[str, Any]:
    if isinstance(model, dict) and str(model.get("id") or "").strip():
        return model
    text = str(model or os.environ.get("RUNNING_COACH_MODEL") or "").strip()
    return text or DEFAULT_MODEL


async def _once(
    prompt: str,
    *,
    model: str | dict[str, Any],
    timeout: int,
) -> ModelReply:
    from cursor_sdk import AsyncClient

    if CursorReplier is None or running_coach_root is None:
        raise ModelUnavailable("模型暂时未接通")
    text = str(prompt or "").strip()
    if not text:
        raise ModelUnavailable("prompt 为空")
    key = read_cursor_api_key()
    if not key:
        raise ModelUnavailable("Cursor SDK 密钥未接通")

    root = running_coach_root() / "bridge-replies"
    root.mkdir(parents=True, exist_ok=True)
    workdir = root / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=True)
    client = await asyncio.wait_for(
        AsyncClient.launch_bridge(
            _bridge_command(),
            workspace=str(workdir),
            client_timeout=90,
        ),
        timeout=25,
    )
    task: asyncio.Task[Any] | None = None
    drain: asyncio.Task[None] | None = None
    try:
        drain = asyncio.create_task(_drain_stderr(client))
        model_id = model if isinstance(model, str) else str(model.get("id") or "")
        replier = CursorReplier(client, key, model_id)
        task = asyncio.create_task(
            replier.run(
                "跑步教练",
                agent_id=None,
                prompt=text,
                model=model,
            )
        )
        final, new_agent_id, _trace = await asyncio.wait_for(task, timeout=timeout)
        reply_text = str(final or "").strip()
        reply_agent = str(new_agent_id or "").strip()
        if not reply_text or not reply_agent:
            raise ModelUnavailable("Cursor SDK 没有返回完整结果")
        return ModelReply(text=reply_text, agent_id=reply_agent, model=model_label(model))
    except ReplyError as exc:
        raise ModelUnavailable(str(exc) or "模型暂时未接通") from exc
    finally:
        if drain is not None and not drain.done():
            drain.cancel()
        await _close_client(client)
        if task is not None and not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=2)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        shutil.rmtree(workdir, ignore_errors=True)


def invoke(
    prompt: str,
    *,
    agent_id: str | None = None,
    model: str | dict[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    fresh: bool = False,
) -> ModelReply:
    """每一句都是一次独立回复。agent_id 不再续接，上下文在提示词里。"""
    del agent_id, fresh
    chosen = _chosen_model(model)
    with _CALL:
        try:
            return asyncio.run(_once(prompt, model=chosen, timeout=timeout))
        except (TimeoutError, asyncio.TimeoutError) as exc:
            raise ModelUnavailable("模型暂时未接通") from exc


def health_check() -> ModelReply:
    """无业务内容、无存档副作用的真实模型健康检查。"""
    return invoke(
        "这是运行通道健康检查，不涉及任何用户训练或健康信息。只回复：RUNNING_COACH_SDK_OK",
        timeout=DEFAULT_TIMEOUT,
    )
