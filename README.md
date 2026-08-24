# memory-mcp

Personal cross-tool memory: a searchable episodic archive of AI sessions from
all devices plus a curated, high-trust semantic facts layer, exposed through an
MCP server. Designed for a self-hosted arm64 box, WG-only. See
[docs/mcp/memory-mcp-spec.md](docs/mcp/memory-mcp-spec.md) for the full design.

## Layout

| Package | Purpose |
|---|---|
| `packages/core` | memory-core library — stores, chunking, embedding, hybrid retrieval, facts, scrub, distill (no MCP, no HTTP) |
| `packages/cli` | `memoryctl` — init, verify, ingest, distill, review, stats, export-vault, reembed |
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
