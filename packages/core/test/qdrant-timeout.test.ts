import { describe, it, expect, vi } from 'vitest';
import { createQdrantClient, QDRANT_HYBRID_TIMEOUT_MS, QDRANT_SCROLL_TIMEOUT_MS } from '../src/vector/qdrant.js';

describe('QDRANT_HYBRID_TIMEOUT_MS', () => {
  it('aborts a never-resolving queryHybrid after the constant timeout', async () => {
    let abortFn: (() => void) | undefined;
    const mockTimeout = vi.fn((_ms: number) => {
      const controller = new AbortController();
      abortFn = () => controller.abort();
      return controller.signal;
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(mockTimeout as typeof AbortSignal.timeout);

    try {
      let capturedSignal: AbortSignal | undefined;
      const neverResolves = vi.fn((_url: string, init: RequestInit) => {
        capturedSignal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });
      const client = createQdrantClient('http://qdrant:6333', 'test', 4, neverResolves as unknown as typeof fetch);
      const hybridPromise = client.queryHybrid([0, 0, 0, 0], { indices: [], values: [] }, 5);

      expect(mockTimeout).toHaveBeenCalledWith(QDRANT_HYBRID_TIMEOUT_MS);

      abortFn!();

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
      await expect(hybridPromise).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('QDRANT_SCROLL_TIMEOUT_MS', () => {
  it('aborts a never-resolving scrollBySession after the constant timeout', async () => {
    let abortFn: (() => void) | undefined;
    const mockTimeout = vi.fn((_ms: number) => {
      const controller = new AbortController();
      abortFn = () => controller.abort();
      return controller.signal;
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(mockTimeout as typeof AbortSignal.timeout);

    try {
      let capturedSignal: AbortSignal | undefined;
      const neverResolves = vi.fn((_url: string, init: RequestInit) => {
        capturedSignal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });
      const client = createQdrantClient('http://qdrant:6333', 'test', 4, neverResolves as unknown as typeof fetch);
      const scrollPromise = client.scrollBySession('sess-1');

      expect(mockTimeout).toHaveBeenCalledWith(QDRANT_SCROLL_TIMEOUT_MS);

      abortFn!();

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
      await expect(scrollPromise).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('aborts a never-resolving recentSessions after the constant timeout', async () => {
    let abortFn: (() => void) | undefined;
    const mockTimeout = vi.fn((_ms: number) => {
      const controller = new AbortController();
      abortFn = () => controller.abort();
      return controller.signal;
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(mockTimeout as typeof AbortSignal.timeout);

    try {
      let capturedSignal: AbortSignal | undefined;
      const neverResolves = vi.fn((_url: string, init: RequestInit) => {
        capturedSignal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });
      const client = createQdrantClient('http://qdrant:6333', 'test', 4, neverResolves as unknown as typeof fetch);
      const recentPromise = client.recentSessions(10);

      expect(mockTimeout).toHaveBeenCalledWith(QDRANT_SCROLL_TIMEOUT_MS);

      abortFn!();

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
      await expect(recentPromise).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
