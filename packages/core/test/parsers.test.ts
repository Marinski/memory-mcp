import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseChatgpt } from '../src/ingest/parsers/chatgpt.js';
import { parseClaude } from '../src/ingest/parsers/claude.js';
import { parseClaudeCode } from '../src/ingest/parsers/claude-code.js';
import { parseOpencode } from '../src/ingest/parsers/opencode.js';
import { parseMarkdown } from '../src/ingest/parsers/markdown.js';
import { detectSourceKind } from '../src/ingest/parsers/index.js';

const fx = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('chatgpt parser', () => {
  it('reconstructs the active branch in order', () => {
    const sessions = parseChatgpt(fx('chatgpt.json'));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe('chatgpt:conv-1');
    expect(s.sourceTool).toBe('chatgpt');
    expect(s.title).toBe('Klaro vs tarteaucitron');
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(s.turns[2].text).toContain('go with Klaro');
  });
});

describe('claude parser', () => {
  it('parses chat_messages with roles mapped', () => {
    const sessions = parseClaude(fx('claude.json'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('claude:abc-123');
    expect(sessions[0].turns).toHaveLength(2);
    expect(sessions[0].turns[1].text).toContain('80/20');
  });
});

describe('claude-code parser', () => {
  it('extracts text turns, skips sidechains and bookkeeping', () => {
    const sessions = parseClaudeCode(fx('claude-code.jsonl'), '/x/claude-code.jsonl');
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe('claude-code:sess-cc-1');
    expect(s.project).toBe('backtest-manager');
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1].text).toContain('e2fsck');
  });

  it('throws on unparseable lines (quarantine path)', () => {
    expect(() => parseClaudeCode('not json at all\n', '/x/bad.jsonl')).toThrow(/unparseable/);
  });
});

describe('opencode parser', () => {
  it('parses single-session object with parts', () => {
    const sessions = parseOpencode(fx('opencode.json'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('opencode:oc-1');
    expect(sessions[0].project).toBe('infra');
    expect(sessions[0].turns).toHaveLength(2);
  });

  it('tags sourceTool per the second param (vscode reuses the same shape)', () => {
    const sessions = parseOpencode(fx('vscode.json'), 'vscode');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('vscode:vs-1');
    expect(sessions[0].sourceTool).toBe('vscode');
    expect(sessions[0].project).toBe('aigate');
    expect(sessions[0].turns).toHaveLength(2);
  });
});

describe('markdown parser', () => {
  it('yields a single user-turn session titled from H1', () => {
    const sessions = parseMarkdown(fx('note.md'), '/vault/note.md');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('Trading journal conventions');
    expect(sessions[0].turns[0].role).toBe('user');
  });
});

describe('detectSourceKind', () => {
  it('routes by extension and content shape', () => {
    expect(detectSourceKind('/a/b.jsonl', '')).toBe('claude-code');
    expect(detectSourceKind('/a/note.md', '# x')).toBe('markdown');
    expect(detectSourceKind('/a/conversations.json', fx('chatgpt.json'))).toBe('chatgpt');
    expect(detectSourceKind('/a/export.json', fx('claude.json'))).toBe('claude');
    expect(detectSourceKind('/a/session.json', fx('opencode.json'))).toBe('opencode');
    expect(detectSourceKind('/a/session.json', fx('vscode.json'))).toBe('vscode');
    expect(() => detectSourceKind('/a/file.bin', 'xx')).toThrow(/cannot detect/);
  });
});
