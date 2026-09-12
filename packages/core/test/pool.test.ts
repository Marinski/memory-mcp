import { describe, it, expect, vi } from 'vitest';
import { createPool } from '../src/db/pool.js';

describe('createPool', () => {
  it('configures idle and connection timeouts', () => {
    const pool = createPool('postgres://localhost/test');
    expect(pool.options.idleTimeoutMillis).toBe(30_000);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    pool.end();
  });

  it('logs idle client errors without throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = createPool('postgres://localhost/test');

    const err = new Error('connection terminated');
    pool.emit('error', err);

    expect(spy).toHaveBeenCalledWith('[pool] idle client error', 'connection terminated');
    spy.mockRestore();
    pool.end();
  });
});
