#!/usr/bin/env bash
# Exports local VS Code Chat panel sessions (export-vscode-sessions.py)
# into this host's inbox folder, ahead of `memoryctl ingest`. Opt-in and
# silent: no-ops if the VS Code session store doesn't exist, so hosts that
# don't use VS Code's Chat panel are unaffected. Lands under
# LOCAL_DEVICE_NAME so VS Code, Claude Code, and OpenCode sessions from
# this host share one device tag.
set -uo pipefail

VSCODE_DB="${VSCODE_DB:-$HOME/.vscode-server/data/User/globalStorage/github.copilot-chat/session-store.db}"
LOCAL_DEVICE_NAME="${LOCAL_DEVICE_NAME:-}"

if [ ! -f "$VSCODE_DB" ]; then
  echo "no VS Code session store at $VSCODE_DB, skipping vscode export"
  exit 0
fi
if [ -z "$LOCAL_DEVICE_NAME" ]; then
  echo "LOCAL_DEVICE_NAME not set, skipping vscode export"
  exit 0
fi

out="/srv/memory/inbox/$LOCAL_DEVICE_NAME/vscode"
python3 "$(dirname "$0")/export-vscode-sessions.py" --db "$VSCODE_DB" --out "$out"
