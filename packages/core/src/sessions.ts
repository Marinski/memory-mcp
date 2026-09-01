import type { QdrantClient, RecentSession } from './vector/qdrant.js';

export interface RecentSessionsOpts {
  project?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/** Most recent archive sessions, newest last_ts first. Delegates to the qdrant client's bounded scroll. */
export async function listRecentSessions(
  qdrant: QdrantClient,
  opts: RecentSessionsOpts = {},
): Promise<RecentSession[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  return qdrant.recentSessions(limit, opts.project);
}