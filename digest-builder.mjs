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

import 'dotenv/config';
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

const HAIKU_MODEL = process.env.LLM_MODEL || process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

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
 * Pre-filter one job via the configured LLM provider (Anthropic / MiniMax / etc.).
 *
 * @param {object} job
 * @param {string} systemPrompt
 * @param {string} candidateSummary
 * @param {object} client — provider client (Anthropic or OpenAI-compat) — injectable
 * @param {object} [config] — LLM config (if null, reads from env via lib/llm.mjs)
 * @returns {Promise<{archetype, score, reason}>} where score is integer 0-10 or null
 */
export async function preFilterJob(job, systemPrompt, candidateSummary, client, config = null) {
  const userMessage =
    `<job>\nTitle: ${job.title || ''}\nCompany: ${job.company || ''}\n` +
    `Location: ${job.location || ''}\nDescription:\n` +
    `${(job.description || '').slice(0, 3000)}\n</job>\n\nReturn JSON.`;

  // Build system blocks — cache_control only applies to Anthropic
  const providerIsAnthropic = !config || config.provider === 'anthropic';
  const systemBlocks = providerIsAnthropic
    ? [
        { type: 'text', text: systemPrompt || SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: candidateSummary,
          cache_control: { type: 'ephemeral', ttl: '1h' } },
      ]
    : [
        { type: 'text', text: systemPrompt || SYSTEM_PROMPT },
        { type: 'text', text: candidateSummary },
      ];

  let text;
  try {
    if (providerIsAnthropic) {
      // Legacy path: client is an Anthropic instance with messages.create
      const response = await client.messages.create({
        model: (config && config.model) || HAIKU_MODEL,
        max_tokens: 120,
        temperature: 0,
        system: systemBlocks,
        messages: [{ role: 'user', content: userMessage }],
      });
      text = (response.content?.[0]?.text || '').trim();
    } else {
      // OpenAI-compatible path (MiniMax, OpenAI, DeepSeek, etc.)
      const systemText = systemBlocks.map(b => b.text).join('\n\n');
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: 120,
        temperature: 0,
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userMessage },
        ],
      });
      text = (response.choices?.[0]?.message?.content || '').trim();
    }
  } catch (e) {
    return { archetype: 'unknown', score: null, reason: `prefilter unavailable: ${(e.message || '').slice(0, 60)}` };
  }

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

/**
 * Main digest-builder orchestrator (injectable for tests).
 * @param {object} args
 * @param {object} args.profile — parsed config/profile.yml
 * @param {object} args.portals — parsed portals.yml (for title_filter)
 * @param {object} args.sources — experience_source parsed (from assemble-core.loadAllSources)
 * @param {object[]} args.candidateJobs — jobs from apify-new + scan output to triage
 * @param {string} args.existingDigest — current digest.md content (empty for 7am)
 * @param {object} args.haikuClient — LLM client (Anthropic or OpenAI-compat; mocked in tests)
 * @param {object} [args.llmConfig] — { provider, model, apiKey, baseURL } — if omitted, Anthropic path is assumed (back-compat)
 * @param {boolean} args.dryRun
 * @returns {Promise<{digestMd, pipelineAdditions, notification, stats}>}
 */
export async function buildDigest({ profile, portals, sources, candidateJobs, existingDigest, haikuClient, llmConfig, dryRun }) {
  const dealBreakers = profile?.target_roles?.deal_breakers || [];
  const companyBlacklist = profile?.target_roles?.company_blacklist || [];
  const titleFilter = portals?.title_filter || { positive: [], negative: [] };

  // Stage 1 — free rule-based filter (title keywords + deal-breakers + company blacklist)
  const stage1 = candidateJobs.filter(j =>
    applyTitleFilter(j.title, titleFilter, dealBreakers) &&
    !isCompanyBlacklisted(j.company, companyBlacklist)
  );

  // Stage 2 — fingerprint dedup (within this batch + against history via seen.fingerprints)
  const seenInBatch = new Set();
  const stage2 = [];
  for (const j of stage1) {
    const fp = j.jd_fingerprint || (j.description ? computeJdFingerprint(j.description) : null);
    if (fp && seenInBatch.has(fp)) continue;
    if (fp) seenInBatch.add(fp);
    stage2.push(j);
  }

  // Stage 3 — Haiku pre-filter (sequential for cache hit-rate)
  const candidateSummary = buildCandidateSummary(profile, sources);
  const prefiltered = [];
  for (const j of stage2) {
    const { archetype, score, reason } = await preFilterJob(j, SYSTEM_PROMPT, candidateSummary, haikuClient, llmConfig);
    prefiltered.push({ ...j, archetype, score, reason });
  }

  // Compute bucket + archetype counts
  const bucketCounts = { strong: 0, maybe: 0, no: 0, skip: 0, unavailable: 0 };
  const archetypeCounts = {};
  for (const j of prefiltered) {
    archetypeCounts[j.archetype] = (archetypeCounts[j.archetype] || 0) + 1;
    if (j.score === null) bucketCounts.unavailable++;
    else if (j.score >= 8) bucketCounts.strong++;
    else if (j.score >= 6) bucketCounts.maybe++;
    else if (j.score >= 4) bucketCounts.no++;
    else bucketCounts.skip++;
  }

  // Render digest.md
  const nowPst = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const digestMd = renderDigest({
    jobs: prefiltered,
    existingDigest,
    nowPst: nowPst + ' PST',
    totalJobs: prefiltered.length,
    bucketCounts,
    archetypeCounts,
  });

  // Pipeline additions — score ≥ 6 only, format matches pipeline.md
  const pipelineAdditions = prefiltered
    .filter(j => j.score !== null && j.score >= 6)
    .map(j => `- [ ] ${j.url} | ${j.company} | ${j.title}  <!-- prefilter: ${j.score}/10 ${j.archetype} -->`);

  // Notification text
  const topJob = prefiltered.filter(j => j.score !== null).sort((a, b) => b.score - a.score)[0];
  const notification = topJob
    ? `${prefiltered.length} new jobs, top: ${topJob.company} (${topJob.score}/10)`
    : `${prefiltered.length} new jobs (no pre-filter results)`;

  return {
    digestMd,
    pipelineAdditions,
    notification,
    stats: {
      total_scored: prefiltered.length,
      stage1_passed: stage1.length,
      stage2_passed: stage2.length,
      bucketCounts,
      archetypeCounts,
    },
  };
}

/**
 * Load all data/apify-new-*.json files that haven't been archived, plus
 * optionally recent scan.mjs pipeline.md additions. Returns merged job list.
 */
function loadCandidateJobs() {
  const jobs = [];
  if (existsSync(DATA_DIR)) {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith(APIFY_NEW_GLOB) && f.endsWith('.json'));
    for (const f of files) {
      try {
        const content = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8'));
        for (const j of content.new_jobs || []) {
          jobs.push({
            ...j,
            source: `apify-linkedin-${j.source_metro || 'unknown'}`,
            sources: [`apify-${j.source_metro || 'unknown'}`],
            jd_fingerprint: j.description ? computeJdFingerprint(j.description) : null,
          });
        }
      } catch (e) {
        console.error(`[digest] failed to parse ${f}: ${e.message}`);
      }
    }
  }
  return jobs;
}

/**
 * Archive processed apify-new-*.json files after successful digest build.
 */
function archiveApifyNewFiles() {
  if (!existsSync(APIFY_ARCHIVE_DIR)) mkdirSync(APIFY_ARCHIVE_DIR, { recursive: true });
  const files = readdirSync(DATA_DIR).filter(f => f.startsWith(APIFY_NEW_GLOB) && f.endsWith('.json'));
  for (const f of files) {
    try {
      renameSync(join(DATA_DIR, f), join(APIFY_ARCHIVE_DIR, f));
    } catch (e) {
      console.error(`[digest] failed to archive ${f}: ${e.message}`);
    }
  }
}

/**
 * Archive yesterday's digest.md to digest-history/ and start fresh.
 * Called only at 7am.
 */
function archiveYesterdayDigest() {
  if (!existsSync(DIGEST_PATH)) return;
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  // Extract date from the existing digest's first line if possible
  const content = readFileSync(DIGEST_PATH, 'utf-8');
  const m = content.match(/^# Job Digest — (\d{4}-\d{2}-\d{2})/);
  const dateStr = m ? m[1] : new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const target = join(HISTORY_DIR, `${dateStr}.md`);
  if (!existsSync(target)) {
    renameSync(DIGEST_PATH, target);
  }
  // Prune older than 30 days
  const cutoff = Date.now() - 30 * 86400000;
  for (const f of readdirSync(HISTORY_DIR)) {
    const dm = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dm) continue;
    const fileDate = new Date(dm[1]).getTime();
    if (fileDate < cutoff) {
      try { unlinkSync(join(HISTORY_DIR, f)); } catch { /* ignore */ }
    }
  }
}

/**
 * Send a macOS notification via osascript.
 */
function notify(text) {
  try {
    execFileSync('osascript', ['-e',
      `display notification "${text.replace(/"/g, '\\"')}" with title "career-ops autopilot"`],
      { stdio: 'ignore' });
  } catch { /* notification failure should not crash digest */ }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const profilePath = resolve(__dirname, 'config/profile.yml');
  const portalsPath = resolve(__dirname, 'portals.yml');
  if (!existsSync(profilePath)) {
    console.error(`Missing config/profile.yml — copy from config/profile.example.yml`);
    process.exit(1);
  }
  const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  const portals = existsSync(portalsPath)
    ? yaml.load(readFileSync(portalsPath, 'utf-8'))
    : { title_filter: { positive: [], negative: [] } };

  // Load experience_source via assemble-core (shared module)
  const { loadAllSources } = await import('./assemble-core.mjs');
  const sourcesRoot = resolve(__dirname, profile.experience_sources?.root || 'experience_source');
  const sources = existsSync(sourcesRoot) ? loadAllSources(sourcesRoot) : {};

  const candidateJobs = loadCandidateJobs();

  // Check if 7am (baseline) for archive
  const hourPst = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }),
    10
  );
  const isBaseline = hourPst === 7;

  if (!dryRun && isBaseline) {
    archiveYesterdayDigest();
  }

  const existingDigest = existsSync(DIGEST_PATH) ? readFileSync(DIGEST_PATH, 'utf-8') : '';

  // Build LLM config + client based on env (LLM_PROVIDER, LLM_MODEL, LLM_API_KEY, LLM_BASE_URL)
  // Defaults to anthropic+claude-haiku-4-5 if LLM_PROVIDER is unset.
  let llmConfig = null;
  let haikuClient;
  if (dryRun) {
    // Dry-run: mock both Anthropic and OpenAI-compat shapes
    haikuClient = {
      messages: { create: async () => ({ content: [{ text: '{"archetype":"unknown","score":null,"reason":"dry run"}' }] }) },
      chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"archetype":"unknown","score":null,"reason":"dry run"}' } }] }) } },
    };
  } else {
    const { initLlm } = await import('./lib/llm.mjs');
    const initialized = initLlm();
    llmConfig = initialized.config;
    haikuClient = initialized.client;
    console.error(`[digest-builder] using LLM provider=${llmConfig.provider} model=${llmConfig.model}`);
  }

  const result = await buildDigest({
    profile, portals, sources, candidateJobs,
    existingDigest, haikuClient, llmConfig, dryRun,
  });

  if (!dryRun) {
    writeFileSync(DIGEST_PATH, result.digestMd);
    if (result.pipelineAdditions.length > 0) {
      const pipelineContent = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '## Pendientes\n\n';
      // Find "## Pendientes" and insert after it
      let updated;
      const marker = '## Pendientes';
      const idx = pipelineContent.indexOf(marker);
      if (idx !== -1) {
        const insertAt = idx + marker.length;
        updated = pipelineContent.slice(0, insertAt) + '\n' + result.pipelineAdditions.join('\n') + pipelineContent.slice(insertAt);
      } else {
        updated = `## Pendientes\n\n${result.pipelineAdditions.join('\n')}\n\n${pipelineContent}`;
      }
      writeFileSync(PIPELINE_PATH, updated);
    }
    archiveApifyNewFiles();
    notify(result.notification);
  }

  console.log(JSON.stringify({
    dryRun,
    ...result.stats,
    notification: result.notification,
    digest_path: DIGEST_PATH,
    pipeline_additions: result.pipelineAdditions.length,
  }, null, 2));
}

// Run as CLI unless imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('digest-builder.mjs crashed:', err);
    process.exit(2);
  });
}
