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

async function stage1Apify() {
  const cfgPath = resolve(__dirname, 'config/apify-search.yml');
  if (!existsSync(cfgPath)) { console.error('[pipeline] skip apify: no config'); return; }
  const config = yaml.load(readFileSync(cfgPath, 'utf-8'));
  const token = process.env[config.api_token_env];
  if (!token) { console.error('[pipeline] skip apify: missing token'); return; }
  const client = new ApifyClient({ token });
  const profilePath = resolve(__dirname, 'config/profile.yml');
  const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf-8')) : {};
  const blacklist = profile?.target_roles?.company_blacklist || [];
  console.error('[pipeline] apify-scan starting…');
  const result = await runApifyScan({
    config, client,
    seenJobsPath: resolve(__dirname, 'data/seen-jobs.tsv'),
    apifyNewPath: resolve(__dirname, `data/apify-new-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    blacklist,
  });
  console.error(`[pipeline] apify-scan done: new=${result.totalNew} errors=${result.errors.length}`);
}

async function stage2Scan() {
  console.error('[pipeline] scan.mjs starting…');
  try {
    await runScan({ sinceHours: 2 });
  } catch (e) {
    console.error(`[pipeline] scan.mjs failed: ${e.message}`);
  }
}

async function stage3Score() {
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
  const candidates = await loadCandidatesFromMongo({ sinceHours: 24 });
  console.error(`[pipeline] scoring ${candidates.length} raw candidates`);
  await runDigestStage2AndScoring({ candidates, portals, profile, sources, haikuClient, llmConfig, dealBreakers });
}

async function stage4AutoPrep() {
  console.error('[pipeline] auto-prep starting…');
  return runAutoPrep({});
}

async function main() {
  const t0 = Date.now();
  try {
    await stage1Apify();
    await stage2Scan();
    await stage3Score();
    await stage4AutoPrep();
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
