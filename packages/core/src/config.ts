/**
 * Typed configuration layer. All environment access happens here; the rest of
 * the codebase receives a validated MemoryConfig object.
 */

export interface MemoryConfig {
  databaseUrl: string;
  qdrantUrl: string;
  qdrantCollection: string;
  aigateBaseUrl: string;
  aigateApiKey: string;
  embedModel: string;
  embedDims: number;
  distillModel: string;
  listen: string; // host:port, WG interface only in production
  authMode: 'static' | 'gateway-jwt';
  staticBearer: string | undefined;
  inboxDir: string;
  maxResultKb: number;
  /** Absolute path to the gitleaks binary. Scrubbing is fail-closed: ingest
   *  refuses to run when the binary is missing unless this is set to 'off'
   *  explicitly (test/dev only). */
  gitleaksPath: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const authMode = required(env, 'AUTH_MODE');
  if (authMode !== 'static' && authMode !== 'gateway-jwt') {
    throw new Error(`AUTH_MODE must be 'static' or 'gateway-jwt', got '${authMode}'`);
  }
  const embedDims = Number(required(env, 'EMBED_DIMS'));
  if (!Number.isInteger(embedDims) || embedDims <= 0) {
    throw new Error(`EMBED_DIMS must be a positive integer`);
  }
  const staticBearer = env.STATIC_BEARER;
  if (authMode === 'static' && (!staticBearer || staticBearer.length < 16)) {
    throw new Error('STATIC_BEARER (>=16 chars) is required when AUTH_MODE=static');
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    qdrantUrl: required(env, 'QDRANT_URL'),
    qdrantCollection: env.QDRANT_COLLECTION ?? 'memory_archive',
    aigateBaseUrl: required(env, 'AIGATE_BASE_URL').replace(/\/+$/, ''),
    aigateApiKey: required(env, 'AIGATE_API_KEY'),
    embedModel: required(env, 'EMBED_MODEL'),
    embedDims,
    distillModel: required(env, 'DISTILL_MODEL'),
    listen: required(env, 'LISTEN'),
    authMode,
    staticBearer,
    inboxDir: env.INBOX_DIR ?? '/srv/memory/inbox',
    maxResultKb: Number(env.MAX_RESULT_KB ?? 50),
    gitleaksPath: env.GITLEAKS_PATH ?? 'gitleaks',
  };
}
