import type { Request, Response, NextFunction } from 'express';
import type { MemoryConfig } from '@memory/core';
import { timingSafeEqual } from 'node:crypto';

/**
 * v1 auth: static bearer over the WG-only bind. AUTH_MODE=gateway-jwt is
 * reserved for a future internal MCP gateway integration (Step 8) and
 * refuses to start until that gateway's JWT verification is wired in.
 */

export function assertAuthModeSupported(cfg: MemoryConfig): void {
  if (cfg.authMode === 'gateway-jwt') {
    throw new Error(
      'AUTH_MODE=gateway-jwt requires an internal MCP gateway integration that does not exist yet; use AUTH_MODE=static until Step 8',
    );
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export function checkStaticBearer(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authMiddleware(cfg: MemoryConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req.headers.authorization);
    // Fail closed: a missing configured bearer can never authorize anyone.
    if (!cfg.staticBearer || !checkStaticBearer(cfg.staticBearer, token)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
    next();
  };
}
