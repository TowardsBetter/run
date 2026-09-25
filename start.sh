#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"

_dir="$ROOT"
while [[ "$_dir" != "/" ]]; do
  if [[ -f "$_dir/tools/asset_root.sh" ]]; then
    source "$_dir/tools/asset_root.sh"
    break
  fi
  _dir="$(dirname "$_dir")"
done
unset _dir

PORT=18765
URL="http://127.0.0.1:${PORT}/"
LOG_DIR="${RUNNING_COACH_ROOT:-$ROOT}/logs"
mkdir -p "$LOG_DIR"
OUT="$LOG_DIR/dashboard.out.log"
ERR="$LOG_DIR/dashboard.err.log"

alive() {
  curl --silent --fail --max-time 1 "${URL}api/health" 2>/dev/null | grep -q "running-coach"
}

if ! alive; then
  PY="${MARGIN_READER_VENV:?找不到 MARGIN_READER_VENV，请检查 tools/asset_root.sh}/bin/python"
  if [[ ! -x "$PY" ]]; then
    echo "边注阅读的 Python 不存在：$PY"
    exit 1
  fi
  cd "$ROOT"
  nohup "$PY" "$ROOT/web/serve.py" --port "$PORT" --no-open >"$OUT" 2>"$ERR" &
  for _ in {1..40}; do
    if alive; then
      break
    fi
    sleep 0.15
  done
fi

if ! alive; then
  echo "仪表盘没起来。日志：$ERR"
  echo "-----"
  tail -n 40 "$ERR" 2>/dev/null || true
  echo "按回车关闭"
  read
  exit 1
fi

open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
