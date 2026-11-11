#!/usr/bin/env node
// Local/manual collection:  npm run collect -- --all   |   npm run collect -- --source 3
require('dotenv').config({ quiet: true });
const db = require('../database');
const { runDue } = require('../collectors');

(async () => {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf('--source');
  await db.init();
  let ids;
  if (sourceIdx > -1) {
    const id = Number(args[sourceIdx + 1]);
    if (!Number.isInteger(id)) throw new Error('Usage: collect --source <id> | --all');
    ids = [id];
  } else if (args.includes('--all')) {
    ids = await db.listAllSourceIds();
  }
  const summary = await runDue({ trigger: 'cli', budgetMs: Number(process.env.COLLECT_BUDGET_MS) || 240000, ids });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.results.some((r) => r.status === 'error') ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
