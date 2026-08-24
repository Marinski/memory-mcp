#!/usr/bin/env bash
# Exports local OpenCode sessions (export-opencode-sessions.py) into this
# host's inbox folder, ahead of `memoryctl ingest`. Opt-in and silent: no-ops
# if OpenCode's local db doesn't exist, so hosts that don't use OpenCode are
# unaffected. Lands under LOCAL_DEVICE_NAME so OpenCode and Claude Code
# sessions from this host share one device tag.
set -uo pipefail

OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
LOCAL_DEVICE_NAME="${LOCAL_DEVICE_NAME:-}"

if [ ! -f "$OPENCODE_DB" ]; then
  echo "no OpenCode db at $OPENCODE_DB, skipping opencode export"
  exit 0
fi
if [ -z "$LOCAL_DEVICE_NAME" ]; then
  echo "LOCAL_DEVICE_NAME not set, skipping opencode export"
  exit 0
fi

out="/srv/memory/inbox/$LOCAL_DEVICE_NAME/opencode"
python3 "$(dirname "$0")/export-opencode-sessions.py" --db "$OPENCODE_DB" --out "$out"
