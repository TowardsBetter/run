"""项目根、资料库 vendor、data 目录。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DATA = PROJECT / "data"
DETAIL_DIR = DATA / "activity_detail"
WEB = PROJECT / "web"


def _asset():
    tools = PROJECT.parents[2] / "tools"
    if not (tools / "asset_root.py").is_file():
        return None
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    import asset_root

    return asset_root


_asset_mod = _asset()
if _asset_mod is not None:
    VENDOR_SRC = _asset_mod.running_coach_vendor() / "src"
    VENV_PYTHON = _asset_mod.running_coach_venv() / "bin" / "python"
    MARGIN_READER_PYTHON = _asset_mod.margin_reader_venv() / "bin" / "python"
    SESSION_PATH = _asset_mod.running_coach_root() / "session.json"
    DB_PATH = _asset_mod.running_coach_root() / "coach.sqlite3"
    ECHARTS_JS = _asset_mod.running_coach_root() / "vendor" / "echarts" / "echarts.min.js"
else:
    VENDOR_SRC = PROJECT / "vendor" / "huawei-training-camp-mcp-connector" / "src"
    VENV_PYTHON = Path(sys.executable)
    MARGIN_READER_PYTHON = VENV_PYTHON
    SESSION_PATH = PROJECT / "session.json"
    DB_PATH = PROJECT / "coach.sqlite3"
    ECHARTS_JS = PROJECT / "vendor" / "echarts" / "echarts.min.js"


def ensure_data_dirs() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    running_coach_root().mkdir(parents=True, exist_ok=True)
