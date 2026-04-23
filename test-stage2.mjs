#!/usr/bin/env node
/**
 * test-stage2.mjs — drive digest-builder stages 2+3 against Mongo jobs.
 *
 * Picks up all raw-stage jobs in Mongo, runs the title filter, scores the
 * survivors with Haiku, and updates each job's stage + prefilter fields.
 * Prints a human-readable before/after summary.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  loadCandidatesFromMongo,
  applyTitleFilter,
  assertTitleFilterUsable,
  buildCandidateSummary,
  preFilterJob,
  SYSTEM_PROMPT,
} from './digest-builder.mjs';
import { findDigestCandidates, closeDb, getDb } from './lib/db.mjs';
import { loadAllSources } from './assemble-core.mjs';
import { initLlm } from './lib/llm.mjs';

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

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // --refresh opts into re-scoring already-scored jobs (use when the
  // scoring rubric or candidate summary has changed). Default scores
  // only stage='raw' jobs to avoid burning LLM tokens on every run.
  const refresh = process.argv.includes('--refresh');

  const profile = yaml.load(readFileSync(resolve(__dirname, 'config/profile.yml'), 'utf-8'));
  const portals = yaml.load(readFileSync(resolve(__dirname, 'portals.yml'), 'utf-8'));
  assertTitleFilterUsable(portals);
  const sources = loadAllSources(resolve(__dirname, 'experience_source'));
  const dealBreakers = profile?.target_roles?.deal_breakers || [];

  const candidates = await loadCandidatesFromMongo({ sinceHours: 24, includeScored: refresh });

  console.error(`[stage2] Loaded ${candidates.length} candidate jobs from Mongo (last 24h, refresh=${refresh})`);
  console.error('');
  console.error('─── BEFORE (stage=raw) ───');
  for (const j of candidates) {
    const key = (j.linkedin_id || `gh:${j.url?.split('/').pop() || '?'}`).toString().padEnd(14);
    console.error(`  ${key} [${j.stage}] ${j.company}: ${j.title}`);
  }
  console.error('');

  // Use the shared LLM factory so LLM_PROVIDER/LLM_MODEL env vars are honored
  // (MiniMax, DeepSeek, Anthropic, etc.). The previous hardcoded Anthropic
  // client silently ignored the provider switch.
  const { client: llmClient, config: llmConfig } = initLlm();
  console.error(`[stage2] LLM provider=${llmConfig.provider} model=${llmConfig.model}`);

  // Parallelized scoring. Keyed to support both Apify jobs (linkedin_id)
  // and scan.mjs jobs (url) — the `updateJobStage` helper only matches on
  // linkedin_id, so use raw Mongo updates keyed by whichever id is present.
  const candidateSummary = buildCandidateSummary(profile, sources);
  const db = await getDb();
  const CONCURRENCY = 8;
  console.error(`[stage2] Running title filter + Haiku scoring (concurrency=${CONCURRENCY}, ${candidates.length} jobs)...`);
  const t0 = Date.now();
  let titleCut = 0, scored = 0, errors = 0;

  await mapConcurrent(candidates, CONCURRENCY, async (job) => {
    const matchFilter = job.linkedin_id
      ? { linkedin_id: job.linkedin_id }
      : { url: job.url };

    if (!applyTitleFilter(job.title, portals.title_filter, dealBreakers)) {
      titleCut++;
      const now = new Date();
      await db.collection('jobs').updateOne(matchFilter, {
        $set: { stage: 'title_cut', updated_at: now },
        $push: { stage_history: { stage: 'title_cut', at: now, reason: 'title filter' } },
      });
      return;
    }
    try {
      const { archetype, score, reason } = await preFilterJob(job, SYSTEM_PROMPT, candidateSummary, llmClient, llmConfig);
      const now = new Date();
      await db.collection('jobs').updateOne(matchFilter, {
        $set: {
          stage: 'scored',
          prefilter_archetype: archetype,
          prefilter_score: score,
          prefilter_reason: reason,
          prefilter_source: 'llm',
          prefilter_at: now,
          updated_at: now,
        },
        $push: { stage_history: { stage: 'scored', at: now, archetype, score, reason } },
      });
      scored++;
    } catch (err) {
      errors++;
      console.error(`[stage2] Haiku error for ${job.company}: ${err.message}`);
    }
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[stage2] Done in ${elapsed}s (title_cut=${titleCut}, scored=${scored}, errors=${errors})`);
  console.error('');

  // Read back post-scoring state. Match by either linkedin_id (Apify jobs)
  // or url (scan.mjs jobs which have linkedin_id=null).
  const lids = candidates.map(c => c.linkedin_id).filter(Boolean);
  const urls = candidates.map(c => c.url).filter(Boolean);
  const post = await findDigestCandidates({ $or: [
    { linkedin_id: { $in: lids } },
    { url: { $in: urls } },
  ] });
  console.error('─── AFTER ───');
  // Sort: scored ≥8 first, then 6-7, then 4-5, then <4, then title_cut last
  const bucket = (j) => {
    if (j.stage === 'title_cut') return 99;
    if (j.prefilter_score === null || j.prefilter_score === undefined) return 98;
    if (j.prefilter_score >= 8) return 0;
    if (j.prefilter_score >= 6) return 1;
    if (j.prefilter_score >= 4) return 2;
    return 3;
  };
  post.sort((a, b) => bucket(a) - bucket(b) || (b.prefilter_score ?? -1) - (a.prefilter_score ?? -1));

  for (const j of post) {
    if (j.stage === 'title_cut') {
      console.error(`  ❌ [title_cut]    ${j.company}: ${j.title}`);
    } else if (j.prefilter_score === null || j.prefilter_score === undefined) {
      console.error(`  ❓ [${j.stage}]        ${j.company}: ${j.title} — ${j.prefilter_reason || '(no reason)'}`);
    } else {
      const badge = j.prefilter_score >= 8 ? '🔥' : j.prefilter_score >= 6 ? '⚡' : j.prefilter_score >= 4 ? '💤' : '❌';
      const scoreTxt = `${j.prefilter_score}/10`;
      console.error(`  ${badge} ${scoreTxt} [${j.prefilter_archetype}] ${j.company}: ${j.title}`);
      if (j.prefilter_reason) console.error(`           └─ ${j.prefilter_reason}`);
    }
  }

  // Bucket counts
  const counts = { score_ge_8: 0, score_6_7: 0, score_4_5: 0, score_lt_4: 0, title_cut: 0, unknown: 0 };
  for (const j of post) {
    if (j.stage === 'title_cut') counts.title_cut++;
    else if (j.prefilter_score === null || j.prefilter_score === undefined) counts.unknown++;
    else if (j.prefilter_score >= 8) counts.score_ge_8++;
    else if (j.prefilter_score >= 6) counts.score_6_7++;
    else if (j.prefilter_score >= 4) counts.score_4_5++;
    else counts.score_lt_4++;
  }

  console.error('');
  console.log(JSON.stringify({
    ok: true,
    total_candidates: candidates.length,
    elapsed_seconds: Number(elapsed),
    buckets: counts,
  }, null, 2));

  await closeDb();
}

main().catch(err => {
  console.error('[stage2] FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
