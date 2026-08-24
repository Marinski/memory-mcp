# memory-mcp — Implementation Spec (self-hosted second brain)

Personal cross-tool memory system: ingest historical and ongoing AI sessions from all
devices/tools, store them as a searchable episodic archive plus a curated semantic
facts layer, and expose both through an MCP server. Runs on a self-hosted arm64 host,
Dockerized, with an optional future integration as a downstream behind an internal
MCP gateway (`/memory` endpoint) if one exists.

Builder mode: **embed** — the MCP server imports `memory-core` directly; there is no
pre-existing service to wrap. This spec covers the whole project: core library,
ingestion, retrieval, distillation, MCP server, deployment.

Target: MCP 2026-07-28, `@modelcontextprotocol/sdk` (TypeScript), Streamable HTTP.

---

## 1. Scope

**In scope**
- `memory-core`: storage, chunking, embedding, hybrid retrieval, facts store
- `memoryctl`: ingestion + admin CLI (import, scrub, distill, export, verify)
- `memory-mcp`: MCP server over memory-core (tools + resources)
- Retrieval quality harness (golden queries, measured before the MCP layer exists)
- Docker Compose deployment on an arm64 host, WG-only binding
- Gateway integration contract (compliance with an internal MCP gateway's
  auth/catalog conventions, if one exists)

**Out of scope / non-goals**
- Realtime capture hooks inside ChatGPT/Claude/OpenCode (v1 ingests exports/files)
- Multi-user tenancy (single `sub` = the operator; the identity field exists but is
  constant)
- A web UI (the facts vault export + MCP tools are the interfaces; UI can come later)
- GPU workloads in this stack — embeddings and distillation are **network calls to
  the existing aigate/vLLM stack**, so no CDI passthrough for these containers

---

## 2. Architecture

```
devices (10x) ──sync──► host:/srv/memory/inbox/        (raw exports, session files)
                              │  memoryctl ingest
                              ▼
                     parse → normalize → scrub (gitleaks) → chunk
                              │                       │
                              ▼                       ▼
                    Qdrant (existing)          Postgres (new container)
                    collection: memory_archive  facts, entities, relations,
                    dense + sparse vectors      ingest ledger, review queue
                              ▲                       ▲
                              │      memoryctl distill │ (scheduled; calls Gemma
                              │                        │  via aigate for extraction)
                              └────────┬──────────────┘
                                       │ memory-core API
                                       ▼
                              memory-mcp (Streamable HTTP, WG bind)
                                       ▼ later
                    internal MCP gateway /memory endpoint (svc host, over WG)
```

Two layers, different trust levels:
- **Episodic archive** (Qdrant): every chunk of every session. Large, noisy,
  *searched only on demand* (`search_archive`), never injected by default.
- **Semantic facts** (Postgres): small, curated, high-trust statements with
  provenance. Default read surface (`search_memory`), written by `remember` and by
  reviewed distillation.

---

## 3. Repository layout

Repo: `memory-mcp` (single repo, pnpm workspaces).

```
memory-mcp/
  packages/
    core/                     # memory-core library (no MCP, no HTTP)
      src/
        db/
          schema.sql          # Postgres DDL + migrations (node-pg-migrate)
          facts.ts            # facts CRUD, entity/relation graph, provenance
          ledger.ts           # ingest ledger (file hash -> status), dedupe
        vector/
          qdrant.ts           # collection mgmt, upsert, hybrid query (dense+sparse)
          embed.ts            # aigate client (OpenAI-compatible /embeddings)
          chunker.ts          # session-aware chunking (turn-boundary, ~512 tok, overlap)
        ingest/
          normalize.ts        # common Session/Turn model all parsers emit
          parsers/
            chatgpt.ts        # conversations.json from ChatGPT export zip
            claude.ts         # Claude data export
            claude-code.ts    # ~/.claude/projects/**/*.jsonl session logs
            opencode.ts       # OpenCode session storage
            markdown.ts       # loose .md notes (Obsidian vault import)
          scrub.ts            # gitleaks subprocess + custom regex set; quarantine
        distill/
          extract.ts          # LLM fact extraction (via aigate), confidence scores
          review.ts           # review queue ops (approve/reject/edit)
        search.ts             # search_memory / search_archive impl, result shaping
        forget.ts             # hard-delete semantics across PG + Qdrant
    cli/                      # memoryctl
      src/commands/           # ingest, distill, review, export-vault, verify, stats
    server/                   # memory-mcp MCP server
      src/
        index.ts              # Streamable HTTP bootstrap, healthz
        auth.ts               # v1: static bearer (WG-only); later gateway-issued JWT
        tools/                # remember, search_memory, search_archive, forget
        resources/            # memory://facts/recent, memory://facts/{id},
                              # memory://stats
    evals/                    # retrieval quality harness
      golden.yaml             # query -> expected source sessions/facts
      run.ts                  # recall@k, MRR, latency report
  deploy/
    compose.prod.yaml         # memory-mcp, postgres; external: qdrant, aigate
    .env.example
  docs/mcp/                   # builder artifacts if/when a builder pass is run
```

---

## 4. Data model

### 4.1 Postgres

```sql
facts(id, statement text, category text,        -- preference|decision|fact|project|person
      entities text[], confidence real,
      source text,                              -- 'user' | 'distilled' | 'imported'
      provenance jsonb,                         -- [{session_id, chunk_id}]
      status text,                              -- 'active' | 'superseded' | 'deleted'
      superseded_by uuid null,
      created_at, updated_at)

entities(id, name, type, aliases text[])        -- lightweight graph, official-memory style
relations(id, from_entity, to_entity, relation, provenance jsonb)

ingest_ledger(id, source_path, source_kind, content_hash unique,
              sessions int, chunks int, secrets_found int,
              status text, ingested_at)         -- idempotence + audit

review_queue(id, proposed_fact jsonb, session_ref, created_at, resolved text null)
```

### 4.2 Qdrant

Collection `memory_archive`:
- dense vector: size = embedding model dims (Q1), cosine
- sparse vector: BM25-style (Qdrant sparse), for the hybrid leg
- payload: `{session_id, source_tool, device, project, ts, turn_range, text,
  content_hash}`; payload indexes on `source_tool`, `project`, `ts`

Chunking: never split a turn mid-thought; merge small turns; target ~512 tokens,
1-turn overlap; code blocks kept intact up to 2× target.

---

## 5. MCP surface (v1)

Four tools, three resources. Descriptions written for the model, per builder rules.

| Tool | Inputs | Behavior |
|---|---|---|
| `remember` | `statement` (req), `category`, `entities[]` | Writes an **active fact** with `source:'user'`, confidence 1.0. Returns fact id. Supersede-aware: if it contradicts an existing fact (same entities+category, LLM-checked), old fact → `superseded`. |
| `search_memory` | `query` (req), `category?`, `limit≤20` | Facts layer only. Hybrid: pg full-text + embedding rerank. Fast (<300 ms target); the default lookup. Description tells the model to use this **first**. |
| `search_archive` | `query` (req), `source_tool?`, `project?`, `after?/before?`, `limit≤10` | Episodic layer. Qdrant hybrid (dense+sparse, RRF fusion). Returns chunks with session refs + dates. Description: use only when facts don't answer, or when the user asks "what did we discuss/decide". |
| `forget` | `fact_id?` or `query+confirm:true` | Hard delete. By id: immediate. By query: first call returns matches + `confirm` requirement; second call with `confirm:true` deletes facts AND tombstones matching archive chunks. Annotated destructive. |

Resources: `memory://stats` (counts, last ingest), `memory://facts/recent`
(last 50 active facts — the "profile" a client can attach), `memory://facts/{id}`.

Explicitly **not** in v1: an auto-injected "context for every conversation" tool.
Clients attach `memory://facts/recent` deliberately. Prevents context pollution.

---

## 6. Retrieval design

- Embeddings via aigate (`OPENAI_BASE_URL=http://aigate:.../v1`), model per Q1
  (default proposal: **bge-m3** served on vLLM — 1024 dims, multilingual (BG+EN
  sessions), proven in this exact role; alternative: Qwen3-Embedding if it benches
  better on the golden set).
- Hybrid = dense + sparse, fused with RRF; optional rerank of top-30 via a local
  reranker later (out of v1 unless golden-set results demand it).
- The golden set (evals/golden.yaml) is written **by hand, first** — 30–50 real
  queries ("what did I decide about Klaro vs tarteaucitron", "FXIFY deal terms",
  "how did I fix the ext4 journal abort") with known source sessions. Every
  retrieval change is measured against it. This is the project's real acceptance
  criterion; everything else is plumbing.

---

## 7. Ingestion & distillation

**Sources v1:** ChatGPT export zip, Claude export, Claude Code JSONL, OpenCode
sessions, loose markdown. Each parser emits the normalized `Session{turns[]}` model;
everything downstream is source-agnostic. Adding a source = one parser file.

**Transport from devices:** dumb and reliable — a Syncthing (or rsync) folder per
device into `/srv/memory/inbox/<device>/`. `memoryctl ingest` scans the inbox,
skips ledger-known hashes, processes new files, moves them to `archive/` on success
or `quarantine/` on scrub failure. Cron/systemd-timer daily; manual runs anytime.

**Scrubbing (mandatory, fail-closed):** gitleaks over every normalized session +
custom regexes (broker API keys, MT5 creds, WG keys, SMTP). Findings → chunk
redacted (`[REDACTED:type]`) before embedding; count recorded in ledger. A session
that fails scrubbing entirely (parse-breaking) quarantines, never partially ingests.

**Distillation:** `memoryctl distill` walks un-distilled sessions, prompts Gemma
(via aigate) to extract candidate facts with category+entities+confidence.
Candidates land in `review_queue` — **nothing distilled becomes an active fact
without approval** (`memoryctl review` TUI: approve/edit/reject). Rationale: auto-
approved LLM facts silently rot the high-trust layer; the queue keeps distillation
cheap to run and safe to trust. Revisit auto-approval above a confidence threshold
only after a month of precision data (Q7).

---

## 8. Configuration

| Var | Req | Purpose |
|---|---|---|
| `DATABASE_URL` | ✔ | Postgres (container in this compose) |
| `QDRANT_URL` | ✔ | existing Qdrant instance on the host |
| `AIGATE_BASE_URL` / `AIGATE_API_KEY` | ✔ | embeddings + distillation LLM |
| `EMBED_MODEL` / `EMBED_DIMS` | ✔ | pinned; changing dims = new collection + re-embed (memoryctl reembed) |
| `DISTILL_MODEL` | ✔ | e.g. `gemma-4-26b` route name in aigate |
| `LISTEN` | ✔ | `<WG-IP>:7105` — WG interface only |
| `AUTH_MODE` | ✔ | `static` (v1) / `gateway-jwt` (post-integration) |
| `STATIC_BEARER` | v1 | random 32B; replaced by gateway-provided JWT verification later |
| `INBOX_DIR`, `MAX_RESULT_KB` | – | defaults `/srv/memory/inbox`, 50 |

Compose notes (arm64 host): all images must be arm64 —
`node:22-bookworm-slim`, `postgres:17`, `gitleaks` (arm64 release binary baked into
the CLI image) all publish arm64. Qdrant and aigate are **external** services on the
existing network, referenced not redeclared. No GPU device requests anywhere in this
stack.

---

## 9. Incremental steps

Order and verification only; each step green before the next.

**Step 1 — Scaffold + stores.**
Monorepo, Postgres container + migrations, Qdrant collection creation
(idempotent init), ledger.
*Verify:* `memoryctl verify` reports schema version, collection dims, and
connectivity to Qdrant + aigate from inside the container network; re-running init
changes nothing.

**Step 2 — Embedding + chunking.**
aigate embeddings client, chunker with fixture sessions.
*Verify:* golden fixture (one long Claude Code session, one ChatGPT thread) chunks
to expected boundaries (snapshot test); embed round-trip returns `EMBED_DIMS`
vectors; a deliberately oversized code block stays intact.

**Step 3 — Ingestion pipeline.**
All five parsers → normalize → scrub → chunk → embed → upsert + ledger.
*Verify:* ingest real exports from at least 3 tools; ledger counts match; re-run is
a no-op (hash dedupe); a planted fake API key in a fixture arrives in Qdrant as
`[REDACTED:...]` and increments `secrets_found`; malformed file → quarantine, exit
non-zero, nothing partial in stores.

**Step 4 — Retrieval + golden harness.**
Hybrid search, RRF fusion, `evals/` runner. Write golden.yaml from your own
memorable queries **before** tuning.
*Verify:* `pnpm eval` prints recall@5 / MRR / p95 latency; recall@5 ≥ 0.8 on the
golden set (tune chunking/fusion until true, or document why a query is
unreachable); results include correct session refs and dates.

**Step 5 — Facts layer + distillation.**
Facts CRUD, supersede logic, distill → review queue → approve flow.
*Verify:* distilling the fixture sessions proposes plausible facts (manual review);
approving activates them and `search_memory` finds them; a `remember` that
contradicts an active fact supersedes it with the old id retained; nothing enters
`facts` as active without `source:'user'` or an approval.

**Step 6 — MCP server.**
Four tools + three resources over memory-core; static bearer; healthz; tool-list
snapshot test.
*Verify:* MCP Inspector over WG: all four tools round-trip against real data;
`forget` by query demands confirmation on first call and deletes on second, with
the chunk verifiably gone from Qdrant; unauthenticated request → 401; tools/list
snapshot committed.

**Step 7 — Deployment.**
compose.prod.yaml, WG-only bind, systemd timer for ingest+distill, backup
(pg_dump + Qdrant snapshot to an off-host target, nightly).
*Verify:* cold start from compose alone on the host (arm64 images confirmed by
`docker image inspect`); `curl` initialize from the svc host over WG succeeds; from
the LAN's public side, connection refused; restore drill: rebuild stores from last
night's backup on a second host and re-run `pnpm eval` — scores match.

**Step 8 — Gateway integration** *(blocks on an internal MCP gateway existing)*.
Swap `AUTH_MODE=gateway-jwt` for the gateway's JWT verification, add `memory:` to
the gateway's tool catalog with prefix `memory_`, new `/memory` endpoint, an
appropriate auth scope.
*Verify:* full path — client → gateway `/memory` endpoint → OAuth → tool call →
audit row in the gateway's own store; direct WG call without a gateway JWT now
401; `memory_*` tools appear correctly scoped in the gateway's tool catalog.

---

## 10. Security posture

- Never internet-reachable directly; WG bind + (v1) static bearer, (v2) gateway JWT.
- Scrubbing is fail-closed and runs **before** anything is embedded or stored.
- `forget` is a hard delete in both stores, not a soft flag (this is personal data;
  deletion must mean deletion). Backups age out on a 14-day window so a forget
  eventually propagates (Q8).
- Distilled facts quarantined behind human review; archive chunks are data, and the
  MCP result shaping wraps them in delimited blocks — old sessions can contain
  instruction-like text and must be treated as untrusted data, same as any other
  MCP tool result.
- The archive is the most sensitive dataset you will host. It lives only on this
  host plus an encrypted backup target; it is not exposed as a publicly discoverable
  capability.

---

## Questions

1. **Embedding model** — bge-m3 on vLLM is the default proposal (1024 dims,
   multilingual for BG/EN). Do you want to bench Qwen3-Embedding against it on the
   golden set in Step 4, or standardize on bge-m3 and move on?
2. **Postgres placement** — spec assumes a new Postgres 17 container in this compose
   on the host (self-contained, backup to an off-host target). Alternative: reuse an
   existing Postgres elsewhere on the network over WG (one less container, but
   memory becomes cross-host-dependent). Confirm local.
3. **Device sync** — Syncthing folder-per-device into the inbox, or do you prefer
   rsync/cron from each device? (Syncthing assumed; it also covers the Windows
   workstation cleanly.)
4. **Source priority** — which export do you want working first for Step 3's real-
   data verification: Claude Code JSONL (richest, local), ChatGPT zip, or OpenCode?
5. **Obsidian vault export** — `memoryctl export-vault` writing active facts as
   markdown into a git-synced vault: include in v1 (Step 5) or defer? (Cheap if the
   facts schema is final; deferring costs nothing architecturally.)
6. **ChatGPT history cadence** — there's no API for chat history, so ingest depends
   on you periodically requesting the data export. Acceptable as a monthly manual
   ritual, or should ChatGPT be treated as archive-only backfill (one-time import)?
7. **Review queue tolerance** — is a weekly `memoryctl review` session realistic for
   you? If not, say so now and Step 5 adds auto-approve above confidence 0.9 from
   the start (with a `source:'distilled-auto'` marker so it's filterable later).
8. **Forget vs backups** — 14-day backup retention means a forgotten item survives
   in backups up to 14 days. Acceptable, or do you want `forget` to also trigger
   selective backup rewrite (significant extra complexity)?
9. **Server naming** — `memory-mcp` as repo/container name, catalog key `memory`,
   prefix `memory_`, endpoint `/memory` — confirm these don't collide with other
   services' naming conventions, so Step 6's snapshot locks the right names.
10. **Second host** — used here only as the restore-drill target (Step 7). Any
    desire for warm standby of the memory stack on it, or is nightly backup +
    manual restore sufficient for personal data?
