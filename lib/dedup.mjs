/**
 * lib/dedup.mjs — Shared deduplication helpers for autopilot.
 * Used by apify-scan.mjs, digest-builder.mjs, and scan.mjs.
 */
import { createHash } from 'node:crypto';

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
