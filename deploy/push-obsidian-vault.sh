#!/usr/bin/env bash
# Pushes the markdown export of active facts (memoryctl export-vault) into a
# live Obsidian vault. Safe to re-run: the remote destination is wiped and
# recreated from scratch every time, mirroring export-vault's own
# rm-then-regenerate — so a fact that's superseded, deleted, or re-tagged
# doesn't leave a stale page (or a stale [[wikilink]]) behind on the Windows
# side. Opt-in: no-ops if OBSIDIAN_PUSH_HOST/OBSIDIAN_VAULT_PATH aren't set.
set -uo pipefail

EXPORT_DIR=/srv/memory/export/vault

OBSIDIAN_PUSH_HOST="${OBSIDIAN_PUSH_HOST:-}"
OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH:-}"
OBSIDIAN_VAULT_SUBDIR="${OBSIDIAN_VAULT_SUBDIR:-Memory}"

if [ -z "$OBSIDIAN_PUSH_HOST" ] || [ -z "$OBSIDIAN_VAULT_PATH" ]; then
  echo "OBSIDIAN_PUSH_HOST/OBSIDIAN_VAULT_PATH not set, skipping vault push"
  exit 0
fi

if [ ! -f "$EXPORT_DIR/index.md" ]; then
  echo "no export at $EXPORT_DIR, run export-vault first"
  exit 1
fi

dest="$OBSIDIAN_VAULT_PATH/$OBSIDIAN_VAULT_SUBDIR"

# Wipe the destination before rebuilding it. rm failure (dir doesn't exist
# yet — first run) is expected and ignored, same as the mkdir below.
if [[ "$OBSIDIAN_VAULT_PATH" =~ ^/[A-Za-z]: ]]; then
  # Windows target: ssh's default remote shell is cmd.exe, which needs a
  # backslash path, not the /C:/... form scp/sftp use.
  win_dest="${dest#/}"
  win_dest="${win_dest//\//\\}"
  ssh "$OBSIDIAN_PUSH_HOST" "rmdir /S /Q \"$win_dest\"" > /dev/null 2>&1
else
  ssh "$OBSIDIAN_PUSH_HOST" "rm -rf '$dest'" > /dev/null 2>&1
fi

sftp -b - "$OBSIDIAN_PUSH_HOST" > /dev/null 2>&1 <<SFTPEOF
mkdir "$dest"
mkdir "$dest/entities"
SFTPEOF

# -r and the trailing "/." copy the export dir's *contents* (including
# entities/) into dest, rather than nesting an extra "vault" directory.
if scp -qr "$EXPORT_DIR/." "$OBSIDIAN_PUSH_HOST:$dest/"; then
  n=$(find "$EXPORT_DIR" -name '*.md' | wc -l)
  echo "pushed $n files to $OBSIDIAN_PUSH_HOST:$dest"
else
  echo "vault push to $OBSIDIAN_PUSH_HOST failed"
  exit 1
fi
