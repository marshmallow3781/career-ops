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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
  loadArticleDigest,
} from './assemble-core.mjs';
import {
  defaultClient, classifyArchetype, pickBullets, writeSummary,
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

  const meta = { jd: args.jd, archetype: null, companies: [] };

  // 1. Classify archetype
  const archetype = args.archetype || await classifyArchetype(jdText);
  meta.archetype = archetype;

  // 2. Determine which facets to pull
  const facetsToUse = config.experience_sources.jd_archetype_sources[archetype];
  if (!facetsToUse) throw new Error(`No jd_archetype_sources entry for "${archetype}"`);

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
    const facetFiles = sources[dir].filter(f => facetsToUse.includes(f.frontmatter.facet));
    const pool = [];
    for (const f of facetFiles) {
      for (const b of f.bullets) {
        const score = scoreBullet(b.text, keywords);
        if (score >= SCORE_THRESHOLD) {
          pool.push({
            text: b.text,
            sourcePath: f._sourcePath,
            sourceLine: b.lineNumber,
            score,
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
    const tier = assignTier(pool.length, floor);
    const fmRef = sources[dir][0].frontmatter;
    const co = { dir, frontmatter: fmRef, tier };

    if (tier === 'stub') {
      co.stub = config.experience_sources.overrides?.[dir]?.stub
        || `Worked at ${fmRef.company} as ${fmRef.role}.`;
    } else {
      const n = tier === 'full'
        ? (config.archetype_defaults?.[archetype]?.top_bullets_full || 4)
        : (config.tier_rules?.light_bullets || 2);
      const truncated = pool.slice(0, Math.max(n * 2, n + 2));
      co.bullets = await pickBullets(truncated, jdText, Math.min(n, truncated.length), defaultClient(), excludeBullets);
    }

    companies.push(co);
    meta.companies.push({ dir, tier, pool_size: pool.length, picked: co.bullets?.length || (co.stub ? 1 : 0) });
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

  // 6. Projects: top-N across all
  const topProjects = config.archetype_defaults?.[archetype]?.top_projects || 3;
  allProjects.sort((a, b) => b.score - a.score);
  const projects = allProjects.slice(0, topProjects);

  // 7. Competencies: skills ∩ keyword set, top 6-8
  const competencies = [...allSkills]
    .filter(s => keywords.has(s.toLowerCase()))
    .slice(0, 8);

  // 8. Summary
  const summary = await writeSummary(config, jdText);

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
