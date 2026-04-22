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

export const SYSTEM_PROMPT = `You are a job-fit pre-filter for a multi-facet candidate who is open to roles in FRONTEND, BACKEND, INFRA, MACHINE_LEARNING, or FULLSTACK.

Given the candidate's profile and a job description, output JSON with:
- archetype: one of "frontend" | "backend" | "infra" | "machine_learning" | "fullstack"
- score: integer 0-10 — how well candidate matches THIS archetype
- reason: one-line ≤100 chars justifying the score

ARCHETYPE CLASSIFICATION NOTES:
- "AI Engineer" / "AI-Native Engineer" / "LLM Engineer" / "Agent Engineer" / "Applied AI"
  roles → classify as "fullstack" (these are typically fullstack + LLM combinations).
  Score on the combination of candidate's fullstack breadth AND their LLM/agent experience.
- "ML Engineer" (classical ML, XGBoost, feature stores, recommender systems) → "machine_learning".
- "Platform Engineer" / "SRE" / "DevOps" / "Data Platform" → "infra".
- "Backend Engineer" (distributed systems, APIs) → "backend".
- "Frontend Engineer" (React, UI, design systems) → "frontend".
- "Fullstack Engineer" without LLM/AI focus → "fullstack".

Scoring rubric:
 10  Outstanding match: recent experience maps directly, senior fit.
 8-9 Strong match: most requirements met, a few might need reframing.
 6-7 Decent match: core overlap but notable gaps.
 4-5 Weak match: partial overlap or wrong seniority.
 0-3 Not a match: wrong role, seniority, or discipline (e.g., legal role with "Infrastructure" in title).

IMPORTANT:
- Score fairly across archetypes — don't penalize ML jobs for not being backend.
- Contract/C2C/temporary = 0-2 (candidate wants full-time).
- Non-engineering (legal/tax/HR) = 0-2.
- Test Engineer / QA roles = 0-2 (candidate is not looking for QA).
- Junior/Entry/Intern engineer roles are acceptable — score them on stack match
  like any other role; don't downrank for seniority.

Output ONLY the JSON object. No preamble, no markdown.`;

/**
 * Pre-filter one job via Haiku.
 * @returns {Promise<{archetype, score, reason}>} where score is integer 0-10 or null
 */
export async function preFilterJob(job, systemPrompt, candidateSummary, client) {
  const userMessage =
    `<job>\nTitle: ${job.title || ''}\nCompany: ${job.company || ''}\n` +
    `Location: ${job.location || ''}\nDescription:\n` +
    `${(job.description || '').slice(0, 3000)}\n</job>\n\nReturn JSON.`;

  let response;
  try {
    response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 120,
      temperature: 0,
      system: [
        { type: 'text', text: systemPrompt || SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: candidateSummary,
          cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (e) {
    return { archetype: 'unknown', score: null, reason: `prefilter unavailable: ${(e.message || '').slice(0, 60)}` };
  }

  const text = (response.content?.[0]?.text || '').trim();

  // Try strict JSON parse first; fall back to regex extract
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[^}]+\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { archetype: 'unknown', score: null, reason: 'prefilter parse failed' };
  }

  // Validate + clamp
  const validArchetypes = ['frontend', 'backend', 'infra', 'machine_learning', 'fullstack'];
  const archetype = validArchetypes.includes(parsed.archetype) ? parsed.archetype : 'unknown';
  let score = parsed.score;
  if (typeof score !== 'number') score = null;
  else if (score < 0) score = 0;
  else if (score > 10) score = 10;
  else score = Math.round(score);
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 100) : '';

  return { archetype, score, reason };
}

const BUCKET_DEFS = [
  { name: 'strong', emoji: '🔥', label: 'Score ≥ 8 — Strong Match',  min: 8, max: 10 },
  { name: 'maybe',  emoji: '⚡', label: 'Score 6-7 — Worth a Look',    min: 6, max: 7 },
  { name: 'no',     emoji: '💤', label: 'Score 4-5 — Probably Not',    min: 4, max: 5 },
  { name: 'skip',   emoji: '🚫', label: 'Score ≤ 3 — Skip',             min: 0, max: 3 },
];

const ARCHETYPE_EMOJI = {
  backend: '🔧',
  infra: '🏗️',
  machine_learning: '🧠',
  frontend: '🎨',
  fullstack: '🌐',
  unknown: '❓',
};

const ARCHETYPE_LABEL = {
  backend: 'Backend',
  infra: 'Infra',
  machine_learning: 'Machine Learning',
  frontend: 'Frontend',
  fullstack: 'Fullstack',
  unknown: 'Unknown',
};

/**
 * Extract { url: 'x' | ' ' } checkbox state map from an existing digest markdown.
 */
function extractCheckboxState(existingMd) {
  if (!existingMd) return {};
  const state = {};
  const lines = existingMd.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[([ x])\]/);
    if (m) {
      // URL on next non-empty line
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const u = lines[j].match(/^\s*(https?:\/\/\S+)/);
        if (u) { state[u[1]] = m[1]; break; }
      }
    }
  }
  return state;
}

/**
 * Render the full digest.md content.
 */
export function renderDigest({ jobs, existingDigest, nowPst, totalJobs, bucketCounts, archetypeCounts }) {
  const checkboxState = extractCheckboxState(existingDigest);

  const lines = [];
  const dateHeader = nowPst ? nowPst.split(' ')[0] : new Date().toISOString().slice(0, 10);
  lines.push(`# Job Digest — ${dateHeader} (updated ${nowPst || new Date().toISOString()}, ${totalJobs} jobs)`);
  lines.push('');
  const totalsParts = [];
  totalsParts.push(`🔥 ${bucketCounts.strong || 0} strong`);
  totalsParts.push(`⚡ ${bucketCounts.maybe || 0} maybe`);
  totalsParts.push(`💤 ${bucketCounts.no || 0} probably-not`);
  totalsParts.push(`🚫 ${bucketCounts.skip || 0} skip`);
  lines.push(`**Totals**: ${totalsParts.join(' · ')}`);
  const archParts = Object.entries(archetypeCounts || {})
    .map(([a, n]) => `${a} ${n}`)
    .join(' · ');
  lines.push(`**By archetype**: ${archParts}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group jobs by bucket then archetype
  for (const bucket of BUCKET_DEFS) {
    const inBucket = jobs.filter(j => j.score !== null && j.score >= bucket.min && j.score <= bucket.max);
    if (inBucket.length === 0) continue;

    lines.push(`## ${bucket.emoji} ${bucket.label}`);
    lines.push('');

    const byArchetype = {};
    for (const j of inBucket) {
      (byArchetype[j.archetype] ??= []).push(j);
    }
    for (const arch of Object.keys(ARCHETYPE_LABEL)) {
      if (!byArchetype[arch]?.length) continue;
      lines.push(`### ${ARCHETYPE_EMOJI[arch]} ${ARCHETYPE_LABEL[arch]} (${byArchetype[arch].length})`);
      for (const j of byArchetype[arch].sort((a, b) => b.score - a.score)) {
        const check = checkboxState[j.url] === 'x' ? 'x' : ' ';
        const sourceLine = j.sources?.length ? `  Sources: [${j.sources.join(', ')}]` : '';
        lines.push(`- [${check}] **${j.score}/10** · ${j.company} · ${j.title} · ${j.location || ''}`);
        lines.push(`  ${j.url}`);
        lines.push(`  Why: ${j.reason || '(no reason)'}`);
        if (sourceLine) lines.push(sourceLine);
        lines.push('');
      }
    }
  }

  // Unavailable section
  const unavailable = jobs.filter(j => j.score === null);
  if (unavailable.length > 0) {
    lines.push(`## ⚠️ Pre-filter unavailable (${unavailable.length})`);
    lines.push('');
    for (const j of unavailable) {
      const check = checkboxState[j.url] === 'x' ? 'x' : ' ';
      lines.push(`- [${check}] ${j.company} · ${j.title} · ${j.location || ''}`);
      lines.push(`  ${j.url}`);
      lines.push(`  Reason: ${j.reason || 'unknown'}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
