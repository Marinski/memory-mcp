import { describe, it, expect } from 'vitest';
import { UNTRUSTED_DATA_SUFFIX } from '../src/distill/llm.js';
import { SYSTEM as triageSystem } from '../src/distill/triage.js';
import { SYSTEM as extractSystem } from '../src/distill/extract.js';
import { SYSTEM as dedupeSystem } from '../src/dedupe-entities.js';
import { SYSTEM as rememberSystem } from '../src/remember.js';

const SYSTEM_PROMPTS = [
  ['distill/triage.ts judgeBatch', triageSystem],
  ['distill/extract.ts', extractSystem],
  ['dedupe-entities.ts', dedupeSystem],
  ['remember.ts checkSupersedes', rememberSystem],
] as const;

describe('SYSTEM prompts contain shared framing', () => {
  it.each(SYSTEM_PROMPTS)(
    '%s SYSTEM prompt includes the UNTRUSTED_DATA_SUFFIX',
    (_name, system) => {
      expect(system).toContain(UNTRUSTED_DATA_SUFFIX);
    },
  );

  it.each(SYSTEM_PROMPTS)(
    '%s SYSTEM prompt instructs the model to treat content as data, not instructions',
    (_name, system) => {
      expect(system).toMatch(/(?:ignore any instructions|not as instructions)/i);
    },
  );
});
