#!/usr/bin/env node
/**
 * merge-tracker.mjs — render applications.md from the Mongo applications
 * collection.
 *
 * Previously this script merged per-application TSV dropbox files
 * (`batch/tracker-additions/*.tsv`) into `data/applications.md`. With the
 * Mongo migration, applications live in the `applications` collection
 * (inserted via `add-application.mjs` or `upsertApplication()` from a
 * mode's batch path), and this script renders the human-readable markdown
 * view from the query.
 *
 * Usage: node merge-tracker.mjs
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { listApplications, closeDb } from './lib/db.mjs';

const OUTPUT = 'data/applications.md';

async function main() {
  const apps = await listApplications({});
  const lines = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
  ];
  for (const a of apps) {
    const companySlug = (a.company || '').toLowerCase().replace(/\s+/g, '-');
    const reportLink = a.report_id
      ? `[${a.num}](reports/${companySlug}/${a.job_id}_report.md)`
      : '';
    const score = a.score !== null && a.score !== undefined ? `${a.score}/5` : '';
    const pdf = a.pdf_generated ? '✅' : '❌';
    lines.push(`| ${a.num} | ${a.date || ''} | ${a.company || ''} | ${a.role || ''} | ${score} | ${a.status || ''} | ${pdf} | ${reportLink} | ${a.notes || ''} |`);
  }
  writeFileSync(OUTPUT, lines.join('\n') + '\n');
  console.log(`Wrote ${apps.length} applications to ${OUTPUT}`);
  await closeDb();
}

main().catch(err => {
  console.error('merge-tracker failed:', err.message);
  process.exit(1);
});
