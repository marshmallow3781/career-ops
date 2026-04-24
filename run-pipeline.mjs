#!/usr/bin/env node
/**
 * run-pipeline.mjs — top-level orchestrator for launchd.
 *
 * Runs the full flow in one Node.js process:
 *   1. apify-scan (LinkedIn via Apify)
 *   2. scan (Greenhouse/Ashby/Lever)
 *   3. stage-2 scoring (title filter + Haiku prefilter)
 *   4. auto-prep (CV + PDF + report + tracker for score>=threshold)
 *
 * CLI flags:
 *   --location=<metro>     filter apify to a single metro (bay-area | greater-la | seattle)
 *   --locations=a,b,c      same, comma-separated multiple
 *   --hours=N              time window (passed to scan, scoring, and auto-prep).
 *                          For apify (whose schema is enum-bucketed) → maps N≤24
 *                          to r86400, 24<N≤168 to r604800, N>168 to r2592000.
 *   --skip-apify           skip stage 1
 *   --skip-scan            skip stage 2
 *
 * Single closeDb() at the end. Any failure in one stage logs and continues
 * to the next — we want to see as much coverage as possible per run.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ApifyClient } from 'apify-client';

import { runApifyScan } from './apify-scan.mjs';
import { runScan } from './scan.mjs';
import { runDigestStage2AndScoring, loadCandidatesFromMongo } from './digest-builder.mjs';
import { runAutoPrep } from './auto-prep.mjs';
import { closeDb } from './lib/db.mjs';
import { loadAllSources } from './assemble-core.mjs';
import { initLlm } from './lib/llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { locations: null, hours: null, skipApify: false, skipScan: false };
  for (const a of argv) {
    if (a === '--skip-apify') out.skipApify = true;
    else if (a === '--skip-scan') out.skipScan = true;
    else if (a.startsWith('--location=')) out.locations = [a.split('=')[1]];
    else if (a.startsWith('--locations=')) out.locations = a.split('=')[1].split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--hours=')) out.hours = parseInt(a.split('=')[1], 10);
  }
  return out;
}

// Map an arbitrary hours window to the Apify actor's publishedAt enum
// (the actor only accepts "", r86400, r604800, r2592000).
function hoursToPublishedAt(hours) {
  if (!hours || hours <= 24) return 'r86400';
  if (hours <= 168) return 'r604800';
  return 'r2592000';
}

async function stage1Apify({ locations, hours }) {
  const cfgPath = resolve(__dirname, 'config/apify-search.yml');
  if (!existsSync(cfgPath)) { console.error('[pipeline] skip apify: no config'); return; }
  const config = yaml.load(readFileSync(cfgPath, 'utf-8'));
  const token = process.env[config.api_token_env];
  if (!token) { console.error('[pipeline] skip apify: missing token'); return; }

  // Filter to requested metros if any
  let scopedCfg = config;
  if (locations && locations.length > 0) {
    const wanted = new Set(locations);
    const filtered = config.locations.filter(loc => wanted.has(loc.name));
    if (filtered.length === 0) {
      console.error(`[pipeline] skip apify: no matching metros for ${[...wanted].join(',')}`);
      return;
    }
    scopedCfg = { ...config, locations: filtered };
  }

  // Override publishedAt if --hours provided (map to enum bucket)
  if (hours) {
    const publishedAt = hoursToPublishedAt(hours);
    scopedCfg = {
      ...scopedCfg,
      baseline: { ...scopedCfg.baseline, params: { ...scopedCfg.baseline.params, publishedAt } },
      hourly:   { ...scopedCfg.hourly,   params: { ...scopedCfg.hourly.params,   publishedAt } },
    };
    console.error(`[pipeline] apify: mapping --hours=${hours} to publishedAt=${publishedAt}`);
  }

  const client = new ApifyClient({ token });
  const profilePath = resolve(__dirname, 'config/profile.yml');
  const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf-8')) : {};
  const blacklist = profile?.target_roles?.company_blacklist || [];
  const metros = scopedCfg.locations.map(l => l.name).join(', ');
  console.error(`[pipeline] apify-scan starting… metros=[${metros}]`);
  const result = await runApifyScan({
    config: scopedCfg, client,
    seenJobsPath: resolve(__dirname, 'data/seen-jobs.tsv'),
    apifyNewPath: resolve(__dirname, `data/apify-new-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    blacklist,
  });
  console.error(`[pipeline] apify-scan done: new=${result.totalNew} errors=${result.errors.length}`);
}

async function stage2Scan({ hours }) {
  console.error(`[pipeline] scan.mjs starting… sinceHours=${hours ?? 2}`);
  try {
    await runScan({ sinceHours: hours ?? 2 });
  } catch (e) {
    console.error(`[pipeline] scan.mjs failed: ${e.message}`);
  }
}

async function stage3Score({ hours }) {
  console.error('[pipeline] stage-2 scoring starting…');
  const profilePath = resolve(__dirname, 'config/profile.yml');
  const portalsPath = resolve(__dirname, 'portals.yml');
  if (!existsSync(profilePath) || !existsSync(portalsPath)) {
    console.error('[pipeline] skip scoring: profile/portals missing');
    return;
  }
  const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  const portals = yaml.load(readFileSync(portalsPath, 'utf-8'));
  const sources = loadAllSources(resolve(__dirname, 'experience_source'));
  const dealBreakers = profile?.target_roles?.deal_breakers || [];
  const { client: haikuClient, config: llmConfig } = initLlm();
  const candidates = await loadCandidatesFromMongo({ sinceHours: hours ?? 24 });
  console.error(`[pipeline] scoring ${candidates.length} raw candidates (sinceHours=${hours ?? 24})`);
  await runDigestStage2AndScoring({ candidates, portals, profile, sources, haikuClient, llmConfig, dealBreakers });
}

async function stage4AutoPrep({ hours }) {
  console.error(`[pipeline] auto-prep starting… sinceHours=${hours ?? 24}`);
  return runAutoPrep({ sinceHours: hours ?? 24 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  try {
    if (!args.skipApify) await stage1Apify({ locations: args.locations, hours: args.hours });
    if (!args.skipScan)  await stage2Scan({ hours: args.hours });
    await stage3Score({ hours: args.hours });
    await stage4AutoPrep({ hours: args.hours });
  } catch (err) {
    console.error('[pipeline] fatal:', err.message);
  } finally {
    await closeDb().catch(() => {});
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[pipeline] total elapsed: ${elapsed}s`);
}

main().catch(async err => {
  console.error('run-pipeline.mjs crashed:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
