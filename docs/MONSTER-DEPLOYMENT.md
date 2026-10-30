# memory-mcp on monster (x86_64) — deployment notes

Deployed 30 Oct 2026 alongside the Graphiti memory service (they coexist:
Graphiti = live agent-written facts; memory-mcp = nightly session archive +
distilled personal facts).

## Layout
- Repo: `~/repos/memory-mcp` (stack runs from `deploy/`)
- Data root (`MEMORY_HOME`): `~/apps/memory-mcp` — `inbox/`, `archive/`,
  `quarantine/`, `export/vault/`
- Server: `http://127.0.0.1:7105/mcp` (static bearer in `deploy/.env`)
- Qdrant: in-stack, loopback `127.0.0.1:6333` (backup.sh snapshots from host)
- LiteLLM: scoped key alias `memory-mcp` (routes `local-embed-bge-m3`,
  `vllm-gemma4`), spec at `~/repos/aigate/litellm/keys/memory-mcp.json`

## Nightly (systemd --user)
- `memory-ingest.timer` 03:00 — pull sessions (monster local + ryzen/fractal
  via `deploy/pull-remote-sessions.env`), ingest, gemma distill, triage,
  staleness, export-vault. Obsidian push stays OFF (vault retired).
- `memory-backup.timer` 03:30 — pg_dump + qdrant snapshot to
  `gx10-head:backups/memory-mcp`, 14-day retention.

## Host adaptations (vs the arm64/GX10 defaults)
- `Dockerfile`: `--build-arg ARCH=amd64` for gitleaks (compose build uses
  the host arch automatically via the ARG default override in .env? no —
  set in the build; see commit 096a620).
- qdrant `ulimits.nofile 65536`: the first 15k-chunk ingest exhausted the
  default 1024 ("Too many open files").
- qdrant upsert is batched under 8 MiB/request: Qdrant rejects >32 MiB
  bodies; one 168 MB session batch failed the whole ingest (commit e25a98b).
- `/srv/memory` paths are `${MEMORY_HOME:-/srv/memory}` in the deploy scripts.

## Backfill state (first run)
- 900 sessions ingested (~46k chunks), ~4,600 active facts after triage.
- 3,096 files quarantined: Claude Code side-files (tool-results/, subagents/,
  *.meta.json) the parsers don't read — expected, harmless.
- One session (claude-code f9e9037d…) fails gemma extraction (malformed JSON
  response); retried nightly, may never parse.

## Client wiring
MCP entry named `memory` in: `~/.claude.json` (user scope),
`~/.config/opencode/opencode.jsonc`, `~/.pi/agent/mcp.json`.
Tools: `search_memory` (curated facts), `search_archive` (raw transcripts,
injection-framed), `remember`, `forget`, `list_recent_sessions`, `stats`.
