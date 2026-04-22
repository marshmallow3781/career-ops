/**
 * validate-core.mjs — Pure functions for cv.tailored.md validation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FUZZY_THRESHOLD = 0.85;

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
    const matched = [...present].some(p => p === company || p.startsWith(company + '-'));
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

/**
 * Extract all bullets and their provenance markers from a tailored CV.
 * @returns {Array<{text: string, marker: {path: string, line: number}|null, raw: string}>}
 */
export function extractBulletsWithProvenance(markdown) {
  const bullets = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.+?)(?:\s*<!--\s*src:([^#\s]+)(?:#L(\d+))?\s*-->)?\s*$/);
    if (m) {
      const text = m[1].trim();
      const path = m[2] || null;
      const lineNo = m[3] ? Number(m[3]) : null;
      bullets.push({
        text,
        marker: path ? { path, line: lineNo } : null,
        raw: line,
      });
    }
  }
  return bullets;
}

/**
 * Read all bullet texts from a source file's "## Bullets" section.
 */
function readSourceBullets(absPath) {
  if (!existsSync(absPath)) return null;
  const content = readFileSync(absPath, 'utf-8');
  const bulletsSection = content.match(/##\s+Bullets\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!bulletsSection) return [];
  const bullets = [];
  for (const line of bulletsSection[1].split('\n')) {
    const m = line.match(/^\s*-\s+(.+?)\s*$/);
    if (m) bullets.push(m[1].trim());
  }
  return bullets;
}

/**
 * @param {string} markdown — cv.tailored.md content
 * @param {string} sourcesRoot — absolute path to experience_source/ root
 * @returns {Array<{type: string, ...}>}
 */
export function checkBulletProvenance(markdown, sourcesRoot) {
  const bullets = extractBulletsWithProvenance(markdown);
  const errors = [];
  for (const b of bullets) {
    if (!b.marker) {
      errors.push({
        type: 'missing_marker',
        bullet: b.text,
        hint: 'Every bullet in cv.tailored.md must end with <!-- src:path/to/file.md#Lnnn -->',
      });
      continue;
    }
    const sourcePath = join(sourcesRoot, b.marker.path);
    const sourceBullets = readSourceBullets(sourcePath);
    if (sourceBullets === null) {
      errors.push({
        type: 'source_not_found',
        bullet: b.text,
        path: b.marker.path,
        hint: `Source file ${b.marker.path} does not exist.`,
      });
      continue;
    }
    const matched = sourceBullets.some(src => levenshteinRatio(b.text, src) >= FUZZY_THRESHOLD);
    if (!matched) {
      errors.push({
        type: 'fabricated_bullet',
        bullet: b.text,
        expected_sources: [b.marker.path],
        hint: `Bullet not found in candidate pool of ${b.marker.path}; only select from provided pool.`,
      });
    }
  }
  return errors;
}

/**
 * Verify that company headers in cv.tailored.md appear in the expected order.
 * @param {string} markdown
 * @param {string[]} expected — companies in the order they should appear (already chronologically sorted)
 */
export function checkChronologicalOrder(markdown, expected) {
  const found = extractCompanyHeaders(markdown);
  const reduced = found.filter(c => expected.some(e => c === e || c.startsWith(e + '-')))
    .map(c => expected.find(e => c === e || c.startsWith(e + '-')));
  for (let i = 0; i < expected.length; i++) {
    if (reduced[i] !== expected[i]) {
      return [{
        type: 'chronology_violation',
        found: reduced,
        expected,
        hint: 'Companies must appear in reverse chronological order (most recent first).',
      }];
    }
  }
  return [];
}
