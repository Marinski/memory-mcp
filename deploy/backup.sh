#!/usr/bin/env bash
# Nightly backup: pg_dump + Qdrant collection snapshot, shipped to Monster.
# Retention: 14 days — a forget propagates out of backups within that window
# (spec section 10 / Q8).
set -euo pipefail

BACKUP_TARGET="${BACKUP_TARGET:-monster:/backup/memory-mcp}"
STAMP=$(date +%Y%m%d)
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# Postgres
docker compose -f /srv/memory/deploy/compose.gx10.yaml exec -T memory-postgres \
  pg_dump -U memory memory | gzip > "$WORKDIR/memory-pg-$STAMP.sql.gz"

# Qdrant snapshot (collection-level, via the existing qdrant container)
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
SNAP=$(curl -sf -X POST "$QDRANT_URL/collections/memory_archive/snapshots" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["name"])')
curl -sf "$QDRANT_URL/collections/memory_archive/snapshots/$SNAP" -o "$WORKDIR/memory-qdrant-$STAMP.snapshot"
curl -sf -X DELETE "$QDRANT_URL/collections/memory_archive/snapshots/$SNAP" > /dev/null

rsync -a "$WORKDIR/" "$BACKUP_TARGET/"

# 14-day retention on the target
ssh "${BACKUP_TARGET%%:*}" "find ${BACKUP_TARGET#*:} -type f -mtime +14 -delete"
echo "backup complete: $STAMP"
