#!/bin/zsh
ROOT="${0:A:h}"
cd "$ROOT" || exit 1
exec "$ROOT/start.sh"
