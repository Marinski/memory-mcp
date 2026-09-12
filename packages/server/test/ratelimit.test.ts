import { describe, it, expect } from 'vitest';
import { createApp } from '../src/index.js';
import { fakeDeps } from './helpers.js';
import type { AddressInfo } from 'node:net';

async function listen(app: ReturnType<typeof createApp>): Promise<{ port: number; close: () => void }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => server.close() };
}

describe('mcp request limits', () => {
  it('429s with a JSON-RPC error body after 120 requests per minute per IP', async () => {
    const { port, close } = await listen(createApp(fakeDeps()));
    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
      let last: Response | undefined;
      for (let i = 0; i <= 120; i++) {
        last = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (i === 0) expect(last.status).toBe(401);
      }
      expect(last!.status).toBe(429);
      expect(await last!.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Too Many Requests' },
        id: null,
      });
    } finally {
      close();
    }
  });

  it('rejects request bodies over the 128kb limit', async () => {
    const { port, close } = await listen(createApp(fakeDeps()));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 'x'.repeat(200 * 1024) }),
      });
      expect(res.status).toBe(413);
    } finally {
      close();
    }
  });
});