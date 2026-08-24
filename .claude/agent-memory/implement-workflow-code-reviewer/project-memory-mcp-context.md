---
name: memory-mcp-review-context
description: Review context for memory-mcp repo — spec is the contract, eval harness is the acceptance gate, no integration tests against real stores
metadata:
  type: project
---

memory-mcp (feat/memory-mcp branch, first full implementation reviewed 2026-08-24) implements memory-mcp-spec.md steps 1-7; step 8 (AUTH_MODE=gateway-jwt) is intentionally blocked until the ats-mcp-platform gateway exists — server refusing gateway-jwt startup is correct, not a bug.

**Why:** The committed spec (memory-mcp-spec.md on main) is the review contract: fail-closed scrubbing before embed/store, hard-delete forget in both stores, nothing distilled active without approval, archive text wrapped as untrusted data, config only via packages/core/src/config.ts loadConfig, strict TS with no `any` in src.

**How to apply:** When reviewing this repo, diff behavior against the spec sections (esp. §5 tools, §7 ingestion, §10 security). Known blind spots to re-check in future reviews: all tests use fakes — there are zero integration tests against real Postgres/Qdrant, and `pnpm eval` (packages/evals) is the real acceptance gate, so path/config bugs in the eval runner or deploy files are not caught by `pnpm test`. Ingest-pipeline error handling conflates transient infra failures with bad-input quarantine — watch this area on follow-up PRs.
