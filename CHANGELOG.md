# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project does not yet use semantic version tags.

## [Unreleased]

### Added
- **Project scope** on facts and archive. `remember`, `search_memory`,
  `search_archive`, and `list_recent_sessions` accept an optional `project`;
  facts gained a nullable `project` column (idempotent `ALTER`) and
  project-scoped search excludes project-less results.
- **`memoryctl backfill-projects`** — repopulates NULL `facts.project` from
  session provenance via Qdrant (provenance repair only; `updated_at`
  untouched; unscoped sessions stay NULL rather than guessing wrong).
- **`list_recent_sessions`** MCP tool — bounded, payload-projected scan of
  the archive returning the most-recently-started sessions, newest first,
  with source tool, project, chunk count, and start time.
- **`search_archive_timeline`** MCP tool — ordered chunks immediately before
  and after an archive hit within its session (window clamped `[0, 50]`).
- **Staleness observability.** `memoryctl staleness --older-than/--recent`
  reports aged active facts and recent superseded facts; the
  `memory://recent/superseded` resource exposes the churn log; wired into the
  nightly systemd pass.

### Changed
- Genericized deployment docs, spec, and a few test fixtures ahead of the
  public release — hardware/host nicknames, internal gateway project names,
  and an internal domain reference were replaced with generic placeholders.
  No functional or security-relevant behavior changed.
- Added `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, and this changelog.

## [0.1.0] - 2026-08-24

Initial implementation of `docs/mcp/memory-mcp-spec.md` steps 1–7.

### Added
- `packages/core` — memory-core library: Postgres facts store (with
  supersede-aware `remember` and human-gated distillation review queue),
  Qdrant hybrid (dense + sparse, RRF-fused) episodic archive, session-aware
  chunker, fail-closed secret scrubbing (gitleaks + custom regex rules), and
  parsers for ChatGPT, Claude, Claude Code, OpenCode, and loose markdown
  session exports.
- `packages/cli` — `memoryctl`: `init`, `verify`, `ingest`, `distill`,
  `review`, `stats`, `export-vault`, `reembed`.
- `packages/server` — the memory-mcp MCP server (Streamable HTTP, stateless,
  static bearer auth) exposing `remember`, `search_memory`, `search_archive`,
  and `forget` (two-phase, destructive) as tools, plus `memory://stats`,
  `memory://facts/recent`, and `memory://facts/{id}` as resources.
- `packages/evals` — a recall@5 / MRR / p95-latency harness against a
  hand-written golden query set.
- `deploy/` — arm64 Docker Compose stack, Dockerfile, systemd timers for
  scheduled ingest+distill and nightly backups (14-day retention).
- Self-review pass (19 findings) fixing, among others: transient
  infrastructure failures now roll back and retry instead of being recorded
  as permanent ingest failures; Qdrant point IDs are now stable across
  re-exports instead of duplicating; `remember` and fact-review approval are
  now transactional; auth now fails closed on missing bearer config.
