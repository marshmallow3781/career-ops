#!/usr/bin/env node
/**
 * smoke-apify.mjs — end-to-end smoke test against the autopilot pipeline.
 *
 * Fans out across configured metros via Apify, applies the production filters
 * (blacklist + title filter), and ranks survivors via the Haiku pre-filter.
 * Writes a ranked digest-style report without touching seen-jobs.tsv or other
 * production state files.
 *
 * Usage:
 *   node smoke-apify.mjs \
 *     [--metros=bay-area,seattle]       # comma list of config/apify-search.yml locations; default: all
 *     [--rows=200] \                    # per-metro cap
 *     [--window=r86400] \               # "" | r86400 (24h) | r604800 (7d) | r2592000 (30d)
 *     [--clamp-hours=N] \               # client-side post-filter by postedTime
 *     [--title="Software Engineer"] \
 *     [--skip-rank]                     # fetch+filter only, no Haiku calls
 *
 * Writes:
 *   - data/smoke-apify-{timestamp}.json  (raw dataset + per-stage results)
 *   - data/smoke-apify-{timestamp}.md    (ranked digest preview)
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ApifyClient } from 'apify-client';
import Anthropic from '@anthropic-ai/sdk';
import { isCompanyBlacklisted } from './lib/dedup.mjs';
import {
  preFilterJob,
  buildCandidateSummary,
  applyTitleFilter,
  SYSTEM_PROMPT,
} from './digest-builder.mjs';
import { loadAllSources } from './assemble-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID_PUBLISHED_AT = new Set(['', 'r86400', 'r604800', 'r2592000']);

function parseArgs(argv) {
  const out = {
    metros: null,
    rows: 200,
    window: 'r86400',
    clampHours: null,
    title: 'Software Engineer',
    skipRank: false,
  };
  for (const a of argv) {
    if (a.startsWith('--metros=')) out.metros = a.split('=')[1].split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--rows=')) out.rows = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--window=')) out.window = a.split('=')[1];
    else if (a.startsWith('--clamp-hours=')) out.clampHours = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--title=')) out.title = a.split('=')[1];
    else if (a === '--skip-rank') out.skipRank = true;
  }
  if (!VALID_PUBLISHED_AT.has(out.window)) {
    console.error(`[smoke] --window=${out.window} not accepted by actor. Use "", r86400 (24h), r604800 (7d), or r2592000 (30d).`);
    console.error(`[smoke] For shorter windows, fetch r86400 and pass --clamp-hours=N to filter client-side by postedTime.`);
    process.exit(1);
  }
  return out;
}

function parsePostedHoursAgo(postedTime) {
  if (!postedTime || typeof postedTime !== 'string') return null;
  const m = postedTime.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  switch (unit) {
    case 'minute': return n / 60;
    case 'hour':   return n;
    case 'day':    return n * 24;
    case 'week':   return n * 24 * 7;
    case 'month':  return n * 24 * 30;
    case 'year':   return n * 24 * 365;
    default: return null;
  }
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

function buildActorInput(cfg, loc, title, window, rows) {
  const input = {};
  for (const [k, v] of Object.entries(cfg.default_params || {})) {
    if (v !== null && v !== undefined) input[k] = v;
  }
  input.title = title;
  input.location = loc.location;
  if (loc.geoId) input.geoId = loc.geoId;
  input.publishedAt = window;
  input.rows = rows;
  return input;
}

function normalizeItems(items, sourceMetro) {
  return items.map(j => ({
    linkedin_id: (j.jobUrl || '').match(/\/view\/(\d+)/)?.[1] || null,
    url: j.jobUrl || j.url || '',
    title: j.title || '',
    company: j.companyName || j.company || '',
    location: j.location || '',
    description: j.description || '',
    salary: j.salary || '',
    posted_at: j.publishedAt || '',
    posted_time_relative: j.postedTime || '',
    posted_hours_ago: parsePostedHoursAgo(j.postedTime),
    source_metro: sourceMetro,
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.APIFY_API_TOKEN;
  if (!token) { console.error('Missing APIFY_API_TOKEN'); process.exit(1); }

  const apifyCfg = yaml.load(readFileSync(resolve(__dirname, 'config/apify-search.yml'), 'utf-8'));
  const profile  = yaml.load(readFileSync(resolve(__dirname, 'config/profile.yml'), 'utf-8'));
  const portals  = yaml.load(readFileSync(resolve(__dirname, 'portals.yml'), 'utf-8'));

  const blacklist = profile?.target_roles?.company_blacklist || [];
  const dealBreakers = profile?.target_roles?.deal_breakers || [];

  // Select metros to fan out over
  const targetMetros = args.metros
    ? apifyCfg.locations.filter(l => args.metros.includes(l.name))
    : apifyCfg.locations;
  if (targetMetros.length === 0) {
    console.error(`[smoke] No metros matched. Available: ${apifyCfg.locations.map(l => l.name).join(', ')}`);
    process.exit(1);
  }

  console.error('[smoke] ═══ STAGE 0: fetch ═══');
  console.error(`[smoke] metros=[${targetMetros.map(l => l.name).join(', ')}] window=${args.window} rows/metro=${args.rows}${args.clampHours ? ` clamp=${args.clampHours}h` : ''}`);

  const client = new ApifyClient({ token });
  const perMetro = [];
  let allJobs = [];

  // Fan out in parallel (Apify actor runs are already independent — no rate-limit concern at this scale)
  const fetchResults = await Promise.allSettled(
    targetMetros.map(async loc => {
      const input = buildActorInput(apifyCfg, loc, args.title, args.window, args.rows);
      const t0 = Date.now();
      const run = await client.actor(apifyCfg.actor_id).call(input);
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      return { loc, items, elapsedMs: Date.now() - t0 };
    })
  );

  for (let i = 0; i < fetchResults.length; i++) {
    const r = fetchResults[i];
    const loc = targetMetros[i];
    if (r.status === 'rejected') {
      console.error(`[smoke]   ${loc.name}: FAILED — ${r.reason?.message || r.reason}`);
      perMetro.push({ metro: loc.name, fetched: 0, error: String(r.reason?.message || r.reason) });
      continue;
    }
    const { items, elapsedMs } = r.value;
    console.error(`[smoke]   ${loc.name}: fetched ${items.length} in ${(elapsedMs/1000).toFixed(1)}s`);
    perMetro.push({ metro: loc.name, fetched: items.length, elapsed_s: elapsedMs/1000 });
    allJobs = allJobs.concat(normalizeItems(items, loc.name));
  }

  const rawCount = allJobs.length;
  console.error(`[smoke] total fetched across metros: ${rawCount}`);

  // Client-side hours-ago clamp
  let clampDropped = 0;
  if (args.clampHours !== null && args.clampHours > 0) {
    const before = allJobs.length;
    allJobs = allJobs.filter(j => j.posted_hours_ago !== null && j.posted_hours_ago <= args.clampHours);
    clampDropped = before - allJobs.length;
    console.error(`[smoke] client-side clamp to last ${args.clampHours}h: dropped ${clampDropped}; keep ${allJobs.length}`);
  }

  // Dedup across metros (same job could appear in overlapping geos — Bay Area/Seattle probably not, but safety)
  const seenIds = new Set();
  const deduped = [];
  let dupCount = 0;
  for (const j of allJobs) {
    if (j.linkedin_id && seenIds.has(j.linkedin_id)) { dupCount++; continue; }
    if (j.linkedin_id) seenIds.add(j.linkedin_id);
    deduped.push(j);
  }
  if (dupCount > 0) console.error(`[smoke] cross-metro dedup: dropped ${dupCount} duplicates`);

  // ─── STAGE 1: blacklist ───
  console.error('[smoke] ═══ STAGE 1: blacklist filter ═══');
  const blacklisted = [];
  const afterBL = [];
  for (const j of deduped) {
    if (isCompanyBlacklisted(j.company, blacklist)) blacklisted.push(j);
    else afterBL.push(j);
  }
  console.error(`[smoke] blacklist=${blacklist.length} entries; dropped ${blacklisted.length}; keep ${afterBL.length}`);
  if (blacklisted.length > 0) {
    const breakdown = {};
    for (const j of blacklisted) breakdown[j.company] = (breakdown[j.company] || 0) + 1;
    console.error(`[smoke]   dropped breakdown: ${JSON.stringify(breakdown)}`);
  }

  // ─── STAGE 2: title filter ───
  console.error('[smoke] ═══ STAGE 2: title filter ═══');
  const titleCut = [];
  const afterTF  = [];
  for (const j of afterBL) {
    if (applyTitleFilter(j.title, portals.title_filter, dealBreakers)) afterTF.push(j);
    else titleCut.push(j);
  }
  console.error(`[smoke] title filter dropped ${titleCut.length}; keep ${afterTF.length}`);

  // ─── STAGE 3: Haiku ranking ───
  let scored = [];
  let haikuMs = 0;
  if (args.skipRank) {
    console.error('[smoke] ═══ STAGE 3: SKIPPED (--skip-rank) ═══');
    scored = afterTF.map(j => ({ ...j, archetype: 'unknown', score: null, reason: 'skipped' }));
  } else if (afterTF.length === 0) {
    console.error('[smoke] ═══ STAGE 3: no jobs to rank ═══');
  } else {
    console.error(`[smoke] ═══ STAGE 3: Haiku ranking (${afterTF.length} jobs, concurrency=5) ═══`);
    const sources = loadAllSources(resolve(__dirname, 'experience_source'));
    const candidateSummary = buildCandidateSummary(profile, sources);

    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const haiku = new Anthropic(baseURL ? { baseURL } : {});

    const t0 = Date.now();
    const results = await mapConcurrent(afterTF, 5, async (job) => {
      const res = await preFilterJob(job, SYSTEM_PROMPT, candidateSummary, haiku);
      return { ...job, ...res };
    });
    haikuMs = Date.now() - t0;
    console.error(`[smoke] scored ${results.length} jobs in ${(haikuMs/1000).toFixed(1)}s`);
    scored = results.filter(r => !r.__error);
    const errors = results.filter(r => r.__error);
    if (errors.length > 0) console.error(`[smoke] ${errors.length} Haiku errors`);
  }

  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  // ─── Output ───
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = resolve(__dirname, 'data', `smoke-apify-${ts}.json`);
  const mdPath   = resolve(__dirname, 'data', `smoke-apify-${ts}.md`);

  const bucketCounts = { 'score_ge_8': 0, 'score_6_7': 0, 'score_4_5': 0, 'score_lt_4': 0, 'unknown': 0 };
  for (const j of scored) {
    if (j.score === null || j.score === undefined) bucketCounts.unknown++;
    else if (j.score >= 8) bucketCounts.score_ge_8++;
    else if (j.score >= 6) bucketCounts.score_6_7++;
    else if (j.score >= 4) bucketCounts.score_4_5++;
    else bucketCounts.score_lt_4++;
  }

  writeFileSync(jsonPath, JSON.stringify({
    per_metro: perMetro,
    clamp_hours: args.clampHours,
    raw_total: rawCount,
    clamp_dropped: clampDropped,
    cross_metro_dupes_dropped: dupCount,
    after_dedup: deduped.length,
    blacklisted_count: blacklisted.length,
    after_blacklist: afterBL.length,
    title_cut: titleCut.length,
    after_title_filter: afterTF.length,
    haiku_scored: scored.length,
    bucket_counts: bucketCounts,
    haiku_seconds: haikuMs / 1000,
    ranked_jobs: scored,
  }, null, 2));

  const lines = [
    `# Smoke test — [${targetMetros.map(l => l.name).join(', ')}]`,
    ``,
    `**Window:** ${args.window}${args.clampHours ? ` (clamped to last ${args.clampHours}h)` : ''}  **Rows/metro:** ${args.rows}  **Run:** ${new Date().toISOString()}`,
    ``,
    `**Per metro:** ${perMetro.map(m => `${m.metro}=${m.fetched}`).join(' · ')}`,
    ``,
    `**Pipeline:** fetched ${rawCount} → clamp ${allJobs.length} → dedup ${deduped.length} → blacklist ${afterBL.length} → title ${afterTF.length} → scored ${scored.length}`,
    ``,
    `**Buckets:** 🔥 ≥8: ${bucketCounts.score_ge_8}  ⚡ 6-7: ${bucketCounts.score_6_7}  💤 4-5: ${bucketCounts.score_4_5}  ❌ <4: ${bucketCounts.score_lt_4}  ❓ unknown: ${bucketCounts.unknown}`,
    ``,
    `---`,
    ``,
  ];
  for (const j of scored.slice(0, 40)) {
    const badge = j.score === null ? '❓' : j.score >= 8 ? '🔥' : j.score >= 6 ? '⚡' : j.score >= 4 ? '💤' : '❌';
    const scoreTxt = j.score === null ? '—' : `${j.score}/10`;
    lines.push(`${badge} **${scoreTxt}** [${j.archetype}] **${j.title}** — ${j.company} · \`${j.source_metro}\``);
    lines.push(`   📍 ${j.location}${j.salary ? ` · 💰 ${j.salary}` : ''}${j.posted_time_relative ? ` · 🕐 ${j.posted_time_relative}` : ''}`);
    if (j.reason) lines.push(`   💬 ${j.reason}`);
    lines.push(`   🔗 ${j.url}`);
    lines.push(``);
  }
  writeFileSync(mdPath, lines.join('\n'));

  console.log(JSON.stringify({
    ok: true,
    per_metro: perMetro,
    raw_total: rawCount,
    after_clamp: allJobs.length,
    after_dedup: deduped.length,
    after_blacklist: afterBL.length,
    after_title_filter: afterTF.length,
    scored: scored.length,
    buckets: bucketCounts,
    output_json: jsonPath,
    output_md: mdPath,
    haiku_seconds: Number((haikuMs/1000).toFixed(1)),
  }, null, 2));
}

main().catch(err => {
  console.error('[smoke] failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
