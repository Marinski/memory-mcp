import type { MemoryConfig, Pool, QdrantClient, Embedder, LlmClient } from '@memory/core';

/** Everything the MCP surface needs; injected so tests can fake the stores. */
export interface ServerDeps {
  cfg: MemoryConfig;
  pool: Pool;
  qdrant: QdrantClient;
  embedder: Embedder;
  llm: LlmClient;
}
