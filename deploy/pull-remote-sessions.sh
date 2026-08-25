#!/usr/bin/env bash
# Pulls Claude Code session data from configured local/remote devices into
# the memory-mcp inbox, ahead of `memoryctl ingest`. Safe to re-run: files
# whose content hasn't changed are skipped by ingest's own content-hash
# ledger, and a growing session file lands as new content that upserts onto
# its existing archive points (stable session-based point ids) rather than
# duplicating. One host failing does not stop the others.
set -uo pipefail

INBOX=/srv/memory/inbox

LOCAL_CLAUDE_DIR="${LOCAL_CLAUDE_DIR:-$HOME/.claude/projects}"
LOCAL_DEVICE_NAME="${LOCAL_DEVICE_NAME:-}"

# Space-separated SSH config host aliases with a native ~/.claude/projects
# reachable over rsync (Linux/macOS hosts).
REMOTE_RSYNC_HOSTS="${REMOTE_RSYNC_HOSTS:-}"

# Space-separated SSH config host aliases reachable only via SFTP/scp
# (Windows hosts — no rsync). "ssh-*" prefixed project dirs are skipped:
# those are Claude Code's local mirror of sessions run *through* an SSH
# connection from this host to somewhere else, and are already captured
# natively at their origin host — pulling them too would duplicate content.
REMOTE_SCP_HOSTS="${REMOTE_SCP_HOSTS:-}"

mkdir -p "$INBOX"

# <HOST>_DEVICE_NAME overrides the inbox folder name for a host, when it
# should differ from the SSH config alias (e.g. keeping an existing inbox
# folder's name stable across a host alias rename).
device_name_for() {
  local var_name="${1^^}"
  var_name="${var_name//[.-]/_}_DEVICE_NAME"
  echo "${!var_name:-$1}"
}

pull_local() {
  [ -z "$LOCAL_DEVICE_NAME" ] && return
  local dest="$INBOX/$LOCAL_DEVICE_NAME"
  mkdir -p "$dest"
  echo "== local ($LOCAL_DEVICE_NAME) =="
  # No -a: preserving remote owner/group needs root and isn't needed here —
  # these files just get consumed and moved by the ingest pipeline.
  # --exclude .git/: a project folder can contain its own git-tracked
  # scratch dir (seen in practice: a "memory/" subfolder with a real .git/
  # inside a Claude project tree) — repo internals aren't session content
  # and always land in quarantine (undetectable source kind), so skip them
  # at the source instead of pulling and discarding them every run.
  rsync -rlt --exclude='.git/' "$LOCAL_CLAUDE_DIR/" "$dest/" || echo "  local pull failed"
}

pull_rsync_host() {
  local host="$1" dest="$INBOX/$(device_name_for "$1")"
  mkdir -p "$dest"
  echo "== $host (rsync) =="
  rsync -rltz --exclude='.git/' "$host:~/.claude/projects/" "$dest/" || echo "  $host pull failed"
}

pull_scp_host() {
  local host="$1" dest="$INBOX/$(device_name_for "$1")"
  mkdir -p "$dest"
  echo "== $host (scp, excluding ssh-* mirrors) =="

  # <HOST>_CLAUDE_PATH overrides the remote base path when the SSH login
  # account differs from the account that owns the Claude sessions.
  local var_name="${host^^}"
  var_name="${var_name//[.-]/_}_CLAUDE_PATH"
  local remote_path="${!var_name:-.claude/projects}"

  local dirs
  dirs=$(sftp -b - "$host" <<SFTPEOF 2>/dev/null | grep -v '^sftp>' | grep -v '^Remote working directory' | awk -F/ '{print $NF}'
ls -1 "$remote_path"
SFTPEOF
)
  if [ -z "$dirs" ]; then
    echo "  could not list $host:$remote_path"
    return
  fi
  echo "$dirs" | grep -v '^ssh-' | while IFS= read -r d; do
    [ -z "$d" ] && continue
    scp -q -r "$host:$remote_path/$d" "$dest/" 2>/dev/null || echo "  failed: $d"
  done
}

pull_local
for h in $REMOTE_RSYNC_HOSTS; do pull_rsync_host "$h"; done
for h in $REMOTE_SCP_HOSTS; do pull_scp_host "$h"; done

echo "pull done"
