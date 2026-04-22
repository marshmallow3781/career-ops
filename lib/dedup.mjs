/**
 * lib/dedup.mjs — Shared deduplication helpers for autopilot.
 * Used by apify-scan.mjs, digest-builder.mjs, and scan.mjs.
 */

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
