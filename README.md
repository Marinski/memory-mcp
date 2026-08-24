# memory-mcp

Personal cross-tool memory: a searchable episodic archive of AI sessions from
all devices plus a curated, high-trust semantic facts layer, exposed through an
MCP server. Runs on the GX10 (arm64), WG-only. See
[memory-mcp-spec.md](memory-mcp-spec.md) for the full design.

## Layout

| Package | Purpose |
|---|---|
| `packages/core` | memory-core library — stores, chunking, embedding, hybrid retrieval, facts, scrub, distill (no MCP, no HTTP) |
| `packages/cli` | `memoryctl` — init, verify, ingest, distill, review, stats, export-vault, reembed |
| `packages/server` | memory-mcp MCP server (Streamable HTTP, static bearer) |
| `packages/evals` | retrieval golden-set harness (recall@5, MRR, p95) |
| `deploy/` | compose.gx10.yaml, Dockerfile, systemd timers, backup script |

## Two layers, two trust levels

- **Episodic archive** (Qdrant `memory_archive`): every chunk of every session.
  Dense (bge-m3, 1024) + sparse (IDF-modified TF) vectors, RRF-fused hybrid
  search. Searched only on demand (`search_archive`).
- **Semantic facts** (Postgres): curated statements with provenance. Default
  read surface (`search_memory`). Written by `remember` (source `user`) and by
  human-approved distillation (source `distilled`) — nothing distilled becomes
  active without `memoryctl review`.

## MCP surface

Tools: `remember`, `search_memory`, `search_archive`, `forget` (destructive,
two-phase by query). Resources: `memory://stats`, `memory://facts/recent`,
`memory://facts/{id}`.

## Development

```
pnpm install
pnpm build        # all packages
pnpm test         # core + server suites (stores are mocked; nothing external touched)
pnpm eval         # golden-set retrieval harness (needs live stores + ingested data)
```

Config is environment-driven through `packages/core/src/config.ts`
(`loadConfig`) — see `deploy/.env.example` for every variable.

## Operations (GX10)

```
cd deploy && cp .env.example .env   # fill in POSTGRES_PASSWORD, STATIC_BEARER, keys
docker compose -f compose.gx10.yaml up -d --build
docker compose -f compose.gx10.yaml exec memory-mcp memoryctl init
docker compose -f compose.gx10.yaml exec memory-mcp memoryctl verify
```

Daily ingest+distill and nightly backups are systemd timers
(`deploy/systemd/`). Backups age out after 14 days so a `forget` propagates
out of backups within that window.

## Security posture

- WG-only bind, static bearer (v1); gateway JWT lands with ats-mcp-platform Step 8.
- Scrubbing (gitleaks + custom regexes) is **fail-closed** and runs before
  anything is embedded or stored; failures quarantine the whole file.
- `forget` is a hard delete in both stores.
- Archive chunks are returned inside untrusted-data delimiters — historical
  transcripts can contain instruction-like text and must be treated as data.
