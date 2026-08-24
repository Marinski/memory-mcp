import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x',
  QDRANT_URL: 'http://q:6333',
  AIGATE_BASE_URL: 'http://aigate:4000/v1/',
  AIGATE_API_KEY: 'k',
  EMBED_MODEL: 'bge-m3',
  EMBED_DIMS: '1024',
  DISTILL_MODEL: 'gemma-4-26b-a4b',
  LISTEN: '10.8.0.1:7105',
  AUTH_MODE: 'static',
  STATIC_BEARER: 'a-very-long-static-bearer-token',
};

describe('loadConfig', () => {
  it('loads a valid config and normalizes the aigate url', () => {
    const cfg = loadConfig(base as any);
    expect(cfg.aigateBaseUrl).toBe('http://aigate:4000/v1');
    expect(cfg.embedDims).toBe(1024);
    expect(cfg.qdrantCollection).toBe('memory_archive');
  });

  it('rejects missing required vars', () => {
    const { DATABASE_URL, ...rest } = base;
    expect(() => loadConfig(rest as any)).toThrow(/DATABASE_URL/);
  });

  it('rejects static auth without a real bearer', () => {
    expect(() => loadConfig({ ...base, STATIC_BEARER: 'short' } as any)).toThrow(/STATIC_BEARER/);
  });

  it('rejects unknown auth modes', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'none' } as any)).toThrow(/AUTH_MODE/);
  });
});
