#!/usr/bin/env node
/**
 * apply-bot.mjs — autonomous application submission orchestrator.
 *
 * Personal fork override of CLAUDE.md's "never auto-submit" rule; see
 * docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 *
 * Usage:
 *   node apply-bot.mjs                             # dry-run (default)
 *   node apply-bot.mjs --submit                    # real submit
 *   node apply-bot.mjs --workers=2                 # N parallel Chrome
 *   node apply-bot.mjs --job-id=4395215171         # single job
 *   node apply-bot.mjs --retry-failed              # re-run Failed jobs
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

import { getDb, closeDb, upsertApplication, getNextApplicationNum } from './lib/db.mjs';
import { runApplyAgent } from './lib/apply-agent.mjs';
import { solveCaptcha } from './lib/capsolver.mjs';
import { initLlm } from './lib/llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const TRACE_ROOT = resolve(__dirname, 'screenshots');

function parseArgs(argv) {
  const out = { minScore: null, submit: false, workers: null, jobId: null, retryFailed: false };
  for (const a of argv) {
    if (a === '--submit') out.submit = true;
    else if (a === '--retry-failed') out.retryFailed = true;
    else if (a.startsWith('--min-score=')) out.minScore = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--workers=')) out.workers = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--job-id=')) out.jobId = a.split('=')[1];
  }
  return out;
}

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (err) { results[idx] = { __error: err.message }; }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Core orchestration. Exported for tests.
 */
export async function runApplyBot({
  minScore: explicitMinScore = null, submit = false, workers: explicitWorkers = null,
  jobId = null, retryFailed = false,
  mockAgent = null,  // test hook
} = {}) {
  const profile = existsSync(PROFILE_PATH) ? yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) : {};
  const formDefaults = profile?.application_form_defaults || {};
  const autoApply = formDefaults.auto_apply || {};
  const minScore = explicitMinScore ?? autoApply.min_score ?? 9;
  const workers = explicitWorkers ?? autoApply.workers ?? 2;

  const db = await getDb();
  const appliedJobIds = new Set(
    (await db.collection('applications').find({}, { projection: { job_id: 1, _id: 0 } }).toArray()).map(a => a.job_id)
  );

  let candidates;
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  if (jobId) {
    candidates = await db.collection('jobs').find({ linkedin_id: jobId }).toArray();
  } else if (retryFailed) {
    const failedIds = (await db.collection('applications').find({ status: 'Failed' }, { projection: { job_id: 1 } }).toArray()).map(a => a.job_id);
    candidates = await db.collection('jobs').find({ linkedin_id: { $in: failedIds } }).toArray();
  } else {
    candidates = await db.collection('jobs').find({
      first_seen_at: { $gte: cutoff },
      stage: 'scored',
      prefilter_score: { $gte: minScore },
    }).sort({ prefilter_score: -1 }).toArray();
  }

  const eligible = [];
  const stats = { processed: 0, skipped_already_applied: 0, errors: 0, applied: 0, dry_run: 0, failed: 0, skipped: 0 };
  for (const j of candidates) {
    const jobKey = j.linkedin_id || j.url || '';
    if (!retryFailed && appliedJobIds.has(jobKey)) { stats.skipped_already_applied++; continue; }
    eligible.push(j);
  }
  console.error(`[apply-bot] ${eligible.length} eligible jobs (${stats.skipped_already_applied} skipped_already_applied), submit=${submit}, workers=${workers}`);

  // LLM client (vision + text both go through this path)
  const { client: llmClient, config: llmConfig } = mockAgent
    ? { client: null, config: { provider: 'anthropic', model: 'mock' } }
    : initLlm();

  // CAPSOLVER — optional
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const capsolveFn = capsolverKey && autoApply.capsolver_enabled
    ? (p) => solveCaptcha({ ...p, apiKey: capsolverKey })
    : null;

  // Browser lifecycle — one browser per worker, reused across jobs
  const browsers = mockAgent ? [] : await Promise.all(Array.from({ length: workers }, () => chromium.launch({ headless: true })));

  try {
    await mapConcurrent(eligible, workers, async (job, idx) => {
      const workerIdx = idx % workers;
      const browser = browsers[workerIdx];
      const jobKey = job.linkedin_id || job.url || `job-${idx}`;

      const resumePdf = _resolveResumePdf(profile, job);
      const coverLetterMdPath = resolve(__dirname, `cvs/${job.company_slug || 'unknown'}/${(job.title_normalized || 'role').slice(0, 60)}/${jobKey}_cover_letter.md`);
      const coverLetterPdfPath = coverLetterMdPath.replace(/\.md$/, '.pdf');
      const coverLetterText = existsSync(coverLetterMdPath) ? readFileSync(coverLetterMdPath, 'utf-8') : '';

      const files = {
        resume_pdf: resumePdf,
        cover_letter_pdf: existsSync(coverLetterPdfPath) ? coverLetterPdfPath : null,
        cover_letter_text: coverLetterText,
      };

      const traceDir = resolve(TRACE_ROOT, String(jobKey));

      try {
        const agentResult = mockAgent
          ? await mockAgent({ job, profile: formDefaults, files, submit })
          : await runApplyAgent({
              job, profile: formDefaults, files, llmClient, llmConfig, browser,
              submit, maxSteps: autoApply.max_steps_per_job || 25, traceDir,
              capsolve: capsolveFn,
            });

        if (agentResult.status === 'Applied') stats.applied++;
        else if (agentResult.status === 'DryRun') stats.dry_run++;
        else if (agentResult.status === 'Failed') stats.failed++;
        else if (agentResult.status === 'Skipped') stats.skipped++;
        stats.processed++;

        const num = await getNextApplicationNum();
        await upsertApplication({
          num,
          job_id: jobKey,
          company: job.company,
          role: job.title,
          url: job.url || '',
          status: agentResult.status,
          date: new Date().toISOString().slice(0, 10),
          score: typeof job.prefilter_score === 'number' ? Number((job.prefilter_score / 2).toFixed(1)) : null,
          notes: `apply-bot ${submit ? 'submit' : 'dry-run'} (${agentResult.reason || 'ok'})`,
          pdf_generated: true,
          report_id: null,
          cv_artifact_ids: [],
        });

        console.error(`[apply-bot] ${agentResult.status === 'Applied' || agentResult.status === 'DryRun' ? '✓' : '✗'} ${job.company}: ${job.title} — ${agentResult.status} (${agentResult.reason || 'ok'})`);
      } catch (err) {
        stats.errors++;
        console.error(`[apply-bot] ✗ ${job.company}: ${job.title} — ${err.message.slice(0, 120)}`);
      }
    });
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
  }

  console.error(`[apply-bot] done  processed=${stats.processed}  applied=${stats.applied}  dry_run=${stats.dry_run}  failed=${stats.failed}  skipped=${stats.skipped}  errors=${stats.errors}  skipped_already_applied=${stats.skipped_already_applied}`);
  return stats;
}

function _resolveResumePdf(profile, job) {
  const pickerCfg = profile?.cv?.picker || {};
  const resumesDir = pickerCfg.resumes_dir
    ? (pickerCfg.resumes_dir.startsWith('/') ? pickerCfg.resumes_dir : resolve(__dirname, pickerCfg.resumes_dir))
    : resolve(__dirname, 'resumes');
  const fname = pickerCfg.archetype_map?.[job.prefilter_archetype];
  return fname ? resolve(resumesDir, fname) : resolve(resumesDir, 'backend_ai_2.0.pdf');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await runApplyBot(args);
  } finally {
    await closeDb().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async err => {
    console.error('apply-bot.mjs crashed:', err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
