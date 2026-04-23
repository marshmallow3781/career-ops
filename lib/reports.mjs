/**
 * lib/reports.mjs — helper for persisting evaluation reports.
 *
 * Writes the markdown body to reports/{company-slug}/{job_id}_report.md and
 * inserts a metadata doc into the reports collection. Returns the num
 * (sequential) assigned by the collection so callers can use it in
 * cross-refs (applications.report_id, tracker additions, etc.).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { getNextReportNum, insertReport } from './db.mjs';

export async function persistReport({ job_id, company, company_slug, url, score, block_scores, body, legitimacy = 'unverified' }) {
  const num = await getNextReportNum();
  const report_path = `reports/${company_slug}/${job_id}_report.md`;
  const fullPath = resolve(process.cwd(), report_path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body);
  const checksum_md = 'sha256:' + createHash('sha256').update(body).digest('hex');
  await insertReport({
    num, job_id, company_slug, report_path,
    generated_at: new Date(),
    score, verdict: 'evaluated',
    url, legitimacy, block_scores, checksum_md,
  });
  return { num, report_path, full_path: fullPath };
}
