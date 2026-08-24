# Contributing

Thanks for considering a contribution to memory-mcp. This is a personal
second-brain tool that grew into something others might find useful — issues,
fixes, and well-scoped features are all welcome.

## Before you start

For anything beyond a small fix, open an issue first describing the problem
and your proposed approach. This avoids wasted work on changes that don't fit
the project's direction (see "Design principles" below).

## Development setup

```bash
git clone <your-fork-url>
cd memory-mcp
pnpm install
pnpm build
pnpm test
```

Requires Node ≥22 and pnpm (see `packageManager` in `package.json` for the
pinned version). Tests run entirely against mocked stores — no live Postgres,
Qdrant, or LLM gateway is needed to develop or run `pnpm test`.

The `pnpm eval` retrieval harness (`packages/evals`) is the exception: it
needs live stores and ingested data, and isn't part of CI. Only run it if
you're changing retrieval behavior and have a stack to test against.

## Before opening a PR

Run, in order, and fix anything each step surfaces before moving to the next:

```bash
pnpm test    # unit tests
pnpm lint    # tsc --noEmit across all packages
pnpm build   # full workspace build
```

## Project conventions

- **Strict TypeScript, no `any`** in `src/` — tests may relax this where it
  genuinely simplifies fakes/mocks.
- **Config only through `packages/core/src/config.ts`** (`loadConfig`) — no ad
  hoc `process.env` reads elsewhere. Update `deploy/.env.example` alongside
  any new config variable.
- **Idempotent SQL migrations** — `packages/core/src/db/schema.sql` uses
  `IF NOT EXISTS` / `ON CONFLICT` throughout; new schema changes should follow
  the same pattern rather than requiring manual migration state tracking.
- **Mock at the client boundary in tests** — Qdrant, the embedder, the LLM
  client, and the Postgres pool are all injected dependencies. Tests fake
  these interfaces; they never touch real infrastructure.
- **Fail closed on security-relevant paths.** Secret scrubbing, auth checks,
  and config validation should error out rather than silently proceed when
  something is missing or ambiguous.

## Design principles

- The **spec** (`docs/mcp/memory-mcp-spec.md`) is the source of truth for intended
  behavior — read it before proposing an architectural change.
- The **eval harness** (`pnpm eval`, recall@5/MRR/p95 against a hand-written
  golden query set) is the real acceptance gate for retrieval-quality changes,
  not just passing unit tests.
- Keep the two memory layers' trust boundary intact: the episodic archive
  (Qdrant) is untrusted, searched-on-demand data; the facts layer (Postgres)
  is small, curated, and high-trust. Don't blur that line for convenience.
- Nothing distilled by the LLM becomes an active fact without human review —
  don't add auto-approval paths without discussing it first (see spec §7,
  Q7).

## Reporting security issues

Please don't open a public issue for a security vulnerability — see
[SECURITY.md](SECURITY.md) instead.
