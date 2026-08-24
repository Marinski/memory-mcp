import { describe, it, expect } from 'vitest';
import { chunkSession, splitOversizedText, TARGET_TOKENS, estimateTokens } from '../src/vector/chunker.js';
import type { Session } from '../src/ingest/normalize.js';

function session(turns: { role: 'user' | 'assistant'; text: string }[]): Session {
  return { id: 's', sourceTool: 'markdown', turns };
}

describe('chunkSession', () => {
  it('merges small turns into one chunk', () => {
    const s = session([
      { role: 'user', text: 'short question' },
      { role: 'assistant', text: 'short answer' },
    ]);
    const chunks = chunkSession(s);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].turnRange).toBe('0-1');
  });

  it('splits at turn boundaries with 1-turn overlap', () => {
    const big = 'x'.repeat(TARGET_TOKENS * 4 - 40); // just under budget per turn
    const s = session([
      { role: 'user', text: big },
      { role: 'assistant', text: big },
      { role: 'user', text: big },
    ]);
    const chunks = chunkSession(s);
    expect(chunks.length).toBeGreaterThan(1);
    // overlap: last turn of chunk N reappears in chunk N+1's range
    const firstEnd = Number(chunks[0].turnRange.split('-').pop());
    const secondStart = Number(chunks[1].turnRange.split('-')[0]);
    expect(secondStart).toBeLessThanOrEqual(firstEnd);
  });

  it('keeps an oversized code block intact up to 2x target', () => {
    const code = '```js\n' + 'const a = 1;\n'.repeat(250) + '```'; // > TARGET, < 2x
    expect(estimateTokens(code)).toBeGreaterThan(TARGET_TOKENS);
    const pieces = splitOversizedText(`intro paragraph\n\n${code}\n\nclosing note`);
    const codePiece = pieces.find((p) => p.startsWith('```'));
    expect(codePiece).toBeDefined();
    expect(codePiece).toContain('const a = 1;');
    expect((codePiece!.match(/```/g) ?? []).length).toBe(2); // block intact
  });

  it('never emits an empty chunk and preserves all turns', () => {
    const s = session([
      { role: 'user', text: 'a'.repeat(3000) },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: 'c'.repeat(5000) },
    ]);
    const chunks = chunkSession(s);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    const all = chunks.map((c) => c.text).join(' ');
    expect(all).toContain('b');
  });

  it('is deterministic (snapshot)', () => {
    const s = session([
      { role: 'user', text: 'How do I configure the WireGuard peer?' },
      { role: 'assistant', text: 'Add the peer block to wg0.conf and restart the interface.\n\n```ini\n[Peer]\nAllowedIPs = 10.8.0.4/32\n```' },
      { role: 'user', text: 'Great, and the DNS?' },
      { role: 'assistant', text: 'Point it at the WG gateway resolver.' },
    ]);
    expect(chunkSession(s)).toMatchSnapshot();
  });
});
