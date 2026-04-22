#!/usr/bin/env node
/**
 * assemble-cv.mjs — Build cv.tailored.md from experience_source/ + JD.
 *
 * Usage:
 *   node assemble-cv.mjs --jd=jds/some-job.md [--archetype=backend] [--feedback=.cv-tailored-errors.json]
 *
 * Outputs:
 *   cv.tailored.md
 *   .cv-tailored-meta.json   (debug: pools, scores, tier decisions)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
  loadArticleDigest, computeSkillsBonus,
} from './assemble-core.mjs';
import {
  defaultClient, classifyArchetype, pickBullets, extractJdIntent,
} from './assemble-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_ROOT = resolve(__dirname, 'experience_source');
const SYNONYMS_PATH = resolve(__dirname, 'config/synonyms.yml');
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const OUT_TAILORED = resolve(__dirname, 'cv.tailored.md');
const OUT_META = resolve(__dirname, '.cv-tailored-meta.json');

const SCORE_THRESHOLD = 1; // bullet keeps if it has >= 1 keyword hit

function parseArgs(argv) {
  const out = { jd: null, archetype: null, feedback: null };
  for (const a of argv) {
    if (a.startsWith('--jd=')) out.jd = a.split('=')[1];
    else if (a.startsWith('--archetype=')) out.archetype = a.split('=')[1];
    else if (a.startsWith('--feedback=')) out.feedback = a.split('=')[1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.jd) {
    console.error('Usage: node assemble-cv.mjs --jd=<path> [--archetype=...] [--feedback=...]');
    process.exit(1);
  }
  let excludeBullets = [];
  if (args.feedback) {
    try {
      const errs = JSON.parse(readFileSync(resolve(args.feedback), 'utf-8'));
      excludeBullets = (errs.errors || [])
        .filter(e => e.type === 'fabricated_bullet')
        .map(e => e.bullet);
    } catch {
      // feedback file not present or unreadable — proceed without
    }
  }

  const jdText = readFileSync(resolve(args.jd), 'utf-8');
  const config = loadConfig(PROFILE_PATH);
  const sources = loadAllSources(SOURCES_ROOT);
  validateConsistency(sources);

  const meta = { jd: args.jd, archetype: null, intent: null, companies: [] };

  // 1. Classify archetype (for logging / top_bullets_full defaults only — NOT facet filter)
  const archetype = args.archetype || await classifyArchetype(jdText);
  meta.archetype = archetype;

  // 1b. Extract JD intent — used to steer bullet picking beyond keyword scoring
  const intent = await extractJdIntent(jdText);
  meta.intent = intent;
  console.error(`[assemble-cv] JD intent: role_type=${intent.role_type}, focus="${intent.primary_focus}"`);
  if (intent.prefer_patterns?.length) console.error(`  PREFER: ${intent.prefer_patterns.join(' | ')}`);
  if (intent.deprioritize_patterns?.length) console.error(`  DEPRIORITIZE: ${intent.deprioritize_patterns.join(' | ')}`);

  // 2. Determine which facets to pull
  // NOTE: archetype is kept for logging / top_bullets_full defaults, but is NOT
  // used to filter facet files. We score bullets across ALL facets per company
  // and let keyword relevance + LLM judgment pick the best matches. A single JD
  // can legitimately surface bullets from backend.md + infra.md + machine_learning.md
  // within one company's entry when the role cuts across multiple facets.

  // 3. Build keyword set
  let keywords = extractKeywords(jdText);
  keywords = expandSynonyms(keywords, SYNONYMS_PATH);
  meta.keyword_count = keywords.size;

  // 4. Sort companies
  const allDirs = Object.keys(sources);
  const sortedDirs = await sortCompanies(SOURCES_ROOT, allDirs);

  // 5. For each company, build candidate pool, assign tier, ask LLM to pick
  const companies = [];
  const allProjects = [];
  const allSkills = new Set();

  for (const dir of sortedDirs) {
    const facetFiles = sources[dir];   // ALL facets — no archetype filter
    const pool = [];
    const skillsBonusesForCompany = {};
    for (const f of facetFiles) {
      const skillsBonus = computeSkillsBonus(f.skills, keywords);
      const facetFileName = basename(f._sourcePath);
      skillsBonusesForCompany[facetFileName] = skillsBonus;
      for (const b of f.bullets) {
        const baseScore = scoreBullet(b.text, keywords);
        const score = baseScore + skillsBonus;
        if (score >= SCORE_THRESHOLD) {
          pool.push({
            text: b.text,
            sourcePath: f._sourcePath,
            sourceLine: b.lineNumber,
            facet: f.frontmatter.facet,
            score,
            _baseScore: baseScore,
            _skillsBonus: skillsBonus,
          });
        }
      }
      for (const p of f.projects) {
        allProjects.push({
          text: p.text,
          sourcePath: f._sourcePath,
          sourceLine: p.lineNumber,
          score: scoreBullet(p.text, keywords),
        });
      }
      for (const s of f.skills) allSkills.add(s);
    }
    pool.sort((a, b) => b.score - a.score);

    const floor = config.experience_sources.overrides?.[dir]?.tier_floor || null;
    // Tier is based on BEST bullet match, not pool size. With cross-facet pools,
    // pool size is no longer a meaningful signal of JD-fit quality.
    //   top score ≥ 3  → full (strong match somewhere in the company's bullets)
    //   top score 1-2  → light (weak match — 1-2 bullets only)
    //   no score > 0   → stub (no JD-relevant bullets)
    const topScore = pool.length > 0 ? pool[0].score : 0;
    const poolProxy = topScore >= 3 ? 3 : (topScore >= 1 ? 1 : 0);
    const tier = assignTier(poolProxy, floor);
    const fmRef = sources[dir][0].frontmatter;
    // Always set stub — the renderer falls back to it when bullets array is
    // empty (e.g. tier_floor=light promoted an empty pool to "light" tier).
    const stub = config.experience_sources.overrides?.[dir]?.stub
      || `Worked at ${fmRef.company} as ${fmRef.role}.`;
    const co = { dir, frontmatter: fmRef, tier, stub };

    if (tier !== 'stub') {
      const n = tier === 'full'
        ? (config.archetype_defaults?.[archetype]?.top_bullets_full || 4)
        : (config.tier_rules?.light_bullets || 2);
      const truncated = pool.slice(0, Math.max(n * 2, n + 2));
      co.bullets = await pickBullets(truncated, jdText, Math.min(n, truncated.length), defaultClient(), excludeBullets, intent);
    }

    companies.push(co);
    meta.companies.push({
      dir,
      tier,
      pool_size: pool.length,
      picked: co.bullets?.length || (co.stub ? 1 : 0),
      skills_bonuses: skillsBonusesForCompany,
      top_pool_scores: pool.slice(0, 10).map(p => p.score),
    });
  }

  const articleProjects = loadArticleDigest(__dirname);
  for (const p of articleProjects) {
    if (!p.archetype || p.archetype === archetype) {
      allProjects.push({
        ...p,
        score: scoreBullet(p.text, keywords),
      });
    }
  }

  // 6. Projects: DISABLED (user preference — CV has no Personal Projects section).
  //    We still collect allProjects above for potential future use, but pass an
  //    empty array to the renderer so no "## Projects" section appears in
  //    cv.tailored.md — preventing downstream LLM from emitting one in HTML/LaTeX.
  const projects = [];
  void allProjects;  // intentional — collected but unused by renderer

  // 7. Competencies: skills ∩ keyword set, top 6-8
  const competencies = [...allSkills]
    .filter(s => keywords.has(s.toLowerCase()))
    .slice(0, 8);

  // 8. Summary: DISABLED (user preference — Professional Summary section removed).
  //    renderTailored skips the section when summary is empty.
  const summary = '';

  // 9. Render
  const md = renderTailored({ profile: config, companies, projects, competencies, summary });
  writeFileSync(OUT_TAILORED, md);
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2));

  console.log(JSON.stringify({ ok: true, output: OUT_TAILORED, archetype, companies: meta.companies }, null, 2));
}

main().catch(err => {
  console.error('assemble-cv.mjs failed:', err.message);
  process.exit(1);
});
