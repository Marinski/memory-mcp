export { loadConfig, type MemoryConfig } from './config.js';
export { createPool, type Pool } from './db/pool.js';
export { migrate } from './db/migrate.js';
export * from './db/facts.js';
export * from './db/ledger.js';
export { createQdrantClient, chunkPointId, type QdrantClient, type ChunkPayload, type ArchiveFilter, type ArchiveHit } from './vector/qdrant.js';
export { createEmbedder, type Embedder } from './vector/embed.js';
export { sparseVector, tokenize, fnv1a, type SparseVector } from './vector/sparse.js';
export { chunkSession, splitOversizedText, estimateTokens, TARGET_TOKENS, type Chunk } from './vector/chunker.js';
export { tidySession, type Session, type Turn, type SourceTool } from './ingest/normalize.js';
export { parsers, detectSourceKind, parseChatgpt, parseClaude, parseClaudeCode, parseOpencode, parseMarkdown } from './ingest/parsers/index.js';
export { scrubSession, redactWithRules, type ScrubResult } from './ingest/scrub.js';
export { ingestFile, ingestInbox, type IngestDeps, type IngestFileResult } from './ingest/pipeline.js';
export { searchMemory, searchArchive, shapeArchiveResults, type MemoryHit, type ArchiveResult } from './search.js';
export { forgetByFactId, previewForgetByQuery, executeForgetByQuery, type ForgetPreview, type ForgetOutcome } from './forget.js';
export { createLlmClient, extractJson, type LlmClient } from './distill/llm.js';
export { distillPending, validateProposals, type ProposedFact, type DistillDeps, type DistillReport } from './distill/extract.js';
export {
  pendingReviews,
  approveReview,
  rejectReview,
  reviewQueueCount,
  type ReviewItem,
  type ApproveResult,
} from './distill/review.js';
export { triagePending, type TriageReport } from './distill/triage.js';
export { remember, checkSupersedes, type RememberResult } from './remember.js';
export { memoryStats, type MemoryStats } from './stats.js';
export {
  findDuplicateEntities,
  applyEntityMerges,
  groupCandidates,
  validateMerges,
  type EntityMergeProposal,
  type EntityDedupeReport,
  type EntityDedupeFailure,
} from './dedupe-entities.js';
