import { describe, it, expect } from 'vitest';
import { createApp } from '../src/index.js';
import { fakeDeps } from './helpers.js';
import type { AddressInfo } from 'node:net';

describe('security headers', () => {
  it('sets X-Content-Type-Options: nosniff on every response', async () => {
    const server = createApp(fakeDeps()).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      server.close();
    }
  });
});
