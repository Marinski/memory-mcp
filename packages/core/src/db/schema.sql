-- memory-core schema, migration 001 (applied by migrate.ts; each numbered
-- statement block below is idempotent so re-running init changes nothing).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    int PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement     text NOT NULL,
  category      text NOT NULL CHECK (category IN ('preference','decision','fact','project','person')),
  entities      text[] NOT NULL DEFAULT '{}',
  confidence    real NOT NULL DEFAULT 1.0,
  source        text NOT NULL CHECK (source IN ('user','distilled','imported')),
  provenance    jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  superseded_by uuid NULL REFERENCES facts(id),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', statement)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facts_tsv_idx ON facts USING gin (tsv);
CREATE INDEX IF NOT EXISTS facts_status_idx ON facts (status);
CREATE INDEX IF NOT EXISTS facts_entities_idx ON facts USING gin (entities);

CREATE TABLE IF NOT EXISTS entities (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name    text NOT NULL UNIQUE,
  type    text NOT NULL DEFAULT 'other',
  aliases text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS relations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation    text NOT NULL,
  provenance  jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS ingest_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_path   text NOT NULL,
  source_kind   text NOT NULL,
  content_hash  text NOT NULL UNIQUE,
  sessions      int NOT NULL DEFAULT 0,
  chunks        int NOT NULL DEFAULT 0,
  secrets_found int NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('ingested','quarantined')),
  distilled_at  timestamptz NULL,
  ingested_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_sessions (
  ledger_id  uuid NOT NULL REFERENCES ingest_ledger(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  PRIMARY KEY (ledger_id, session_id)
);

CREATE TABLE IF NOT EXISTS review_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_fact jsonb NOT NULL,
  session_ref   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved      text NULL CHECK (resolved IN ('approved','rejected'))
);

INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
