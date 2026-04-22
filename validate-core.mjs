/**
 * validate-core.mjs — Pure functions for cv.tailored.md validation.
 */

/** Levenshtein distance (iterative, two-row). */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Returns 1.0 - normalized edit distance, in [0, 1]. */
export function levenshteinRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Extract company headers from a tailored CV markdown.
 * Matches: ### CompanyName ... (third-level headings under Work Experience).
 * Returns the company part lowercased and slugified to compare against directory names.
 */
export function extractCompanyHeaders(markdown) {
  const headers = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)(?:\s+—\s+|\s+--\s+|$)/);
    if (m) {
      const slug = m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      headers.push(slug);
    }
  }
  return headers;
}

/**
 * Check that every required company directory has a header in the tailored CV.
 * @param {string} markdown — cv.tailored.md content
 * @param {string[]} required — company directory names (already kebab-case)
 * @returns {Array<{type: string, company: string, hint: string}>}
 */
export function checkCompanyCoverage(markdown, required) {
  const present = new Set(extractCompanyHeaders(markdown));
  const errors = [];
  for (const company of required) {
    const matched = [...present].some(p => p === company || p.startsWith(company + '-') || p.startsWith(company));
    if (!matched) {
      errors.push({
        type: 'missing_company',
        company,
        hint: `Company "${company}" missing from cv.tailored.md. Ensure stub or higher tier is assigned.`,
      });
    }
  }
  return errors;
}
