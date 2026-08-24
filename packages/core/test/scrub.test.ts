import { describe, it, expect } from 'vitest';
import { redactWithRules, scrubSession } from '../src/ingest/scrub.js';
import { parseClaude } from '../src/ingest/parsers/claude.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const fx = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('redactWithRules', () => {
  it('redacts an OpenAI-style key', () => {
    const r = redactWithRules('my key is sk-abcdef1234567890ABCDEF1234567890 ok');
    expect(r.text).toContain('[REDACTED:openai-key]');
    expect(r.text).not.toContain('sk-abcdef');
    expect(r.found).toBe(1);
  });

  it('redacts url basic-auth credentials', () => {
    const r = redactWithRules('db is postgres://alice:hunter2secret@db.local/prod');
    expect(r.text).toContain('[REDACTED:url-basic-auth]');
    expect(r.text).not.toContain('hunter2secret');
  });

  it('redacts WireGuard private keys in config context', () => {
    const key = 'A'.repeat(43) + '=';
    const r = redactWithRules(`PrivateKey = ${key}`);
    expect(r.text).toContain('[REDACTED:wireguard-key]');
  });

  it('redacts AWS keys, github tokens, JWTs, private key blocks', () => {
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`;
    const text = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_' + 'x'.repeat(40),
      jwt,
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
    ].join('\n');
    const r = redactWithRules(text);
    expect(r.found).toBe(4);
    expect(r.text).not.toContain('AKIA');
  });

  it('leaves clean text untouched', () => {
    const clean = 'We decided to use Klaro for cookie consent.';
    const r = redactWithRules(clean);
    expect(r.text).toBe(clean);
    expect(r.found).toBe(0);
  });
});

describe('scrubSession', () => {
  it('redacts planted secrets in a fixture session and counts them', () => {
    const [session] = parseClaude(fx('secrets.json'));
    const { session: clean, secretsFound } = scrubSession(session, 'off');
    expect(secretsFound).toBeGreaterThanOrEqual(2);
    const all = clean.turns.map((t) => t.text).join('\n');
    expect(all).not.toContain('sk-abcdef1234567890');
    expect(all).not.toContain('hunter2secret');
    expect(all).toContain('[REDACTED:');
  });

  it('fails closed when the gitleaks binary is missing', () => {
    const [session] = parseClaude(fx('claude.json'));
    expect(() => scrubSession(session, '/nonexistent/gitleaks')).toThrow(/fail-closed/);
  });
});
