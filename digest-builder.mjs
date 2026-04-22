#!/usr/bin/env node
/**
 * digest-builder.mjs — 3-stage filter + digest renderer.
 *
 * Usage:
 *   node digest-builder.mjs                # normal run
 *   node digest-builder.mjs --dry-run      # don't write output
 *
 * Stages:
 *   1. Free title filter (portals.yml.title_filter + profile.deal_breakers)
 *   2. Fingerprint dedup (cross-source, last 30 days)
 *   3. Haiku archetype-aware scoring
 *
 * Outputs:
 *   - data/digest.md (overwritten at 7am, appended otherwise)
 *   - appends score≥6 entries to data/pipeline.md
 *   - macOS notification via osascript
 *   - archives old digests to data/digest-history/
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';
import {
  normalizeCompany,
  normalizeTitle,
  computeJdFingerprint,
  loadSeenJobs,
  appendSeenJobs,
  SEEN_JOBS_HEADER,
} from './lib/dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const DIGEST_PATH = join(DATA_DIR, 'digest.md');
const HISTORY_DIR = join(DATA_DIR, 'digest-history');
const APIFY_NEW_GLOB = 'apify-new-';
const APIFY_ARCHIVE_DIR = join(DATA_DIR, 'apify-new-archive');
const PIPELINE_PATH = join(DATA_DIR, 'pipeline.md');

const HAIKU_MODEL = process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Apply 3-part title filter: positive-match AND !negative-match AND !deal-breaker.
 * All matches are case-insensitive substring.
 *
 * @param {string} title
 * @param {{positive: string[], negative: string[]}} filter
 * @param {string[]} dealBreakers
 * @returns {boolean} true if job passes filter
 */
export function applyTitleFilter(title, filter, dealBreakers) {
  if (!title || typeof title !== 'string') return false;
  const lc = title.toLowerCase();
  const hasPositive = (filter.positive || []).length === 0 ||
    (filter.positive || []).some(k => lc.includes(k.toLowerCase()));
  const hasNegative = (filter.negative || []).some(k => lc.includes(k.toLowerCase()));
  const hasDealBreaker = (dealBreakers || []).some(k => lc.includes(k.toLowerCase()));
  return hasPositive && !hasNegative && !hasDealBreaker;
}

/**
 * Check whether a company is on the user's blacklist.
 * Matching: normalize both sides via normalizeCompany (lowercase + kebab-case),
 * then substring match. "Walmart" entry matches "walmart", "walmart-labs",
 * "walmart-connect". Case-insensitive.
 *
 * @param {string} companyName — the candidate job's company field
 * @param {string[]} blacklist — entries from profile.yml target_roles.company_blacklist
 * @returns {boolean} true if the company should be dropped from the digest
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
 * Build the cached candidate-summary block used in the Haiku pre-filter prompt.
 * Assembled from config/profile.yml + experience_source/ (via loadAllSources,
 * shared with assemble-cv.mjs).
 *
 * Length target: ~400-500 tokens, cacheable.
 */
export function buildCandidateSummary(profile, sources) {
  const cand = profile.candidate || {};
  const tr = profile.target_roles || {};
  const narrative = profile.narrative || {};
  const archetypes = (tr.archetypes_of_interest || ['frontend', 'backend', 'infra', 'machine_learning']).join(', ');
  const minSen = tr.seniority_min || 'Mid-Senior';
  const maxSen = tr.seniority_max || 'Staff';

  const lines = [];
  lines.push('<candidate_profile>');
  lines.push(`Name: ${cand.full_name || 'Candidate'}`);
  lines.push(`Seniority: ${minSen}–${maxSen} target; NOT Junior/Intern/Entry`);
  lines.push(`Open to roles across: ${archetypes}`);
  if (narrative.headline) lines.push(`Headline: ${narrative.headline}`);
  lines.push('');

  // Group bullets by archetype across companies
  const byArchetype = {};
  for (const [dir, files] of Object.entries(sources || {})) {
    for (const f of files || []) {
      const fm = f.frontmatter || {};
      const facet = fm.facet || 'unknown';
      byArchetype[facet] ??= [];
      const role = `${fm.company || dir} (${fm.role || 'SWE'}, ${fm.start || '?'}-${fm.end || 'present'})`;
      const bullets = (f.bullets || []).slice(0, 3).map(b => b.text).join('; ');
      byArchetype[facet].push(`- ${role}: ${bullets}`);
    }
  }

  const facetOrder = ['frontend', 'backend', 'infra', 'machine_learning'];
  const seenFacets = new Set();
  for (const facet of facetOrder) {
    if (byArchetype[facet]?.length) {
      lines.push(facet.toUpperCase() + ':');
      for (const ln of byArchetype[facet]) lines.push('  ' + ln);
      lines.push('');
      seenFacets.add(facet);
    }
  }
  // Include any additional facets (e.g. 'unknown', 'fullstack') that appear in sources
  for (const facet of Object.keys(byArchetype)) {
    if (seenFacets.has(facet)) continue;
    if (!byArchetype[facet]?.length) continue;
    lines.push(facet.toUpperCase() + ':');
    for (const ln of byArchetype[facet]) lines.push('  ' + ln);
    lines.push('');
  }

  // Flatten skills across all files
  const allSkills = new Set();
  for (const files of Object.values(sources || {})) {
    for (const f of files || []) {
      for (const s of f.skills || []) allSkills.add(s);
    }
  }
  if (allSkills.size > 0) {
    lines.push(`Skills breadth: ${[...allSkills].slice(0, 30).join(', ')}`);
  }
  lines.push('</candidate_profile>');

  return lines.join('\n');
}
