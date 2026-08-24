#!/usr/bin/env bash
# Pushes the markdown export of active facts (memoryctl export-vault) into a
# live Obsidian vault. Safe to re-run: export-vault overwrites the same
# per-category files each time, so this just re-syncs the current fact set.
# Opt-in: no-ops if OBSIDIAN_PUSH_HOST/OBSIDIAN_VAULT_PATH aren't set.
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

# mkdir failure (dir already exists) is expected on every run after the
# first — ignored rather than checked.
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
