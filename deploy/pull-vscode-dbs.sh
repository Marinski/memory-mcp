#!/usr/bin/env bash
# Pulls each configured remote host's VS Code Chat session-store.db to a
# local staging area, then runs export-vscode-sessions.py against each
# pulled copy. Reuses REMOTE_RSYNC_HOSTS/REMOTE_SCP_HOSTS from
# pull-remote-sessions.env rather than a separate host list — same idea
# as export-vscode-sessions.py's own no-op-if-missing posture: hosts
# without a VS Code session store are skipped silently.
#
# "Pull raw, transform centrally" rather than deploying Python to every
# remote: export-vscode-sessions.py needs Python + sqlite3, which we only
# maintain on this host, not on N remotes across two OSes.
set -uo pipefail

STAGING=/srv/memory/vscode-dbs
INBOX=/srv/memory/inbox

REMOTE_RSYNC_HOSTS="${REMOTE_RSYNC_HOSTS:-}"
REMOTE_SCP_HOSTS="${REMOTE_SCP_HOSTS:-}"

mkdir -p "$STAGING"

# <HOST>_DEVICE_NAME overrides the inbox folder name, same convention as
# pull-remote-sessions.sh.
device_name_for() {
  local var_name="${1^^}"
  var_name="${var_name//[.-]/_}_DEVICE_NAME"
  echo "${!var_name:-$1}"
}

pull_and_export() {
  local host="$1" remote_path="$2" device local_db
  device=$(device_name_for "$host")
  local_db="$STAGING/$device-session-store.db"
  echo "== $host =="
  if scp -q "$host:$remote_path" "$local_db" 2>/dev/null; then
    # SQLite in WAL mode can leave the main file just a header, with
    # uncommitted data sitting in the -wal sidecar. Best-effort pull it
    # alongside the main file in case it helps — but this is NOT a
    # reliable substitute for a proper checkpoint: separate sequential scp
    # calls against a database a process still has open aren't an atomic
    # snapshot, and SQLite correctly refuses (and can discard) a WAL that
    # doesn't match. Confirmed on a real host: a 4KB main file next to a
    # 150KB+ -wal came back as 0 sessions — recoverable only by the source
    # process itself checkpointing (periodic, or on VS Code closing), not
    # from here. Deliberately not pulling -shm: copying it while a process
    # holds it open is explicitly discouraged by SQLite itself.
    scp -q "$host:${remote_path}-wal" "$local_db-wal" 2>/dev/null || true
    rm -f "$local_db-shm"
    python3 "$(dirname "$0")/export-vscode-sessions.py" --db "$local_db" --out "$INBOX/$device/vscode"
  else
    echo "  no VS Code session store at $host:$remote_path"
  fi
}

for h in $REMOTE_RSYNC_HOSTS; do
  pull_and_export "$h" '~/.vscode-server/data/User/globalStorage/github.copilot-chat/session-store.db'
done

for h in $REMOTE_SCP_HOSTS; do
  # <HOST>_VSCODE_PATH overrides the remote path when the SSH login
  # account differs from the account that owns the VS Code profile
  # (same need as <HOST>_CLAUDE_PATH in pull-remote-sessions.sh).
  var_name="${h^^}"
  var_name="${var_name//[.-]/_}_VSCODE_PATH"
  remote_path="${!var_name:-~/AppData/Roaming/Code/User/globalStorage/github.copilot-chat/session-store.db}"
  pull_and_export "$h" "$remote_path"
done

echo "vscode db pull+export done"
