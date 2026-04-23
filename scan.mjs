#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { computeJdFingerprint, normalizeCompany, normalizeTitle, appendSeenJobs, isCompanyBlacklisted } from './lib/dedup.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const PROFILE_PATH = 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const SEEN_JOBS_PATH = 'data/seen-jobs.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    api_type: 'greenhouse',
    // Greenhouse returns ISO 8601 for both. first_published = when it went live;
    // updated_at = last modification. Use first_published as "posted_at" since
    // that's what "last 24h" semantically means. Fall back to updated_at.
    posted_at: j.first_published || j.updated_at || null,
    updated_at: j.updated_at || null,
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    api_type: 'ashby',
    // Ashby's public posting API returns publishedDate + updatedAt as ISO.
    posted_at: j.publishedDate || j.updatedAt || null,
    updated_at: j.updatedAt || null,
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    api_type: 'lever',
    // Lever's public postings API returns createdAt as a Unix timestamp in ms.
    // Convert to ISO for a uniform posted_at shape across parsers.
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    updated_at: null,  // Lever dropped updated_at from the public feed
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

/**
 * Build a predicate that tests whether a job's location string passes the
 * allow/deny substring rules. Case-insensitive.
 *
 * Semantics:
 * - Missing/empty allow list → permissive (everything passes). Lets
 *   portals.yml omit location_filter without breaking the scanner.
 * - Missing or empty location → fail closed (can't verify US-ok).
 * - Pass iff (any allow substring matches) AND (no deny substring matches).
 * - Deny wins: "Remote - EU" with allow=["Remote"] deny=["Remote - EU"]
 *   → false.
 * - Multi-location pipe strings (e.g. "SF, CA | London, UK") check against
 *   the whole string — any allow substring anywhere passes, unless a deny
 *   substring is also present.
 */
export function buildLocationFilter(cfg) {
  const allow = (cfg?.allow || []).map(s => s.toLowerCase());
  const deny  = (cfg?.deny  || []).map(s => s.toLowerCase());
  if (allow.length === 0) return () => true;
  return (location) => {
    if (!location || typeof location !== 'string') return false;
    const lc = location.toLowerCase();
    if (deny.some(d => lc.includes(d))) return false;
    return allow.some(a => lc.includes(a));
  };
}

/**
 * Build a predicate that returns true if a company is blacklisted (should
 * be dropped). Wraps isCompanyBlacklisted for consistency with the other
 * filter-builder helpers in this file.
 *
 * Returns false for null / empty company names — don't drop on missing data;
 * let other filters (location) handle defensively.
 */
export function buildBlacklistFilter(blacklist) {
  const entries = blacklist || [];
  if (entries.length === 0) return () => false;  // no-op when empty
  return (company) => {
    if (!company) return false;
    return isCompanyBlacklisted(company, entries);
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Seen-jobs row mapping (autopilot dedup) ─────────────────────────

function mapScanJobsToSeenJobsRows(jobs, apiType) {
  const nowIso = new Date().toISOString();
  return jobs.map(j => ({
    linkedin_id: '(none)',   // scan.mjs is not LinkedIn
    url: j.url || '',
    company_slug: normalizeCompany(j.company || ''),
    title_normalized: normalizeTitle(j.title || ''),
    first_seen_utc: nowIso,
    last_seen_utc: nowIso,
    source: `scan-${apiType}`,     // e.g., scan-greenhouse
    status: 'new',
    jd_fingerprint: j.description ? computeJdFingerprint(j.description) : '(none)',
    prefilter_archetype: '(none)',
    prefilter_score: '(none)',
    prefilter_reason: '(none)',
  }));
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

/**
 * Human-readable relative age, e.g. "2h ago", "3d ago".
 */
function formatAge(iso) {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const deltaMs = Date.now() - t;
  const mins = Math.round(deltaMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Auto-compute the time window for filtering. Mirrors apify-scan.mjs:
 *   - 7am PST → 24h window (baseline: "catch yesterday's full backlog")
 *   - any other hour → 2h window (catches only recent additions)
 * `--since-hours=N` CLI flag overrides for testing.
 */
function resolveSinceHours(argv) {
  const flag = argv.find(a => a.startsWith('--since-hours='));
  if (flag) {
    const n = parseFloat(flag.split('=')[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const hourStr = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
  const hourNum = parseInt(hourStr, 10);
  return hourNum === 7 ? 24 : 2;
}

/**
 * Drop jobs with posted_at older than sinceHours. Jobs with no posted_at
 * are kept (some parsers or older postings may lack the field — don't
 * silently exclude them from the scanner).
 */
function filterByPostedAt(jobs, sinceHours) {
  if (!sinceHours || sinceHours <= 0) return jobs;
  const cutoff = Date.now() - sinceHours * 3600 * 1000;
  return jobs.filter(j => {
    if (!j.posted_at) return true;  // no timestamp → keep, don't silently drop
    const t = Date.parse(j.posted_at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const sinceHours = resolveSinceHours(args);

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));

  // Load candidate profile for company_blacklist (optional — empty list if missing)
  let blacklist = [];
  if (existsSync(PROFILE_PATH)) {
    const profile = parseYaml(readFileSync(PROFILE_PATH, 'utf-8'));
    blacklist = profile?.target_roles?.company_blacklist || [];
  }

  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const blacklistFilter = buildBlacklistFilter(blacklist);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  console.log(`Time window: last ${sinceHours}h (auto: ${sinceHours === 24 ? '7am PST baseline' : 'off-peak'}; override with --since-hours=N)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  let totalStale = 0;  // jobs older than sinceHours window
  let totalLocationFiltered = 0;
  let totalBlacklisted = 0;

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const allJobs = PARSERS[type](json, company.name);
      totalFound += allJobs.length;
      const jobs = filterByPostedAt(allJobs, sinceHours);
      totalStale += (allJobs.length - jobs.length);

      for (const job of jobs) {
        if (blacklistFilter(job.company)) {
          totalBlacklisted++;
          continue;
        }
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalLocationFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);

    // (autopilot) Also write to seen-jobs.tsv for dedup state
    const seenRows = [];
    for (const offer of newOffers) {
      const apiType = offer.api_type || 'unknown';
      seenRows.push(...mapScanJobsToSeenJobsRows([offer], apiType));
    }
    await appendSeenJobs(SEEN_JOBS_PATH, seenRows);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Outside time window:   ${totalStale} skipped (posted_at older than ${sinceHours}h)`);
  console.log(`Blacklisted companies: ${totalBlacklisted} skipped`);
  console.log(`Outside location:      ${totalLocationFiltered} skipped (no allow match OR deny match)`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      const age = o.posted_at ? formatAge(o.posted_at) : 'unknown age';
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'} | 🕐 ${age}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
