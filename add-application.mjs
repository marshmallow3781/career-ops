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
 *     [--note="phone screen scheduled"] \
 *     [--pdf-generated] \
 *     [--report-path=reports/drafts/foo.md]
 *
 * --pdf-generated (boolean flag, no value): marks the application as
 *   having a PDF ready — surfaces as ✅ in applications.md.
 * --report-path=<file>: reads the markdown file and runs persistReport()
 *   under the hood. The report is copied to the canonical location
 *   (reports/{company_slug}/{job_id}_report.md) and the application
 *   links to the persisted doc's _id.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { upsertApplication, getNextApplicationNum, closeDb } from './lib/db.mjs';
import { persistReport } from './lib/reports.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    // Boolean flag (no value): --pdf-generated
    if (/^--[^=]+$/.test(a)) {
      out[a.slice(2).replace(/-/g, '_')] = true;
      continue;
    }
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
  const job_id = args.job_id || `synthetic-${num}`;
  const companySlug = (args.company || '').toLowerCase().replace(/\s+/g, '-');

  // Persist the referenced report if --report-path given.
  let report_id = null;
  if (args.report_path) {
    if (!existsSync(args.report_path)) {
      console.error(`Report file not found: ${args.report_path}`);
      process.exit(1);
    }
    const body = readFileSync(args.report_path, 'utf-8');
    const score = args.score ? parseFloat(args.score) : null;
    const { num: reportNum, report_path } = await persistReport({
      job_id,
      company: args.company,
      company_slug: companySlug,
      url: args.url || '',
      score,
      block_scores: {},
      body,
      legitimacy: args.legitimacy || 'unverified',
    });
    // merge-tracker renders the link as reports/{company_slug}/{job_id}_report.md
    // (persistReport writes it there), so report_id just needs to be truthy
    // for the link to render. Store the report num for reference.
    report_id = String(reportNum);
    console.error(`[add-application] report persisted → ${report_path} (num=${reportNum})`);
  }

  await upsertApplication({
    num,
    job_id,
    company: args.company,
    role: args.role,
    status: args.status,
    url: args.url || '',
    date: args.date || new Date().toISOString().split('T')[0],
    score: args.score ? parseFloat(args.score) : null,
    notes: args.note || '',
    pdf_generated: Boolean(args.pdf_generated),
    report_id,
    cv_artifact_ids: [],
  });
  console.log(JSON.stringify({ ok: true, num, report_id }, null, 2));
  await closeDb();
}

main().catch(err => {
  console.error('add-application failed:', err.message);
  process.exit(1);
});
