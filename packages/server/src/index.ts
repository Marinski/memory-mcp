import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  loadConfig,
  createPool,
  createQdrantClient,
  createEmbedder,
  createLlmClient,
} from '@memory/core';
import { buildMcpServer } from './mcp.js';
import { authMiddleware, assertAuthModeSupported } from './auth.js';
import type { ServerDeps } from './deps.js';

/**
 * Streamable HTTP bootstrap. Binds to LISTEN (WG interface only in
 * production). Stateless transport: each request creates a fresh
 * server+transport pair, which is the simplest correct mode for a
 * tools+resources surface with no server-initiated messages.
 */

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'memory-mcp' });
  });

  app.post('/mcp', authMiddleware(deps.cfg), async (req, res) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless transport: sessionless GET/DELETE are not applicable.
  app.get('/mcp', authMiddleware(deps.cfg), (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null });
  });
  app.delete('/mcp', authMiddleware(deps.cfg), (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null });
  });

  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertAuthModeSupported(cfg);
  const deps: ServerDeps = {
    cfg,
    pool: createPool(cfg.databaseUrl),
    qdrant: createQdrantClient(cfg.qdrantUrl, cfg.qdrantCollection, cfg.embedDims),
    embedder: createEmbedder(cfg),
    llm: createLlmClient(cfg),
  };
  const app = createApp(deps);
  const [host, portStr] = cfg.listen.split(':');
  const port = Number(portStr);
  if (!host || !Number.isInteger(port)) throw new Error(`LISTEN must be host:port, got '${cfg.listen}'`);
  app.listen(port, host, () => {
    console.log(`memory-mcp listening on ${host}:${port} (auth=${cfg.authMode})`);
  });
}

const isMain = process.argv[1]?.endsWith('index.js');
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
