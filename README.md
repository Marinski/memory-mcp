# memory-mcp

Personal cross-tool memory: a searchable episodic archive of AI sessions from
all devices plus a curated, high-trust semantic facts layer, exposed through an
MCP server. Designed for a self-hosted arm64 box, WG-only. See
[docs/mcp/memory-mcp-spec.md](docs/mcp/memory-mcp-spec.md) for the full design.

## Layout

| Package | Purpose |
|---|---|
| `packages/core` | memory-core library — stores, chunking, embedding, hybrid retrieval, facts, scrub, distill (no MCP, no HTTP) |
| `packages/cli` | `memoryctl` — init, verify, ingest, distill, review, stats, export-vault, reembed, staleness, backfill-projects |
| `packages/server` | memory-mcp MCP server (Streamable HTTP, static bearer) |
| `packages/evals` | retrieval golden-set harness (recall@5, MRR, p95) |
| `deploy/` | compose.prod.yaml, Dockerfile, systemd timers, backup script |

## Two layers, two trust levels

- **Episodic archive** (Qdrant `memory_archive`): every chunk of every session.
  Dense (bge-m3, 1024) + sparse (IDF-modified TF) vectors, RRF-fused hybrid
  search. Searched only on demand (`search_archive`).
- **Semantic facts** (Postgres): curated statements with provenance. Default
  read surface (`search_memory`). Written by `remember` (source `user`) and by
  human-approved distillation (source `distilled`) — nothing distilled becomes
  active without `memoryctl review`.

## Features

Everything below is a first-class part of this project — no external services
beyond your own Qdrant and an OpenAI-compatible LLM gateway (see Operations).

- **Cross-device episodic archive.** Every AI session from any tool
  (chatgpt, claude, claude-code, opencode, vscode, markdown) is parsed, scrubbed,
  chunked, embedded (dense + sparse), and stored in Qdrant — searchable as raw
  historical transcripts via `search_archive`.

- **Curated semantic facts.** Beliefs, preferences, decisions, and people facts
  are distilled from sessions and stored in Postgres with provenance and a
  `review` approval gate. Nothing distilled becomes active truth without a human
  sign-off (`memoryctl review`). Written ad hoc via `remember`.

- **Semantic search over both layers.** `search_memory` is the fast, high-trust
  default over curated facts; `search_archive` is the on-demand, pre-filtered
  hybrid search over raw transcripts (injection-framed as data, never trusted as
  instructions).

- **Project scoping.** Facts and archive sessions carry an optional `project`
  label. `remember`, `search_memory`, `search_archive`, and `list_recent_sessions`
  take a `project` filter so recall can be scoped to one codebase or concern —
  and project-less results can be excluded. Existing facts can be backfilled from
  session provenance with `memoryctl backfill-projects` (provenance repair only:
  `updated_at` is untouched, and sessions with no project leave the fact unscoped
  rather than guessing wrong).

- **Most-recently-started sessions.** `list_recent_sessions(project?, limit)`
  returns the sessions a project was active in, newest first, each with its
  source tool, project, chunk count, and start time. This is the "what are we
  doing here lately" index into the archive — useful after a session compacts and
  drops its own recent context. It is a bounded scan, so on a very large archive
  an ultra-low-activity session may be missed.

- **Archive timeline.** `search_archive_timeline(session_id, around_chunk_id, window)`
  returns the chunks immediately before and after an archive hit in chronological
  order, so a single match can be zoomed out to its full conversation.

- **Staleness & review.** `memoryctl staleness --older-than <months> --recent <n>`
  reports active facts that have not been updated for months plus the most recent
  superseded facts. The `memory://recent/superseded` resource exposes the recent
  memory-churn log (updated facts and their `superseded_by` chain) to clients, so
  an aged or superseded fact never silently lingers as current truth. Wired into
  the nightly systemd pass.

- **Destructive, two-phase `forget`.** Forgetting by query first previews
  (`previewForgetByQuery`) exactly which facts will be hard-deleted from both
  stores before `forget` is confirmed.

- **Fail-closed scrubbing.** gitleaks plus custom regexes strip secrets before
  anything is embedded or stored; unparseable input quarantines; transient
  infrastructure failures roll back and retry on the next run.

## MCP surface

Tools: `remember`, `search_memory`, `search_archive`, `search_archive_timeline`,
`list_recent_sessions`, `forget` (destructive, two-phase by query). Resources:
`memory://stats`, `memory://facts/recent`, `memory://recent/superseded`,
`memory://facts/{id}`. `remember`, `search_memory`, and `list_recent_sessions`
accept an optional `project` scope; `search_archive` (and the timeline) filter
on archive session project metadata.

## Development

```
pnpm install
pnpm build        # all packages
pnpm test         # core + server suites (stores are mocked; nothing external touched)
pnpm eval         # golden-set retrieval harness (needs live stores + ingested data)
```

Config is environment-driven through `packages/core/src/config.ts`
(`loadConfig`) — see `deploy/.env.example` for every variable.

## Operations

```
cd deploy && cp .env.example .env   # fill in POSTGRES_PASSWORD, STATIC_BEARER, keys
docker compose -f compose.prod.yaml up -d --build
docker compose -f compose.prod.yaml exec memory-mcp memoryctl init
docker compose -f compose.prod.yaml exec memory-mcp memoryctl verify
```

`compose.prod.yaml` assumes Qdrant and an OpenAI-compatible LLM gateway
already run as external containers on your host — edit the `networks:`
section's `name:` fields to match your own Docker network names.

Daily ingest+distill and nightly backups are systemd timers
(`deploy/systemd/`). Backups age out after 14 days so a `forget` propagates
out of backups within that window.

## Security posture

- WG-only bind, static bearer (v1); gateway JWT is a planned future auth mode
  (Step 8), pending a compatible OIDC/JWT gateway in front of the server.
- Scrubbing (gitleaks + custom regexes) is **fail-closed** and runs before
  anything is embedded or stored. Unparseable input quarantines the whole
  file (recorded in the ledger); transient infrastructure failures (embedder,
  Qdrant, gitleaks unavailable) roll back cleanly, record nothing, and the
  file is retried on the next run.
- `forget` is a hard delete in both stores.
- Archive chunks are returned inside untrusted-data delimiters — historical
  transcripts can contain instruction-like text and must be treated as data.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev
setup and project conventions, and [CHANGELOG.md](CHANGELOG.md) for history.
This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
