import { createHash } from 'node:crypto';
import type { SparseVector } from './sparse.js';

/**
 * Thin typed REST client for Qdrant — only the operations memory-core needs.
 * Collection layout: named dense vector 'dense' (cosine) + named sparse
 * vector 'sparse' with server-side IDF modifier; hybrid queries fuse both
 * legs with RRF inside Qdrant.
 */

export interface ChunkPayload {
  session_id: string;
  source_tool: string;
  device?: string;
  project?: string;
  ts?: number;
  turn_range: string;
  text: string;
  content_hash: string;
  [key: string]: unknown;
}

export interface ArchiveHit {
  id: string;
  score: number;
  payload: ChunkPayload;
}

export interface ArchiveFilter {
  source_tool?: string;
  project?: string;
  after?: number;
  before?: number;
  session_id?: string;
}

export interface QdrantClient {
  ensureCollection(): Promise<{ created: boolean; dims: number }>;
  collectionInfo(): Promise<{ dims: number; points: number }>;
  upsert(points: { id: string; dense: number[]; sparse: SparseVector; payload: ChunkPayload }[]): Promise<void>;
  queryHybrid(dense: number[], sparse: SparseVector, limit: number, filter?: ArchiveFilter): Promise<ArchiveHit[]>;
  deletePoints(ids: string[]): Promise<void>;
  deleteBySession(sessionId: string): Promise<void>;
  /** All chunks of one session, ordered by chunk index (point payloads). */
  scrollBySession(sessionId: string): Promise<{ id: string; payload: ChunkPayload }[]>;
  count(): Promise<number>;
}

/** Deterministic point id so re-ingesting the same content is an upsert no-op. */
interface QdrantCollectionInfo {
  result?: {
    points_count?: number;
    config?: { params?: { vectors?: { dense?: { size?: number } } } };
  };
}
interface QdrantQueryResponse {
  result: { points: { id: string | number; score: number; payload: ChunkPayload }[] };
}
interface QdrantScrollResponse {
  result: {
    points: { id: string | number; payload: ChunkPayload }[];
    next_page_offset?: string | number | null;
  };
}
interface QdrantCountResponse {
  result: { count: number };
}

export function chunkPointId(contentHash: string, chunkIndex: number): string {
  const h = createHash('sha256').update(`${contentHash}:${chunkIndex}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function qdrantFilter(f?: ArchiveFilter): unknown {
  if (!f) return undefined;
  const must: unknown[] = [];
  if (f.source_tool) must.push({ key: 'source_tool', match: { value: f.source_tool } });
  if (f.project) must.push({ key: 'project', match: { value: f.project } });
  if (f.session_id) must.push({ key: 'session_id', match: { value: f.session_id } });
  if (f.after !== undefined || f.before !== undefined) {
    must.push({ key: 'ts', range: { gte: f.after, lte: f.before } });
  }
  return must.length ? { must } : undefined;
}

export function createQdrantClient(
  baseUrl: string,
  collection: string,
  dims: number,
  fetchImpl: typeof fetch = fetch,
): QdrantClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`qdrant ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  return {
    async ensureCollection() {
      const probe = await fetchImpl(`${base}/collections/${collection}`);
      if (probe.ok) {
        const info = (await probe.json()) as QdrantCollectionInfo;
        const existing = info.result?.config?.params?.vectors?.dense?.size;
        if (existing !== dims) {
          throw new Error(
            `collection '${collection}' exists with dims ${existing}, config says ${dims} — run 'memoryctl reembed' after changing EMBED_DIMS`,
          );
        }
        return { created: false, dims };
      }
      await req('PUT', `/collections/${collection}`, {
        vectors: { dense: { size: dims, distance: 'Cosine' } },
        sparse_vectors: { sparse: { modifier: 'idf' } },
      });
      for (const field of [
        { name: 'source_tool', schema: 'keyword' },
        { name: 'project', schema: 'keyword' },
        { name: 'session_id', schema: 'keyword' },
        { name: 'ts', schema: 'integer' },
      ]) {
        await req('PUT', `/collections/${collection}/index?wait=true`, {
          field_name: field.name,
          field_schema: field.schema,
        });
      }
      return { created: true, dims };
    },

    async collectionInfo() {
      const info = await req<QdrantCollectionInfo>('GET', `/collections/${collection}`);
      const dims = info.result?.config?.params?.vectors?.dense?.size;
      if (dims === undefined) throw new Error(`collection '${collection}' has no dense vector config`);
      return { dims, points: info.result?.points_count ?? 0 };
    },

    async upsert(points) {
      await req('PUT', `/collections/${collection}/points?wait=true`, {
        points: points.map((p) => ({
          id: p.id,
          vector: { dense: p.dense, sparse: p.sparse },
          payload: p.payload,
        })),
      });
    },

    async queryHybrid(dense, sparse, limit, filter) {
      const body = await req<QdrantQueryResponse>('POST', `/collections/${collection}/points/query`, {
        prefetch: [
          { query: dense, using: 'dense', limit: Math.max(limit * 3, 30), filter: qdrantFilter(filter) },
          { query: sparse, using: 'sparse', limit: Math.max(limit * 3, 30), filter: qdrantFilter(filter) },
        ],
        query: { fusion: 'rrf' },
        limit,
        with_payload: true,
      });
      return body.result.points.map((p) => ({
        id: String(p.id),
        score: p.score,
        payload: p.payload,
      }));
    },

    async deletePoints(ids) {
      if (ids.length === 0) return;
      await req('POST', `/collections/${collection}/points/delete?wait=true`, { points: ids });
    },

    async deleteBySession(sessionId) {
      await req('POST', `/collections/${collection}/points/delete?wait=true`, {
        filter: { must: [{ key: 'session_id', match: { value: sessionId } }] },
      });
    },

    async scrollBySession(sessionId) {
      const out: { id: string; payload: ChunkPayload }[] = [];
      let offset: string | number | null | undefined = undefined;
      for (;;) {
        const body: QdrantScrollResponse = await req('POST', `/collections/${collection}/points/scroll`, {
          filter: { must: [{ key: 'session_id', match: { value: sessionId } }] },
          with_payload: true,
          limit: 100,
          offset,
        });
        for (const p of body.result.points) {
          out.push({ id: String(p.id), payload: p.payload });
        }
        offset = body.result.next_page_offset;
        if (offset === null || offset === undefined) break;
      }
      // turn_range "3-7" sorts fine numerically on its first number
      out.sort((a, b) => parseInt(a.payload.turn_range, 10) - parseInt(b.payload.turn_range, 10));
      return out;
    },

    async count() {
      const body = await req<QdrantCountResponse>('POST', `/collections/${collection}/points/count`, { exact: true });
      return body.result.count;
    },
  };
}
