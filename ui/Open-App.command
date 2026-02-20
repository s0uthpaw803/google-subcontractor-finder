#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p "$PWD/logs"
LOG_FILE="$PWD/logs/app.log"

# Start only if API ping is not reachable
if ! curl -fsS "http://127.0.0.1:8787/api/ping" >/dev/null 2>&1; then
  : > "$LOG_FILE"
  npm run app >>"$LOG_FILE" 2>&1 &
  sleep 1.5
fi

open "http://127.0.0.1:8787"
