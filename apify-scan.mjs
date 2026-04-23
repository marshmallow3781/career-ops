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
import { insertScanRun, upsertJob, findJobsBySeenSet, getDb } from './lib/db.mjs';

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
  const dualWrite = process.env.DUAL_WRITE_FILES === '1';

  const params = {
    defaultParams: config.default_params,
    publishedAt: isBaseline ? config.baseline.params.publishedAt : config.hourly.params.publishedAt,
  };

  const runStartedAt = new Date();
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
  const runFinishedAt = new Date();

  const sources = [];
  const errors = [];
  const newRows = [];
  const newJobs = [];

  let totalFetched = 0;
  let totalNewCount = 0;
  let totalBlacklistedCount = 0;

  let tsvSeen = null;
  if (dualWrite) {
    tsvSeen = await loadSeenJobs(seenJobsPath);
  }

  const scanRunId = dryRun ? null : await insertScanRun({
    source: 'apify-linkedin',
    metro: config.locations.length === 1 ? config.locations[0].name : 'multi',
    apify_actor_id: config.actor_id,
    apify_run_id: null,
    input_params: {
      title: (params.defaultParams && params.defaultParams.title) || null,
      publishedAt: params.publishedAt,
      locations: config.locations.map(l => ({ name: l.name, geoId: l.geoId })),
    },
    run_started_at: runStartedAt,
    run_finished_at: runFinishedAt,
    fetched_count: 0,
    new_count: 0,
    blacklisted_count: 0,
    errors: [],
  });

  for (let i = 0; i < settled.length; i++) {
    const loc = config.locations[i];
    const r = settled[i];
    if (r.status === 'rejected') {
      errors.push({ metro: loc.name, error: r.reason?.message || String(r.reason) });
      continue;
    }
    const items = r.value.items || [];
    totalFetched += items.length;
    let newCount = 0;
    let blacklistedCount = 0;
    const linkedinIds = items.map(j => extractLinkedInId(j.jobUrl || j.url)).filter(Boolean);

    const mongoSeen = dryRun ? new Set() : await findJobsBySeenSet(linkedinIds);

    for (const j of items) {
      const jobUrl      = j.jobUrl      || j.url;
      const companyName = j.companyName || j.company;
      const title       = j.title       || '';
      const jobLocation = j.location    || '';
      const publishedAt = j.publishedAt || j.posted_at || '';

      const linkedin_id = extractLinkedInId(jobUrl);
      if (!linkedin_id) continue;

      if (isCompanyBlacklisted(companyName, blacklist)) {
        blacklistedCount++;
        continue;
      }

      if (mongoSeen.has(linkedin_id)) {
        if (!dryRun) {
          await upsertJob({
            linkedin_id,
            url: jobUrl,
            title,
            title_normalized: normalizeTitle(title || ''),
            company: companyName,
            company_slug: normalizeCompany(companyName || ''),
            company_title_key: `${normalizeCompany(companyName || '')}|${normalizeTitle(title || '')}`,
            jd_fingerprint: j.description ? computeJdFingerprint(j.description) : null,
            location: jobLocation,
            description: (j.description || '').slice(0, 4000),
            source_metro: loc.name,
            posted_at_raw: publishedAt,
            posted_time_relative: j.postedTime || '',
            first_scan_run_id: scanRunId,
          });
        }
        continue;
      }

      const company_slug = normalizeCompany(companyName || '');
      const title_normalized = normalizeTitle(title || '');
      const fingerprint = j.description ? computeJdFingerprint(j.description) : null;

      if (!dryRun) {
        await upsertJob({
          linkedin_id,
          url: jobUrl,
          title,
          title_normalized,
          company: companyName,
          company_slug,
          company_title_key: `${company_slug}|${title_normalized}`,
          jd_fingerprint: fingerprint,
          location: jobLocation,
          description: (j.description || '').slice(0, 4000),
          source_metro: loc.name,
          posted_at_raw: publishedAt,
          posted_time_relative: j.postedTime || '',
          first_scan_run_id: scanRunId,
        });
      }

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

      if (dualWrite && tsvSeen) {
        newRows.push({
          linkedin_id,
          url: jobUrl,
          company_slug,
          title_normalized,
          first_seen_utc: runStartedAt.toISOString(),
          last_seen_utc: runStartedAt.toISOString(),
          source: `apify-linkedin-${loc.name}`,
          status: 'new',
          jd_fingerprint: fingerprint || '(none)',
          prefilter_archetype: '(none)',
          prefilter_score: '(none)',
          prefilter_reason: '(none)',
        });
      }
      newCount++;
    }
    totalNewCount += newCount;
    totalBlacklistedCount += blacklistedCount;
    sources.push({ metro: loc.name, fetched: items.length, new: newCount, blacklisted: blacklistedCount });
  }

  if (!dryRun && scanRunId) {
    const db = await getDb();
    await db.collection('scan_runs').updateOne(
      { _id: scanRunId },
      { $set: { fetched_count: totalFetched, new_count: totalNewCount, blacklisted_count: totalBlacklistedCount, errors } },
    );
  }

  if (dualWrite && newRows.length > 0) await appendSeenJobs(seenJobsPath, newRows);
  if (dualWrite) {
    const payload = {
      run_started_utc: runStartedAt.toISOString(),
      run_finished_utc: runFinishedAt.toISOString(),
      sources,
      total_new_jobs: newJobs.length,
      cost_estimate_usd: Number((newJobs.length * 0.001).toFixed(3)),
      errors,
      new_jobs: newJobs,
    };
    writeFileSync(apifyNewPath, JSON.stringify(payload, null, 2));
  }

  return { sources, errors, totalNew: newJobs.length, scanRunId };
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
