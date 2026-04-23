/**
 * lib/dedup.mjs — Shared deduplication helpers for autopilot.
 * Used by apify-scan.mjs, digest-builder.mjs, and scan.mjs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

/**
 * Parse a LinkedIn job URL and extract the numeric job ID.
 * @param {string|null|undefined} url
 * @returns {string|null} The ID string, or null if not a LinkedIn job URL
 */
export function extractLinkedInId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Convert a company name to kebab-case for dedup keys.
 * Strips trademarks, apostrophes, non-alphanumerics (except hyphens/spaces).
 */
export function normalizeCompany(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Convert a job title to kebab-case for dedup keys.
 * Strips " | Company" and " @ Company" suffixes that LinkedIn adds.
 */
export function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  const cleaned = title.split(/\s*[|@]\s*/)[0];
  return normalizeCompany(cleaned);
}

/**
 * Check whether a company is on the user's blacklist.
 * Matching: normalize both sides via normalizeCompany (lowercase + kebab-case),
 * then substring match. "Walmart" entry matches "walmart", "walmart-labs",
 * "walmart-connect". Case-insensitive.
 *
 * @param {string} companyName — the candidate job's company field
 * @param {string[]} blacklist — entries from profile.yml target_roles.company_blacklist
 * @returns {boolean} true if the company should be dropped
 */
export function isCompanyBlacklisted(companyName, blacklist) {
  if (!companyName || !blacklist || blacklist.length === 0) return false;
  const normalized = normalizeCompany(companyName);
  if (!normalized) return false;
  return blacklist.some(entry => {
    const entryNormalized = normalizeCompany(entry);
    if (!entryNormalized) return false;
    return normalized === entryNormalized || normalized.includes(entryNormalized);
  });
}

/**
 * Compute a stable SHA-256 fingerprint of a JD body.
 * Normalizes: lowercases, collapses whitespace, strips punctuation.
 * Used for cross-source dedup (same job on LinkedIn + Greenhouse → same hash).
 */
export function computeJdFingerprint(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export const SEEN_JOBS_HEADER =
  'linkedin_id\turl\tcompany_slug\ttitle_normalized\tfirst_seen_utc\tlast_seen_utc\tsource\tstatus\tjd_fingerprint\tprefilter_archetype\tprefilter_score\tprefilter_reason';

const SEEN_JOBS_COLUMN_COUNT = 12;

/**
 * Load seen-jobs.tsv into memory for O(1) dedup lookups.
 * On corruption (wrong column count, missing header), backs up the file and returns empty state.
 *
 * @param {string} path — absolute path to seen-jobs.tsv
 * @returns {Promise<{linkedinIds: Set<string>, fingerprints: Map<string, object>, titleCompanyKeys: Map<string, object>}>}
 */
export async function loadSeenJobs(path) {
  const linkedinIds = new Set();
  const fingerprints = new Map();
  const titleCompanyKeys = new Map();

  if (!existsSync(path)) {
    return { linkedinIds, fingerprints, titleCompanyKeys };
  }

  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { linkedinIds, fingerprints, titleCompanyKeys };
  }

  // Validate header
  if (lines[0] !== SEEN_JOBS_HEADER) {
    // Corrupt — back up and return empty
    const backup = path.replace(/\.tsv$/, `.corrupt-${Date.now()}.tsv`);
    renameSync(path, backup);
    console.error(`[dedup] seen-jobs.tsv header mismatch; backed up to ${backup}`);
    return { linkedinIds, fingerprints, titleCompanyKeys };
  }

  // Parse rows
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length !== SEEN_JOBS_COLUMN_COUNT) {
      // Corrupt row — back up and bail
      const backup = path.replace(/\.tsv$/, `.corrupt-${Date.now()}.tsv`);
      renameSync(path, backup);
      console.error(`[dedup] seen-jobs.tsv row ${i} has ${cols.length} cols (expected ${SEEN_JOBS_COLUMN_COUNT}); backed up to ${backup}`);
      return {
        linkedinIds: new Set(),
        fingerprints: new Map(),
        titleCompanyKeys: new Map(),
      };
    }
    const row = {
      linkedin_id: cols[0],
      url: cols[1],
      company_slug: cols[2],
      title_normalized: cols[3],
      first_seen_utc: cols[4],
      last_seen_utc: cols[5],
      source: cols[6],
      status: cols[7],
      jd_fingerprint: cols[8],
      prefilter_archetype: cols[9],
      prefilter_score: cols[10],
      prefilter_reason: cols[11],
    };
    if (row.linkedin_id !== '(none)' && row.linkedin_id) {
      linkedinIds.add(row.linkedin_id);
    }
    if (row.jd_fingerprint !== '(none)' && row.jd_fingerprint) {
      if (!fingerprints.has(row.jd_fingerprint)) {
        fingerprints.set(row.jd_fingerprint, row);
      }
    }
    const tck = `${row.company_slug}|${row.title_normalized}`;
    if (row.company_slug && row.title_normalized && !titleCompanyKeys.has(tck)) {
      titleCompanyKeys.set(tck, row);
    }
  }

  return { linkedinIds, fingerprints, titleCompanyKeys };
}

/**
 * Append rows to seen-jobs.tsv atomically.
 * Creates file with header if missing.
 *
 * @param {string} path
 * @param {Array<object>} rows — objects with all SEEN_JOBS_HEADER fields
 */
export async function appendSeenJobs(path, rows) {
  if (!rows || rows.length === 0) return;

  const tmpPath = path + '.tmp';
  let content;
  if (existsSync(path)) {
    content = readFileSync(path, 'utf-8').replace(/\n+$/, '') + '\n';
  } else {
    content = SEEN_JOBS_HEADER + '\n';
  }

  for (const r of rows) {
    content += [
      r.linkedin_id || '(none)',
      r.url || '',
      r.company_slug || '',
      r.title_normalized || '',
      r.first_seen_utc || '',
      r.last_seen_utc || '',
      r.source || '',
      r.status || 'new',
      r.jd_fingerprint || '(none)',
      r.prefilter_archetype || '(none)',
      r.prefilter_score || '(none)',
      r.prefilter_reason || '(none)',
    ].join('\t') + '\n';
  }

  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);  // atomic
}
