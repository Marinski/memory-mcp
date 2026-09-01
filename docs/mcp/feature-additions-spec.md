# Feature additions — Implementation Spec

Four surgical additions to memory-mcp. Each is a small surface change following
the existing patterns in this repo — no restructure, no new write path, no new
storage backend.

Rationale for the set — gaps found in everyday use of memory-mcp itself
(capture-and-distill on a personal arm64 box), each answered without a new LLM
write path:

1. **Recent sessions for a project** (compaction-recovery) — a
   `memory://sessions/recent` resource that answers "what have we been doing in
   project P lately" without needing a query. Solves a real, recurring problem
   (a long-running agent session compacts and loses its own recent context);
   data already stored (`session_id`, `project`, `ts` on every Qdrant chunk).
2. **Staleness / review pass** — flag active facts older than N months plus a
   `memory://recent/superseded` resource. Directly addresses the
   wrong-fact-drifts-forever failure observed in production (a superseded fact
   lingering as current truth), with observability only — no new LLM write path.
3. **Timeline** — expose ordered neighbors of a chunk (we already store
   `turn_range`) as an optional mode on `search_archive`.
4. **Project filter on `search_memory`** — fills an obvious retrieval gap. Note:
   this is the one item that is *not* a trivial schema addition — facts have no
   `project` column today. See Questions Q3.

Targets: `@memory/core` (data access), `@memory/cli` (staleness job),
`@memory/server` (MCP tools + resources). Each item is independently shippable;
#1+**#2** may be one PR, **#3** a second, **#4** a third — or all four in one.

---

## 1. Recent sessions for a project (compaction-recovery)

### Problem

A long-running agent session that hits its context limit compacts; afterward the
agent cannot answer "what were we just doing in project X?" because that context
is no longer in the window. `search_archive` answers it only if a query is known.
A "recent sessions" surface lets a client deliberately re-attach recent activity.

### Data model (already present)

Every Qdrant chunk payload carries `session_id`, `source_tool`, `project`, `ts`,
`turn_range`. Qdrant already has a keyword index on `project` (qdrant.ts L124–133).
No schema change.

### Design

Add a Qdrant-level primitive to `packages/core/src/vector/qdrant.ts`:

```ts
/** Most-recently-updated sessions for a project (or all), each with its first
 *  and last chunk timestamps and chunk count; ordered by most recent last chunk. */
recentSessions(opts: { project?: string; limit?: number; before?: number }):
  Promise<RecentSession[]>
```

where `RecentSession = { session_id, source_tool?, project?, first_ts?, last_ts?,
chunk_count }`.

Implementation note: Qdrant has no native "group by session_id, order by max(ts)"
aggregate in the shape this needs, so the practical approach is a **scroll with a
payload filter** (project match + optional `ts < before`) projecting only
`session_id`/`ts`/`source_tool`/`project` fields, aggregating client-side, then
sorting by `max(ts)` descending and returning the top `limit`. To bound the
scroll on large projects, first query the project's distinct session list cheaply
via a `scroll` on the keyword index; if chunk counts are huge, cap the scroll
(see Q1 — acceptable precision ceiling).

Alternatively, if the real production collection proves too large to scroll
per-call, store a derived `session_last_ts` index — but **do not** add a new
collection or new write path in v1; prefer the bounded scroll.

### MCP surface

`memory://sessions/recent?project=P&limit=N` resource (list template, mirroring
`memory://facts/recent`). Note the existing `fact` resource uses
`ResourceTemplate('memory://facts/{id}')`; a query-string style resource requires
either an `ResourceTemplate` with a `{project}` path segment (e.g.
`memory://sessions/project/{project}`) or a tool. Prefer a **tool**
`list_recent_sessions` OR a `ResourceTemplate` — see Q2 (this needs the user's
call because it affects the client surface). A tool is the smaller change and
matches how `search_archive` already takes `project?`.

Core function: `listRecentSessions(pool, qdrant, opts)` exported from `@memory/core`
(`index.ts`), implemented in a new `packages/core/src/sessions.ts` (or appended to
`search.ts` — pick the file that keeps related archive access together; see Q2).

### Verification

- Unit: fixture project with 3 sessions → `recentSessions({project})` returns all
  3, ordered by last chunk desc, correct `chunk_count`/`first_ts`/`last_ts`.
- MCP: tool round-trips against real data; a project known to have many sessions
  returns the requested `limit` without error and within a sane latency budget
  (add the call to the golden harness if it becomes measurable).
- Side-effect: re-check the goldens still pass (`pnpm eval` — this change touches
  archive access, must not regress recall@5).

---

## 2. Staleness / review pass

### Problem

We hit this in production: a Late Summer Sale fact's end date was corrected
(Aug 25–Sep 7 → Aug 25–Aug 31) and the old fact superseded — but nothing *signals*
that a superseded or aged fact still reads as current truth in the user's
profile. Facts age; nothing flags them. We want the observability half of a
needs_review / review_after review cycle, without an LLM write path.

### Data model (already present)

`facts.status` (`active|superseded|deleted`), `facts.superseded_by`,
`facts.created_at`, `facts.updated_at`. No schema change.

### Design

Two surfaces:

**a) `memoryctl staleness` command** (models on `triage.ts`):

```txt
memoryctl staleness [--older-than NMonths] [--resource RESOURCE]
  # prints active facts not updated in N months (default e.g. 12),
  # and superseded facts whose superseding is recent (window), for review.
```

Core function in `@memory/core`, e.g. `packages/core/src/staleness.ts`:
`listStaleFacts(pool, { olderThanMonths })` → `{ active_stale: Fact[],
superseded_recent: Fact[] }`. Pure SQL (`updated_at < now() - interval`),
no LLM. CLI command file `packages/cli/src/commands/staleness.ts` registered in
`cli/src/index.ts` mirroring the `triage` command shape (create context, run,
`await ctx.pool.end()` in `finally`).

**b) `memory://recent/superseded` resource** in `server/src/mcp.ts` (mirror the
`recent-facts` resource): last N superseded facts with their `superseded_by`
chain, mimeType `application/json`. Backed by a new core function
`listRecentSuperseded(pool, N)` (SQL: `WHERE status='superseded' ORDER BY
updated_at DESC LIMIT N`).

### Verification

- Unit: seed facts with `created_at`/`updated_at` in the past; `listStaleFacts`
  returns exactly the aged ones; `listRecentSuperseded` returns superseded in
  recency order.
- CLI: `memoryctl staleness` on real data prints a sensible, short list.
- MCP: `memory://recent/superseded` returns JSON with correct `superseded_by`
  ids; a known superseded pair (e.g. the sale-fact pair,
  `489d3d79… → 5e9a72f4…`) appears.

Optional (not required for this PR): wire the staleness job into the nightly
systemd unit like triage's `ExecStopPost` line. Leave as a follow-up unless the
user wants it now (Q4).

---

## 3. Timeline (ordered neighbors of a chunk)

### Problem

`search_archive` returns discrete chunks. When a chunk is useful, the agent
often wants the surrounding context — what was said just before/after in that
session. We already store `turn_range` ("3-7") and `scrollBySession` already sorts
by it (qdrant.ts L198–199).

### Design

Add an optional mode to `search_archive` exposing ordered neighbors. Two viable
shapes — pick per Q5:

- **Option A (tool params):** add `surround_turns?: number` (or
  `include_neighbors?: boolean`) to `search_archive`; when set, each returned hit
  expands to its session's ordered neighbor chunks (bounded by turn distance).
- **Option B (new core function + tool):** `archiveTimeline(session_id, around_chunk_id, window)` returning ordered `{turn_range, text, chunk_id}[]`, surfaced as a second tool `search_archive_timeline`.

Option A is the smaller surface (one param) but muddies search semantics; Option B
keeps search clean and is more explicit. The core plumbing is identical either
way: `scrollBySession(sessionId)` is already ordered by turn range; filter to the
neighbor window client-side. No Qdrant changes.

### Verification

- Unit: fixture session with known turn ranges → neighbors of a middle chunk come
  back in order, bounded by the window, exclusive of out-of-range.
- MCP: tool round-trip on a real session with adjacent chunks.
- Regression: default `search_archive` behavior unchanged (no param → no
  neighbors); goldens still pass.

---

## 4. Project filter on `search_memory`

### Problem

`search_archive` has a `project` filter; `search_memory` (the *default* lookup)
does not. A user asking "what did we decide in project X" gets archive-plus-noise
rather than curated facts scoped to X.

### Headwind — no project column on facts

The `facts` table has no `project` column (schema.sql L9–22), and `Fact`/
`NewFact`/`createFact` (facts.ts) carry no project. The archive's `project` comes
from session metadata at parse/normalize time; facts are written by `remember`
(no project arg) and distilled facts (proposed_fact jsonb — no project today).
This is therefore **not** a "smallest schema change" — it is:

1. New `project text NULL` column on `facts` (idempotent migration — see below).
2. `Fact` interface + `NewFact` + `createFact` + a `project` param on `remember`
   (and the distill `ProposedFact`? or backfill later — Q6).
3. A `project?` filter threaded through `fullTextFacts` → `searchMemory` →
   `search_memory` MCP tool.
4. **Backfill provenance**: how do existing facts get a project? Options:
   a. leave NULL and only filter facts created going forward (honest but weak);
   b. `memoryctl backfill-projects` from the archive (`session_id → project` in
      `facts.provenance`, matched against Qdrant sessions) — fills most facts;
      c. distribute the existing `data/`-style project knowledge via the vault
      export. (Q6 — user decides the acceptable backfill.)

### Migration pattern

`migrate.ts` currently reads only `schema.sql` (idempotent `IF NOT EXISTS`).
Appending `ALTER TABLE facts ADD COLUMN IF NOT EXISTS project text NULL` to
`schema.sql` is consistent with the existing "one file, idempotent" approach and
requires no new numbered migration runner. Add a GIN index on `project` only if a
golden/hot query demands it (low cardinality → plain btree if anything). This is
the smallest consistent change.

### Design

- `fullTextFacts(pool, query, category, limit, project?)` — add `AND (project =
  $4 OR $4 IS NULL)` (facts.ts).
- `searchMemory(pool, embedder, query, { category?, limit?, project? })`
  (search.ts).
- MCP `search_memory` gets `project?: string` (mcp.ts), described for the model.
- `remember` optionally accepts `project` (and stores it).

### Verification

- Unit: two facts same category/entity, different project → project-filtered
  search returns only the match.
- MCP: round-trip; `search_memory {query, project} ` returns only that project's
  facts (after a fact is `remember`ed with the project set).
- Regression: no `project` → behavior identical to today (NULL filter);
  goldens still pass.

---

## Files touched

| File | Change |
|---|---|
| `packages/core/src/vector/qdrant.ts` | `recentSessions` + `RecentSession` type + bounded scroll |
| `packages/core/src/sessions.ts` (new) | `listRecentSessions` (or fold into `search.ts`) |
| `packages/core/src/staleness.ts` (new) | `listStaleFacts`, `listRecentSuperseded` |
| `packages/core/src/db/schema.sql` | [4] `ADD COLUMN IF NOT EXISTS project text NULL` |
| `packages/core/src/db/facts.ts` | [4] `project` on interfaces + `fullTextFacts` + `createFact` |
| `packages/core/src/search.ts` | [4] `project` filter on `searchMemory`; [3] neighbor windowing helper |
| `packages/core/src/remember.ts` | [4] optional `project` param |
| `packages/core/src/index.ts` | export new functions/types |
| `packages/cli/src/commands/staleness.ts` (new) | [2] `memoryctl staleness` |
| `packages/cli/src/index.ts` | register staleness command |
| `packages/server/src/mcp.ts` | [1] sessions surface; [2] `memory://recent/superseded`; [3] neighbors mode; [4] `project` on `search_memory` |
| `packages/cli/src/index.ts` | register staleness command |

---

## Incremental steps (order + verification only)

Each step green before the next.

**Step A — [2] staleness observability** (no storage, no MCP surface risk).
*Verify:* `pnpm -r lint` + `pnpm -r test`; unit tests for `listStaleFacts` /
`listRecentSuperseded`; `memoryctl staleness` prints real aged/superseded facts.

**Step B — [1] recent sessions.** Add qdrant `recentSessions` + `listRecentSessions`
+ MCP surface (tool or resource per Q2).
*Verify:* unit + live round-trip on a multi-session project; latency sane; goldens
regression-free.

**Step C — [3] timeline.** Core neighbor helper + MCP mode (A or B per Q5).
*Verify:* unit on turn-range ordering; live round-trip; default search unchanged.

**Step D — [4] project filter.** Migration + threading + backfill (per Q6).
*Verify:* migration applied to live DB idempotently (re-run no-op on live, but test
against a scratch DB first — see below); project-filtered search returns only
matches; unfiltered behavior identical; goldens pass.

**Testing note for [4] on live DB:** the ALTER is `ADD COLUMN IF NOT EXISTS
project text NULL` — additive, non-blocking, requires no table rewrite; safe to
run against the live DB after being proven idempotent on the scratch DB used
previously for restore drills.

---

## Questions (locked)

**Q1.** *Bounded scroll OK for `recentSessions`?* **Answer: yes.** May miss
ultra-low-activity sessions on huge projects; no derived index.

**Q2.** *[1] tool or resource?* **Answer: tool** `list_recent_sessions(project?, limit)`.
`ResourceTemplate` doesn't support query-string resources.

**Q3.** *[4] NULL project allowed?* **Answer: yes.** Optional project arg on
`remember`; NULL facts.project left as-is; unfiltered behavior identical to today.

**Q4.** *Staleness in nightly unit?* **Answer: wire it in this PR.** Follows the
same `ExecStopPost` pattern as `triage`.

**Q5.** *[3] timeline surface?* **Answer: Option B** — separate
`search_archive_timeline` tool; `search_archive` unchanged.

**Q6.** *[4] backfill + ProposedFact.project?* **Answer: (b) `memoryctl
backfill-projects`** CLI (session_id→project via `facts.provenance`, matched
against Qdrant sessions) **and** distilled `ProposedFact` carries `project`.