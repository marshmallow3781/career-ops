import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
} from '../assemble-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../__fixtures__');

// Mock LLM client: returns first N from pool, no rephrasing
function mockClient(archetypeAnswer) {
  return {
    messages: {
      create: async ({ messages }) => {
        const userText = messages[0].content;
        if (/Classify this JD/.test(userText)) {
          return { content: [{ text: archetypeAnswer }] };
        }
        if (/describe the engineer archetype/.test(userText)) {
          return { content: [{ text: JSON.stringify({
            primary_focus: 'Test role focused on mock work',
            prefer_patterns: [
              'Test engineer with general skills',
              'Generalist engineer for testing',
              'Engineer comfortable with test fixtures',
            ],
          }) }] };
        }
        if (/Pick the (\d+) bullets/.test(userText)) {
          const n = Number(userText.match(/Pick the (\d+) bullets/)[1]);
          const bulletsBlock = userText.split('BULLETS:')[1].trim();
          const lines = bulletsBlock.split('\n').filter(l => /^\d+(?:\s+\[[^\]]+\])?:/.test(l));
          const selected = lines.slice(0, n).map(l => {
            const match = l.match(/^(\d+)(?:\s+\[[^\]]+\])?:\s*(.*)$/);
            return { index: Number(match[1]), text: match[2].trim() };
          });
          return { content: [{ text: JSON.stringify({ selected }) }] };
        }
        if (/Professional Summary/.test(userText)) {
          return { content: [{ text: 'Mock summary for testing.' }] };
        }
        throw new Error(`mockClient: unrecognized prompt: ${userText.slice(0, 120)}`);
      },
    },
  };
}

test('e2e: backend JD pulls bullets from acme + globex backend, initech as light', async () => {
  const config = loadConfig(resolve(FIXTURES, 'profile.yml'));
  const jdText = readFileSync(resolve(FIXTURES, 'jds/backend-jd.md'), 'utf-8');
  const sourcesRoot = resolve(FIXTURES, 'experience_source');
  const sources = loadAllSources(sourcesRoot);
  validateConsistency(sources);

  const archetype = 'backend';
  const facets = config.experience_sources.jd_archetype_sources[archetype];

  let keywords = extractKeywords(jdText);
  keywords = expandSynonyms(keywords, resolve(__dirname, '../config/synonyms.yml'));

  const sortedDirs = await sortCompanies(sourcesRoot, Object.keys(sources));
  // Expect: acme (start 2023) → globex (2020) → initech (2017)
  assert.deepEqual(sortedDirs, ['acme', 'globex', 'initech']);

  const client = mockClient('backend');
  const { pickBullets } = await import('../assemble-llm.mjs');

  const companies = [];
  for (const dir of sortedDirs) {
    const facetFiles = sources[dir].filter(f => facets.includes(f.frontmatter.facet));
    const pool = [];
    for (const f of facetFiles) {
      for (const b of f.bullets) {
        if (scoreBullet(b.text, keywords) >= 1) {
          pool.push({ text: b.text, sourcePath: f._sourcePath, sourceLine: b.lineNumber });
        }
      }
    }
    const floor = config.experience_sources.overrides?.[dir]?.tier_floor || null;
    const tier = assignTier(pool.length, floor);
    const fmRef = sources[dir][0].frontmatter;
    const co = { dir, frontmatter: fmRef, tier };
    if (tier === 'stub') {
      co.stub = config.experience_sources.overrides?.[dir]?.stub || `Worked at ${fmRef.company}.`;
    } else {
      const n = tier === 'full' ? 4 : 2;
      co.bullets = await pickBullets(pool.slice(0, n + 2), jdText, Math.min(n, pool.length), client);
    }
    companies.push(co);
  }

  // Acme should be full tier (multiple keyword-matching bullets)
  assert.equal(companies[0].dir, 'acme');
  assert.equal(companies[0].tier, 'full');
  assert.ok(companies[0].bullets.length >= 2);

  // Globex backend should also have hits
  assert.equal(companies[1].dir, 'globex');
  assert.notEqual(companies[1].tier, 'stub');

  // Initech (only infra facet for this archetype, but no infra is in jd_archetype_sources[backend])
  // → no facet file matches → empty pool → would be stub, but tier_floor=light → light
  assert.equal(companies[2].dir, 'initech');
  assert.equal(companies[2].tier, 'light');
});
