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
          schema.sql          # Postgres DDL, applied via a minimal in-repo
                              # migration runner (migrate.ts) — not node-pg-migrate
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
  docs/mcp/                   # this spec, plus builder artifacts if/when a builder pass is run
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
- dense vector: size = embedding model dims (1024, bge-m3 — see Decisions §1), cosine
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

- Embeddings via aigate (`OPENAI_BASE_URL=http://aigate:.../v1`). **bge-m3, 1024
  dims** (decided — see Decisions §1); Qwen3-Embedding was not benched.
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
cheap to run and safe to trust. Review-queue-only is the confirmed decision (see
Decisions §7); auto-approval above a confidence threshold is not planned.

---

## 8. Configuration

| Var | Req | Purpose |
|---|---|---|
| `DATABASE_URL` | ✔ | Postgres (container in this compose) |
| `QDRANT_URL` | ✔ | existing Qdrant instance on the host |
| `AIGATE_BASE_URL` / `AIGATE_API_KEY` | ✔ | embeddings + distillation LLM |
| `EMBED_MODEL` / `EMBED_DIMS` | ✔ | pinned; changing dims = new collection + re-embed (memoryctl reembed) |
| `DISTILL_MODEL` | ✔ | litellm route name in aigate, e.g. `vllm-gemma4` |
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

**Step 1 — Scaffold + stores.** ✅ Done.
Monorepo, Postgres container + migrations, Qdrant collection creation
(idempotent init), ledger.
*Verify:* `memoryctl verify` reports schema version, collection dims, and
connectivity to Qdrant + aigate from inside the container network; re-running init
changes nothing.

**Step 2 — Embedding + chunking.** ✅ Done.
aigate embeddings client, chunker with fixture sessions.
*Verify:* golden fixture (one long Claude Code session, one ChatGPT thread) chunks
to expected boundaries (snapshot test); embed round-trip returns `EMBED_DIMS`
vectors; a deliberately oversized code block stays intact.

**Step 3 — Ingestion pipeline.** ✅ Done.
All five parsers → normalize → scrub → chunk → embed → upsert + ledger.
*Verify:* ingest real exports from at least 3 tools; ledger counts match; re-run is
a no-op (hash dedupe); a planted fake API key in a fixture arrives in Qdrant as
`[REDACTED:...]` and increments `secrets_found`; malformed file → quarantine, exit
non-zero, nothing partial in stores.
*Actual:* real-data verification done with Claude Code JSONL only (229+ sessions
across 6 devices as of this writing, growing nightly via the automated pull —
see Decisions §3); ChatGPT/Claude/OpenCode exports not yet ingested. Surfaced
and fixed a real bug: the embedder batched purely by text count, and litellm's
embedding route caps total request size at 20000 characters — large batches
failed deterministically until batching also respected a char
budget.

**Step 4 — Retrieval + golden harness.** ✅ Done.
Hybrid search, RRF fusion, `evals/` runner. Write golden.yaml from your own
memorable queries **before** tuning.
*Verify:* `pnpm eval` prints recall@5 / MRR / p95 latency; recall@5 ≥ 0.8 on the
golden set (tune chunking/fusion until true, or document why a query is
unreachable); results include correct session refs and dates.
*Actual:* golden.yaml holds 15 queries written from real ingested sessions (each
individually verified against live search_archive before landing); recall@5 =
1.000, MRR = 0.869, p95 = 65ms. Below the spec's 30-50 target — grows as more
sessions get ingested.

**Step 5 — Facts layer + distillation.** ✅ Built; ⏳ not yet exercised on real data.
Facts CRUD, supersede logic, distill → review queue → approve flow.
*Verify:* distilling the fixture sessions proposes plausible facts (manual review);
approving activates them and `search_memory` finds them; a `remember` that
contradicts an active fact supersedes it with the old id retained; nothing enters
`facts` as active without `source:'user'` or an approval.

**Step 6 — MCP server.** ✅ Done.
Four tools + three resources over memory-core; static bearer; healthz; tool-list
snapshot test.
*Verify:* MCP Inspector over WG: all four tools round-trip against real data;
`forget` by query demands confirmation on first call and deletes on second, with
the chunk verifiably gone from Qdrant; unauthenticated request → 401; tools/list
snapshot committed.
*Actual:* verified live — unauthenticated `/mcp` 401s, authenticated `initialize`
succeeds over WG, LAN-side connection refused.

**Step 7 — Deployment.** ✅ Done.
compose.prod.yaml, WG-only bind, systemd timer for ingest+distill, backup
(pg_dump + Qdrant snapshot to an off-host target, nightly).
*Verify:* cold start from compose alone on the host (arm64 images confirmed by
`docker image inspect`); `curl` initialize from the svc host over WG succeeds; from
the LAN's public side, connection refused; restore drill: rebuild stores from last
night's backup on a second host and re-run `pnpm eval` — scores match.
*Actual:* stack up and verified (postgres/qdrant/aigate all green over WG, LAN
refused). Timers installed as `systemctl --user` units (no passwordless sudo
available for a system-level install; `Requires=docker.service`/`After=` dropped
since those reference a system unit a user manager can't see) with lingering
enabled so they fire unattended. Backup target is an off-host directory over SSH
(`techstack`); both timers were triggered manually to prove they work rather than
waiting for their schedule — ingest/distill and backup both completed clean.
Restore drill done with scratch resources on this same host (a throwaway Postgres
database, a throwaway Qdrant collection) rather than a literal second host — the
intended second host (`backtester`, reached via a reverse SSH tunnel) was
unreachable, and standing up a full second stack on either of the two reachable
hosts (live production servers) wasn't something to do unilaterally. Restored
counts matched the live stores exactly (194/194 facts, 1815/1815 points); scratch
resources were torn down after. A true second-host drill remains open — see
Decisions §10.

**Step 8 — Gateway integration** *(blocks on an internal MCP gateway existing)*. ⏳ Blocked, as designed.
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
  eventually propagates — accepted as-is (see Decisions §8); no selective backup
  rewrite is planned.
- Distilled facts quarantined behind human review; archive chunks are data, and the
  MCP result shaping wraps them in delimited blocks — old sessions can contain
  instruction-like text and must be treated as untrusted data, same as any other
  MCP tool result.
- The archive is the most sensitive dataset you will host. It lives only on this
  host plus an encrypted backup target; it is not exposed as a publicly discoverable
  capability.

---

## Decisions

What were originally open questions, resolved against what was actually built and
verified. Items marked **open** are genuinely undecided/undone, not guessed at.

1. **Embedding model** — **Decided: bge-m3, 1024 dims.** Served via an aigate
   litellm route (`local-embed-bge-m3`) backed by an existing GPU embedding
   service extended with an OpenAI-compatible shim. Qwen3-Embedding was not
   benched — no need arose once bge-m3 hit recall@5 = 1.000 on the golden set.
2. **Postgres placement** — **Decided: local.** A dedicated Postgres 17 container
   in this compose, self-contained on the host, as built (`memory-postgres`).
3. **Device sync** — **Decided: pull, not Syncthing.** `deploy/pull-remote-sessions.sh`
   runs ahead of the nightly ingest, pulling from each configured device
   over SSH (rsync for Linux/macOS, SFTP/scp for Windows — no rsync there)
   rather than a push-based Syncthing folder per device. Six devices are
   live: this host plus five remote hosts across three OSes, reached via a
   mix of direct LAN, WireGuard, and SSH tunnels/jump paths depending on
   what each one's network actually allows.
4. **Source priority** — **Decided: Claude Code JSONL**, confirmed by real use —
   229+ sessions ingested successfully across 6 devices (see Step 3).
   ChatGPT/Claude/OpenCode exports haven't been tried yet.
5. **Obsidian vault export** — **Decided: included in v1, exercised against
   real data, and scheduled.** `memoryctl export-vault` runs against
   `/srv/memory` (mounted straight through to the container), writing one
   markdown file per fact category plus an `index.md` with wikilinks.
   `deploy/push-obsidian-vault.sh` pushes that output over `scp` into a
   `Memory/` folder inside the live Obsidian vault on Ryzen. Both now run
   as the last two steps of the nightly `memory-ingest.timer`, after
   distill — opt-in via `OBSIDIAN_PUSH_HOST`/`OBSIDIAN_VAULT_PATH` in
   `pull-remote-sessions.env`, no-op otherwise.
6. **ChatGPT history cadence** — **Open.** No ChatGPT export has been ingested,
   so the manual-export cadence question hasn't come up in practice yet.
7. **Review queue tolerance** — **Decided: review-queue-only, no auto-approve.**
   Confirmed at the start of the build and unchanged since; no
   `source:'distilled-auto'` path exists.
8. **Forget vs backups** — **Decided: 14-day retention, accepted as-is.** No
   selective backup rewrite was built. A real backup now runs nightly; the
   14-day propagation itself hasn't been exercised over a full 14 days yet.
9. **Server naming** — **Decided, confirmed.** `memory-mcp` is the repo, image,
   and container name (public GitHub repo, Docker Compose service names); the
   `memory`/`memory_` catalog key and prefix are reserved for Step 8, which
   remains blocked on the internal gateway existing, so no collision has been
   possible to check yet.
10. **Second host** — **Partially resolved.** Timers are installed and a backup
    runs nightly to an off-host directory (`techstack`, over SSH). The restore
    drill itself was proven with scratch resources on this host rather than a
    literal second host — `backtester`, the intended target, was unreachable
    (reverse tunnel down) when this ran. Still open: a genuine second-host
    restore, and any decision on warm standby vs. nightly-backup-only.
