#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerVerify } from './commands/verify.js';
import { registerIngest } from './commands/ingest.js';
import { registerDistill } from './commands/distill.js';
import { registerReview } from './commands/review.js';
import { registerTriage } from './commands/triage.js';
import { registerStats } from './commands/stats.js';
import { registerExportVault } from './commands/export-vault.js';
import { registerReembed } from './commands/reembed.js';
import { registerDedupeEntities } from './commands/dedupe-entities.js';
import { registerStaleness } from './commands/staleness.js';
import { registerBackfillProjects } from './commands/backfill-projects.js';

const program = new Command('memoryctl')
  .description('memory-mcp ingestion + admin CLI')
  .version('0.1.0');

registerInit(program);
registerVerify(program);
registerIngest(program);
registerDistill(program);
registerReview(program);
registerTriage(program);
registerStats(program);
registerExportVault(program);
registerReembed(program);
registerDedupeEntities(program);
registerStaleness(program);
registerBackfillProjects(program);

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
