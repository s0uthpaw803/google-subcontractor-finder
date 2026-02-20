#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

# Load user PATH when launched from Finder.
[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"

mkdir -p "$PWD/logs"
LOG_FILE="$PWD/logs/app.log"

# Always restart so latest code is used.
if lsof -ti tcp:8787 >/dev/null 2>&1; then
  kill $(lsof -ti tcp:8787) >/dev/null 2>&1 || true
  sleep 0.5
fi

: > "$LOG_FILE"
HOST=127.0.0.1 npm run app >>"$LOG_FILE" 2>&1 &
sleep 1.5

open "http://127.0.0.1:8787/?appwindow=1"
