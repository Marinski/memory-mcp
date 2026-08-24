import { describe, it, expect } from 'vitest';
import { bearerToken, checkStaticBearer, assertAuthModeSupported } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { fakeDeps, testConfig } from './helpers.js';
import type { AddressInfo } from 'node:net';

describe('auth primitives', () => {
  it('parses bearer headers', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('constant-time compares tokens', () => {
    expect(checkStaticBearer('secret-token-abcdef', 'secret-token-abcdef')).toBe(true);
    expect(checkStaticBearer('secret-token-abcdef', 'secret-token-abcdeX')).toBe(false);
    expect(checkStaticBearer('secret-token-abcdef', 'short')).toBe(false);
    expect(checkStaticBearer('secret-token-abcdef', null)).toBe(false);
  });

  it('refuses gateway-jwt until the gateway exists', () => {
    expect(() => assertAuthModeSupported({ ...testConfig, authMode: 'gateway-jwt' })).toThrow(/gateway/);
    expect(() => assertAuthModeSupported(testConfig)).not.toThrow();
  });
});

describe('http auth', () => {
  it('401s unauthenticated /mcp requests; healthz stays open', async () => {
    const app = createApp(fakeDeps());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);

      const unauth = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });
      expect(unauth.status).toBe(401);

      const badToken = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token-000000000000' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });
      expect(badToken.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
