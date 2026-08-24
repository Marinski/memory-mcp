/**
 * BM25-style sparse vectors for the hybrid leg. We emit term-frequency
 * weights; the Qdrant collection is configured with modifier "idf" so the
 * inverse-document-frequency part is computed server-side.
 */

export interface SparseVector {
  indices: number[];
  values: number[];
}

const STOP = new Set([
  'the','a','an','and','or','but','if','then','else','of','to','in','on','for',
  'with','is','are','was','were','be','it','this','that','i','you','we','at',
  'as','by','from','not','do','did','does','have','has','had','my','your',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1 && t.length < 40 && !STOP.has(t));
}

/** FNV-1a 32-bit — deterministic token -> u32 index mapping. */
export function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sparseVector(text: string): SparseVector {
  const tf = new Map<number, number>();
  for (const tok of tokenize(text)) {
    const idx = fnv1a(tok);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }
  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, n] of tf) {
    indices.push(idx);
    // BM25-ish TF saturation so long chunks don't dominate on raw counts.
    values.push(n / (n + 1.2));
  }
  return { indices, values };
}
