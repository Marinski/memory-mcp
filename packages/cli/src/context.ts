import {
  loadConfig,
  createPool,
  createQdrantClient,
  createEmbedder,
  createLlmClient,
  type MemoryConfig,
  type Pool,
  type QdrantClient,
  type Embedder,
  type LlmClient,
} from '@memory/core';

export interface CliContext {
  cfg: MemoryConfig;
  pool: Pool;
  qdrant: QdrantClient;
  embedder: Embedder;
  llm: LlmClient;
}

export function createContext(): CliContext {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const qdrant = createQdrantClient(cfg.qdrantUrl, cfg.qdrantCollection, cfg.embedDims);
  const embedder = createEmbedder(cfg);
  const llm = createLlmClient(cfg);
  return { cfg, pool, qdrant, embedder, llm };
}
