#!/bin/zsh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VAULT="$(cd "$HERE/../../../.." && pwd)"
source "$VAULT/tools/asset_root.sh"
PY="$RUNNING_COACH_VENV/bin/python"
cd "$HERE/.."
echo "== weather =="
"$PY" scripts/pull_weather.py
if [[ -n "${HTC_AUTHORIZATION:-}" && -n "${HTC_CLIENT_ID:-}" ]]; then
  echo "== huawei =="
  "$PY" scripts/pull_huawei.py
  echo "== vdot =="
  "$PY" scripts/compute_fitness.py
else
  echo "跳过华为：未设置 HTC_AUTHORIZATION / HTC_CLIENT_ID"
  "$PY" scripts/compute_fitness.py
fi
echo "刷新完成。打开仪表盘：python3 web/serve.py"
