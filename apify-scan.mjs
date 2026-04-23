#!/usr/bin/env node
/**
 * apify-scan.mjs — Apify LinkedIn scraper orchestrator.
 *
 * Usage:
 *   node apify-scan.mjs                # normal run, uses config/apify-search.yml
 *   node apify-scan.mjs --dry-run      # log plan, don't call Apify
 *
 * Reads config/apify-search.yml + config/profile.yml.
 * Calls the Apify actor for each location in parallel (Promise.allSettled).
 * Writes new jobs atomically to data/seen-jobs.tsv + data/apify-new-{ts}.json.
 */

import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ApifyClient } from 'apify-client';
import {
  extractLinkedInId,
  normalizeCompany,
  normalizeTitle,
  computeJdFingerprint,
  loadSeenJobs,
  appendSeenJobs,
  isCompanyBlacklisted,
} from './lib/dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH  = resolve(__dirname, 'config/apify-search.yml');
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const SEEN_PATH    = resolve(__dirname, 'data/seen-jobs.tsv');
const NEW_DIR      = resolve(__dirname, 'data');

/**
 * Read a job field from an Apify actor item, supporting both the current
 * schema (jobUrl / companyName) and the legacy schema (url / company).
 * The curious_coder/linkedin-jobs-scraper actor emits jobUrl/companyName
 * as of v2.1.3; older test fixtures use url/company.
 */
function getJobField(j, newKey, oldKey) {
  if (j[newKey] !== undefined && j[newKey] !== null) return j[newKey];
  return j[oldKey];
}

/**
 * Scan one location via the Apify actor.
 * Returns { metro, items, error? }.
 */
async function scanOneLocation({ location, params, client, actorId }) {
  // Filter nulls from defaultParams — the actor's schema rejects null fields
  // outright (e.g. workType, contractType, experienceLevel when "all" is
  // intended) rather than treating null as "omit".
  const input = {};
  for (const [k, v] of Object.entries(params.defaultParams || {})) {
    if (v !== null && v !== undefined) input[k] = v;
  }
  input.location = location.location;
  if (location.geoId) input.geoId = location.geoId;
  input.publishedAt = params.publishedAt;
  input.rows = params.rows;

  const run = await client.actor(actorId).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return { metro: location.name, items };
}

/**
 * Main orchestrator (injectable for tests).
 *
 * @param {string[]} [opts.blacklist] — company names to filter out before
 *   dedup/writing. Matched via isCompanyBlacklisted (substring on normalized
 *   kebab-case). Empty/missing → no filtering.
 */
export async function runApifyScan({ config, client, seenJobsPath, apifyNewPath, hourOverride, dryRun = false, blacklist = [] }) {
  const hour = hourOverride !== undefined
    ? hourOverride
    : new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
  const hourNum = typeof hour === 'number' ? hour : parseInt(hour, 10);
  const isBaseline = hourNum === 7;

  const params = {
    defaultParams: config.default_params,
    publishedAt: isBaseline ? config.baseline.params.publishedAt : config.hourly.params.publishedAt,
  };

  const seen = await loadSeenJobs(seenJobsPath);

  const settled = await Promise.allSettled(
    config.locations.map(loc =>
      dryRun
        ? Promise.resolve({ metro: loc.name, items: [] })
        : scanOneLocation({
            location: loc,
            params: { ...params, rows: isBaseline ? loc.baseline_rows : loc.hourly_rows },
            client,
            actorId: config.actor_id,
          })
    )
  );

  const sources = [];
  const errors = [];
  const newRows = [];
  const newJobs = [];

  for (let i = 0; i < settled.length; i++) {
    const loc = config.locations[i];
    const r = settled[i];
    if (r.status === 'rejected') {
      errors.push({ metro: loc.name, error: r.reason?.message || String(r.reason) });
      continue;
    }
    const items = r.value.items || [];
    let newCount = 0;
    let blacklistedCount = 0;
    const nowIso = new Date().toISOString();
    for (const j of items) {
      const jobUrl      = getJobField(j, 'jobUrl', 'url');
      const companyName = getJobField(j, 'companyName', 'company');
      const title       = getJobField(j, 'title', 'title');
      const jobLocation = getJobField(j, 'location', 'location');
      const publishedAt = getJobField(j, 'publishedAt', 'posted_at');

      const linkedin_id = extractLinkedInId(jobUrl);
      if (!linkedin_id) continue;

      // Blacklist check — done BEFORE dedup work so blacklisted companies
      // don't pollute seen-jobs.tsv. Filtering at retrieval time means we
      // never store them, never try to re-dedup them next run, and never
      // pass them to the Haiku pre-filter (which would waste tokens).
      if (isCompanyBlacklisted(companyName, blacklist)) {
        blacklistedCount++;
        continue;
      }

      if (seen.linkedinIds.has(linkedin_id)) continue;

      const fingerprint = j.description ? computeJdFingerprint(j.description) : '(none)';
      if (fingerprint !== '(none)' && seen.fingerprints.has(fingerprint)) continue;

      const company_slug = normalizeCompany(companyName || '');
      const title_normalized = normalizeTitle(title || '');
      const tck = `${company_slug}|${title_normalized}`;
      if (company_slug && title_normalized && seen.titleCompanyKeys.has(tck)) continue;

      // Mark seen in-memory to dedup within this run
      seen.linkedinIds.add(linkedin_id);
      if (fingerprint !== '(none)') seen.fingerprints.set(fingerprint, {});
      if (company_slug && title_normalized) seen.titleCompanyKeys.set(tck, {});

      newJobs.push({
        linkedin_id,
        url: jobUrl,
        title,
        company: companyName,
        company_slug,
        location: jobLocation || loc.location,
        description: (j.description || '').slice(0, 4000),
        posted_at: publishedAt || '',
        source_metro: loc.name,
      });
      newRows.push({
        linkedin_id,
        url: jobUrl,
        company_slug,
        title_normalized,
        first_seen_utc: nowIso,
        last_seen_utc: nowIso,
        source: `apify-linkedin-${loc.name}`,
        status: 'new',
        jd_fingerprint: fingerprint,
        prefilter_archetype: '(none)',
        prefilter_score: '(none)',
        prefilter_reason: '(none)',
      });
      newCount++;
    }
    sources.push({ metro: loc.name, fetched: items.length, new: newCount, blacklisted: blacklistedCount });
  }

  if (!dryRun && newRows.length > 0) {
    await appendSeenJobs(seenJobsPath, newRows);
  }
  if (!dryRun) {
    const payload = {
      run_started_utc: new Date().toISOString(),
      run_finished_utc: new Date().toISOString(),
      sources,
      total_new_jobs: newJobs.length,
      cost_estimate_usd: Number((newJobs.length * 0.001).toFixed(3)),
      errors,
      new_jobs: newJobs,
    };
    writeFileSync(apifyNewPath, JSON.stringify(payload, null, 2));
  }

  return { sources, errors, totalNew: newJobs.length };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    console.error(`Copy config/apify-search.example.yml → config/apify-search.yml and adjust.`);
    process.exit(1);
  }

  const config = yaml.load(readFileSync(CONFIG_PATH, 'utf-8'));
  const token = process.env[config.api_token_env];
  if (!dryRun && !token) {
    console.error(`Missing env var: ${config.api_token_env}`);
    process.exit(1);
  }

  // Load profile.yml for company_blacklist (optional — empty list if missing).
  let blacklist = [];
  if (existsSync(PROFILE_PATH)) {
    const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
    blacklist = profile?.target_roles?.company_blacklist || [];
    if (blacklist.length > 0) {
      console.error(`[apify-scan] Loaded ${blacklist.length} blacklisted companies from profile.yml`);
    }
  }

  const client = dryRun ? null : new ApifyClient({ token });

  const apifyNewPath = join(NEW_DIR, `apify-new-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  const result = await runApifyScan({
    config,
    client,
    seenJobsPath: SEEN_PATH,
    apifyNewPath,
    dryRun,
    blacklist,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.errors.length === config.locations.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('apify-scan.mjs crashed:', err);
    process.exit(2);
  });
}
