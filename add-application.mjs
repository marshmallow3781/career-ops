#!/usr/bin/env node
/**
 * add-application.mjs — CLI to manually enter an application into Mongo.
 *
 * Usage:
 *   node add-application.mjs \
 *     --job-id=4405461688 \
 *     --company="Rippling" \
 *     --role="SWE II Backend" \
 *     --url=https://linkedin.com/... \
 *     --status=Applied \
 *     [--date=2026-04-23] \
 *     [--score=4.5] \
 *     [--note="phone screen scheduled"]
 */
import 'dotenv/config';
import { upsertApplication, getNextApplicationNum, closeDb } from './lib/db.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1].replace(/-/g, '_')] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['company', 'role', 'status']) {
    if (!args[required]) {
      console.error(`Missing --${required}`);
      process.exit(1);
    }
  }
  const num = await getNextApplicationNum();
  await upsertApplication({
    num,
    job_id: args.job_id || `synthetic-${num}`,
    company: args.company,
    role: args.role,
    status: args.status,
    url: args.url || '',
    date: args.date || new Date().toISOString().split('T')[0],
    score: args.score ? parseFloat(args.score) : null,
    notes: args.note || '',
    pdf_generated: false,
    report_id: null,
    cv_artifact_ids: [],
  });
  console.log(JSON.stringify({ ok: true, num }, null, 2));
  await closeDb();
}

main().catch(err => {
  console.error('add-application failed:', err.message);
  process.exit(1);
});
