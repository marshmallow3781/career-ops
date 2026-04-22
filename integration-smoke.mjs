#!/usr/bin/env node
/**
 * integration-smoke.mjs — Module-by-module smoke test against real experience_source data.
 *
 * Runs each module against /Users/xiaoxuan/resume/career-ops/experience_source/ + config/profile.yml
 * + jds/sample-data-platform.md. Reports results per module.
 *
 * Does NOT require ANTHROPIC_API_KEY — uses an injected mock LLM client.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
  parseSourceFile, parseArticleDigest, loadArticleDigest,
} from './assemble-core.mjs';
import {
  checkCompanyCoverage, checkBulletProvenance, checkChronologicalOrder,
  levenshteinRatio, extractCompanyHeaders, extractBulletsWithProvenance,
} from './validate-core.mjs';
import { pickBullets } from './assemble-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES = resolve(__dirname, 'experience_source');
const PROFILE = resolve(__dirname, 'config/profile.yml');
const JD = resolve(__dirname, 'jds/sample-data-platform.md');
const SYNONYMS = resolve(__dirname, 'config/synonyms.yml');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); pass++; };
const err = (m) => { console.log(`  ❌ ${m}`); fail++; };
const info = (m) => console.log(`     ${m}`);

console.log('\n🔬 Integration smoke test — Sherry Liao\'s real resume data\n');

// ── Module 1: parseSourceFile + loadAllSources + validateConsistency ─────
console.log('1. assemble-core: parseSourceFile + loadAllSources + validateConsistency');
let sources;
try {
  sources = loadAllSources(SOURCES);
  const dirs = Object.keys(sources).sort();
  if (JSON.stringify(dirs) === JSON.stringify(['bytedance', 'linkedin', 'pax', 'tiktok'])) {
    ok(`loadAllSources found 4 companies: ${dirs.join(', ')}`);
  } else {
    err(`unexpected dirs: ${dirs.join(', ')}`);
  }
  for (const [co, files] of Object.entries(sources)) {
    info(`  ${co}: ${files.length} facet file(s) — ${files.map(f => f.frontmatter.facet).join(', ')}`);
  }
  validateConsistency(sources);
  ok('cross-facet consistency: all roles/dates match within each company');
} catch (e) {
  err(`load/validate threw: ${e.message}`);
}

// ── Module 2: sortCompanies ──────────────────────────────────────────────
console.log('\n2. assemble-core: sortCompanies (reverse-chronological)');
const sortedDirs = await sortCompanies(SOURCES, Object.keys(sources));
const expected = ['linkedin', 'bytedance', 'pax', 'tiktok'];
if (JSON.stringify(sortedDirs) === JSON.stringify(expected)) {
  ok(`order: ${sortedDirs.join(' → ')}`);
} else {
  err(`order: ${sortedDirs.join(', ')} — expected ${expected.join(', ')}`);
}

// ── Module 3: loadConfig ─────────────────────────────────────────────────
console.log('\n3. assemble-core: loadConfig');
const config = loadConfig(PROFILE);
if (config.candidate?.full_name === 'Sherry Liao') ok('candidate.full_name parsed');
else err(`got: ${config.candidate?.full_name}`);
if (config.experience_sources?.overrides?.linkedin?.tier_floor === 'full') ok('overrides.linkedin.tier_floor=full parsed');
else err('overrides not parsed correctly');

// ── Module 4: extractKeywords + expandSynonyms ───────────────────────────
console.log('\n4. assemble-core: extractKeywords + expandSynonyms');
const jdText = readFileSync(JD, 'utf-8');
let kw = extractKeywords(jdText);
info(`raw keyword count: ${kw.size}`);
const expandedKw = expandSynonyms(kw, SYNONYMS);
info(`expanded keyword count: ${expandedKw.size} (delta: +${expandedKw.size - kw.size})`);
const samples = ['airflow', 'spark', 'kafka', 'gdpr', 'flink', 'distributed'];
const hits = samples.filter(s => expandedKw.has(s));
if (hits.length >= 4) ok(`keyword spot-check: found ${hits.length}/${samples.length} expected (${hits.join(', ')})`);
else err(`only found ${hits.length}/${samples.length}: ${hits.join(', ')}`);

// ── Module 5: scoreBullet on real bullets ────────────────────────────────
console.log('\n5. assemble-core: scoreBullet against real LinkedIn infra bullets');
const linkedinInfra = sources.linkedin.find(f => f.frontmatter.facet === 'infra');
for (const b of linkedinInfra.bullets) {
  const score = scoreBullet(b.text, expandedKw);
  info(`  score=${score}: "${b.text.slice(0, 70)}..."`);
}
const topScore = Math.max(...linkedinInfra.bullets.map(b => scoreBullet(b.text, expandedKw)));
if (topScore >= 3) ok(`top LinkedIn infra bullet has ${topScore} keyword hits`);
else err(`top score only ${topScore}, expected ≥3 — keywords or fixture mismatch`);

// ── Module 6: assignTier + per-company pool sizing ───────────────────────
console.log('\n6. assemble-core: assignTier per company (archetype=infra)');
const archetype = 'infra';
const facets = config.experience_sources.jd_archetype_sources[archetype];
info(`facets pulled for archetype=${archetype}: [${facets.join(', ')}]`);
const tierBreakdown = [];
for (const dir of sortedDirs) {
  const facetFiles = sources[dir].filter(f => facets.includes(f.frontmatter.facet));
  const pool = [];
  for (const f of facetFiles) {
    for (const b of f.bullets) {
      if (scoreBullet(b.text, expandedKw) >= 1) pool.push(b);
    }
  }
  const floor = config.experience_sources.overrides?.[dir]?.tier_floor || null;
  const tier = assignTier(pool.length, floor);
  tierBreakdown.push({ dir, tier, poolSize: pool.length, floor });
  info(`  ${dir}: pool=${pool.length}, floor=${floor || 'none'}, tier=${tier}`);
}
if (tierBreakdown.find(t => t.dir === 'linkedin').tier === 'full') ok('linkedin → full (real keywords match + tier_floor=full)');
else err('linkedin tier wrong');
if (tierBreakdown.find(t => t.dir === 'tiktok').tier !== 'full') ok(`tiktok → ${tierBreakdown.find(t => t.dir === 'tiktok').tier} (older infra-irrelevant role)`);

// ── Module 7: renderTailored ─────────────────────────────────────────────
console.log('\n7. assemble-core: renderTailored');

// Build minimal companies array for render
const companies = [];
for (const dir of sortedDirs) {
  const facetFiles = sources[dir].filter(f => facets.includes(f.frontmatter.facet));
  const pool = [];
  for (const f of facetFiles) {
    for (const b of f.bullets) {
      if (scoreBullet(b.text, expandedKw) >= 1) {
        pool.push({ text: b.text, sourcePath: f._sourcePath, sourceLine: b.lineNumber });
      }
    }
  }
  const floor = config.experience_sources.overrides?.[dir]?.tier_floor || null;
  const tier = assignTier(pool.length, floor);
  const fmRef = sources[dir][0].frontmatter;
  const stub = config.experience_sources.overrides?.[dir]?.stub
    || `Worked at ${fmRef.company} as ${fmRef.role}.`;
  const co = { dir, frontmatter: fmRef, tier, stub };
  if (tier !== 'stub') {
    co.bullets = pool.slice(0, tier === 'full' ? 5 : 2);
  }
  companies.push(co);
}
const md = renderTailored({
  profile: config,
  companies,
  projects: [],
  competencies: ['Airflow', 'Spark', 'Kafka', 'Flink', 'GDPR'],
  summary: 'Backend / Infrastructure Engineer with deep experience building privacy-compliant data systems.',
});
if (md.includes('# Sherry Liao')) ok('rendered header includes name');
else err('header missing');
if (md.includes('### LinkedIn Corporation')) ok('rendered LinkedIn company header');
else err('LinkedIn header missing');
const provenanceCount = (md.match(/<!-- src:/g) || []).length;
ok(`${provenanceCount} provenance markers embedded`);

// Save for module 8
const TAILORED_PATH = resolve(__dirname, 'cv.tailored.md');
writeFileSync(TAILORED_PATH, md);
info(`wrote ${TAILORED_PATH} (${md.length} bytes)`);

// ── Module 8: validate-core (all 3 checks) ───────────────────────────────
console.log('\n8. validate-core: run all three checks against rendered cv.tailored.md');

const requiredCompanies = Object.keys(sources);
const coverageErrors = checkCompanyCoverage(md, requiredCompanies);
if (coverageErrors.length === 0) ok(`CompanyCoverage: all ${requiredCompanies.length} companies present`);
else err(`coverage: ${coverageErrors.length} missing — ${coverageErrors.map(e => e.company).join(', ')}`);

const provenanceErrors = checkBulletProvenance(md, SOURCES);
if (provenanceErrors.length === 0) ok(`BulletProvenance: all ${provenanceCount} bullets traced to source`);
else err(`provenance: ${provenanceErrors.length} errors — first: ${provenanceErrors[0].type} on "${provenanceErrors[0].bullet?.slice(0, 50) || ''}"`);

const chronoErrors = checkChronologicalOrder(md, sortedDirs);
if (chronoErrors.length === 0) ok('ChronologicalOrder: linkedin → bytedance → pax → tiktok');
else err(`chronology: ${JSON.stringify(chronoErrors[0].found)}`);

// ── Module 9: assemble-llm.pickBullets with mock client ──────────────────
console.log('\n9. assemble-llm: pickBullets with mock LLM client');
const mockClient = {
  messages: {
    create: async ({ messages }) => {
      const txt = messages[0].content;
      const m = txt.match(/Pick the (\d+) bullets/);
      if (m) {
        const n = Number(m[1]);
        const block = txt.split('BULLETS:')[1].trim();
        const lines = block.split('\n').filter(l => /^\d+:/.test(l));
        const sel = lines.slice(0, n).map(l => {
          const [idx, ...rest] = l.split(':');
          return { index: Number(idx), text: rest.join(':').trim() };
        });
        return { content: [{ text: JSON.stringify({ selected: sel }) }] };
      }
      throw new Error('mockClient: bad prompt');
    },
  },
};
const linkedinPool = sources.linkedin
  .filter(f => f.frontmatter.facet === 'infra')[0]
  .bullets
  .map(b => ({ text: b.text, sourcePath: 'linkedin/infra.md', sourceLine: b.lineNumber }));
const picked = await pickBullets(linkedinPool, jdText, 3, mockClient);
if (picked.length === 3) ok(`pickBullets returned ${picked.length} bullets`);
else err(`got ${picked.length}, expected 3`);
info(`first picked: "${picked[0].text.slice(0, 70)}..."`);

// ── Module 10: article-digest parse (no file → empty) ────────────────────
console.log('\n10. assemble-core: loadArticleDigest (no article-digest.md present)');
const articleProjects = loadArticleDigest(__dirname);
if (articleProjects.length === 0) ok('loadArticleDigest returns [] when file absent');
else info(`found ${articleProjects.length} article-digest entries`);

// ── Summary ──────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`📊 Module integration: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
