"""项目根、资料库 vendor、data 目录。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DATA = PROJECT / "data"
DETAIL_DIR = DATA / "activity_detail"
WEB = PROJECT / "web"
VAULT = PROJECT.parents[2]  # 高中数学教学

if str(VAULT / "tools") not in sys.path:
    sys.path.insert(0, str(VAULT / "tools"))

from asset_root import (  # noqa: E402
    margin_reader_venv,
    running_coach_root,
    running_coach_vendor,
    running_coach_venv,
)

VENDOR_SRC = running_coach_vendor() / "src"
VENV_PYTHON = running_coach_venv() / "bin" / "python"
MARGIN_READER_PYTHON = margin_reader_venv() / "bin" / "python"
SESSION_PATH = running_coach_root() / "session.json"
DB_PATH = running_coach_root() / "coach.sqlite3"
ECHARTS_JS = running_coach_root() / "vendor" / "echarts" / "echarts.min.js"


def ensure_data_dirs() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    running_coach_root().mkdir(parents=True, exist_ok=True)
