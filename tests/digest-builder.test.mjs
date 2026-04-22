import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTitleFilter } from '../digest-builder.mjs';

const filter = {
  positive: ['Backend', 'Infrastructure', 'Platform', 'Data Engineer', 'ML'],
  negative: ['.NET', 'Java Senior Developer'],
};
const dealBreakers = ['Intern', 'Junior', 'Contract'];

test('applyTitleFilter: positive match passes', () => {
  assert.equal(applyTitleFilter('Senior Backend Engineer', filter, dealBreakers), true);
});

test('applyTitleFilter: no positive match fails', () => {
  assert.equal(applyTitleFilter('Product Manager', filter, dealBreakers), false);
});

test('applyTitleFilter: negative match fails', () => {
  assert.equal(applyTitleFilter('.NET Backend Engineer', filter, dealBreakers), false);
});

test('applyTitleFilter: deal-breaker match fails', () => {
  assert.equal(applyTitleFilter('Junior Backend Engineer', filter, dealBreakers), false);
  assert.equal(applyTitleFilter('Software Engineering Intern, Backend', filter, dealBreakers), false);
});

test('applyTitleFilter: case-insensitive', () => {
  assert.equal(applyTitleFilter('senior backend engineer', filter, dealBreakers), true);
  assert.equal(applyTitleFilter('JUNIOR BACKEND', filter, dealBreakers), false);
});

import { isCompanyBlacklisted } from '../digest-builder.mjs';

const blacklist = [
  'RemoteHunter', 'Walmart', 'PayPal', 'Jobright.ai', 'Turing',
  'ByteDance', 'TikTok', 'Insight Global', 'CyberCoders',
  'Jobs via Dice', 'Open Talent',
];

test('isCompanyBlacklisted: exact match (case-insensitive)', () => {
  assert.equal(isCompanyBlacklisted('Walmart', blacklist), true);
  assert.equal(isCompanyBlacklisted('WALMART', blacklist), true);
  assert.equal(isCompanyBlacklisted('walmart', blacklist), true);
});

test('isCompanyBlacklisted: substring match (subsidiary names)', () => {
  assert.equal(isCompanyBlacklisted('Walmart Labs', blacklist), true);
  assert.equal(isCompanyBlacklisted('Walmart Connect', blacklist), true);
  assert.equal(isCompanyBlacklisted('PayPal Ventures', blacklist), true);
});

test('isCompanyBlacklisted: multi-word entries with punctuation', () => {
  assert.equal(isCompanyBlacklisted('Insight Global', blacklist), true);
  assert.equal(isCompanyBlacklisted('Jobs via Dice', blacklist), true);
  assert.equal(isCompanyBlacklisted('Open Talent', blacklist), true);
  assert.equal(isCompanyBlacklisted('Jobright.ai', blacklist), true);
});

test('isCompanyBlacklisted: TikTok and ByteDance variants', () => {
  assert.equal(isCompanyBlacklisted('TikTok', blacklist), true);
  assert.equal(isCompanyBlacklisted('ByteDance Inc', blacklist), true);
  assert.equal(isCompanyBlacklisted('Tiktok (ByteDance)', blacklist), true);
});

test('isCompanyBlacklisted: non-blacklisted company passes', () => {
  assert.equal(isCompanyBlacklisted('Anthropic', blacklist), false);
  assert.equal(isCompanyBlacklisted('Databricks', blacklist), false);
  assert.equal(isCompanyBlacklisted('Stripe', blacklist), false);
});

test('isCompanyBlacklisted: empty blacklist → everyone passes', () => {
  assert.equal(isCompanyBlacklisted('Walmart', []), false);
  assert.equal(isCompanyBlacklisted('Walmart', undefined), false);
});

test('isCompanyBlacklisted: empty company name → not blacklisted', () => {
  assert.equal(isCompanyBlacklisted('', blacklist), false);
  assert.equal(isCompanyBlacklisted(null, blacklist), false);
});

import { buildCandidateSummary } from '../digest-builder.mjs';

test('buildCandidateSummary: includes name + seniority + archetypes', () => {
  const profile = {
    candidate: { full_name: 'Test User' },
    target_roles: {
      archetypes_of_interest: ['backend', 'infra'],
      seniority_min: 'Mid-Senior',
      seniority_max: 'Staff',
    },
    narrative: { headline: 'Backend engineer' },
  };
  const sources = {
    acme: [
      {
        frontmatter: { company: 'Acme Corp', role: 'Senior Engineer' },
        bullets: [{ text: 'Built Go microservices' }, { text: 'Kafka pipelines' }],
        projects: [],
        skills: ['Go', 'Kafka'],
      },
    ],
  };
  const summary = buildCandidateSummary(profile, sources);
  assert.match(summary, /Test User/);
  assert.match(summary, /Mid-Senior/);
  assert.match(summary, /Staff/);
  assert.match(summary, /backend/i);
  assert.match(summary, /infra/i);
});

test('buildCandidateSummary: includes company+role lines from sources', () => {
  const profile = {
    candidate: { full_name: 'X' },
    target_roles: { archetypes_of_interest: ['backend'] },
  };
  const sources = {
    linkedin: [
      {
        frontmatter: { company: 'LinkedIn Corp', role: 'Software Engineer', start: '2025-01' },
        bullets: [{ text: 'GDPR data deletion' }],
        skills: ['Airflow', 'Spark'],
      },
    ],
  };
  const summary = buildCandidateSummary(profile, sources);
  assert.match(summary, /LinkedIn Corp/);
  assert.match(summary, /Software Engineer/);
  assert.match(summary, /Airflow/);
});

import { preFilterJob } from '../digest-builder.mjs';

function makeMockHaiku(fixedResponse) {
  return {
    messages: {
      create: async () => ({
        content: [{ text: fixedResponse }],
      }),
    },
  };
}

test('preFilterJob: parses valid JSON response', async () => {
  const mock = makeMockHaiku('{"archetype":"backend","score":8,"reason":"Go + Kafka match"}');
  const job = { title: 'Senior Backend Engineer', company: 'Acme', location: 'SF', description: 'Go, Kafka.' };
  const result = await preFilterJob(job, 'SYSTEM', 'PROFILE', mock);
  assert.equal(result.archetype, 'backend');
  assert.equal(result.score, 8);
  assert.equal(result.reason, 'Go + Kafka match');
});

test('preFilterJob: malformed JSON → score=null reason explains', async () => {
  const mock = makeMockHaiku('not-json-at-all');
  const job = { title: 'SWE', company: 'X', location: 'Y', description: 'Z' };
  const result = await preFilterJob(job, '', '', mock);
  assert.equal(result.score, null);
  assert.equal(result.archetype, 'unknown');
  assert.match(result.reason, /parse/i);
});

test('preFilterJob: clamps score outside 0-10', async () => {
  const mock = makeMockHaiku('{"archetype":"backend","score":15,"reason":"ok"}');
  const result = await preFilterJob({ title: 'x', company: 'x', location: 'x', description: 'x' }, '', '', mock);
  assert.equal(result.score, 10);
});

test('preFilterJob: API error → score=null unavailable', async () => {
  const mock = {
    messages: { create: async () => { throw new Error('rate limit'); } },
  };
  const result = await preFilterJob({ title: 'x', company: 'x', location: 'x', description: 'x' }, '', '', mock);
  assert.equal(result.score, null);
  assert.match(result.reason, /rate limit|unavailable/);
});

import { renderDigest } from '../digest-builder.mjs';

test('renderDigest: groups by score bucket then archetype', () => {
  const jobs = [
    { title: 'Backend Engineer', company: 'Acme', location: 'SF', url: 'https://x/1', archetype: 'backend', score: 9, reason: 'go match', sources: ['apify-california'] },
    { title: 'ML Eng', company: 'Globex', location: 'NY', url: 'https://x/2', archetype: 'machine_learning', score: 8, reason: 'llm work', sources: ['apify-new-york'] },
    { title: 'Infra Eng', company: 'Initech', location: 'Seattle', url: 'https://x/3', archetype: 'infra', score: 6, reason: 'k8s ok', sources: ['apify-seattle'] },
    { title: 'Jr Dev', company: 'X', location: 'Y', url: 'https://x/4', archetype: 'backend', score: 2, reason: 'junior', sources: ['apify-california'] },
  ];
  const md = renderDigest({
    jobs,
    nowPst: '2026-04-22 14:10 PST',
    totalJobs: 4,
    bucketCounts: { strong: 2, maybe: 1, no: 0, skip: 1, unavailable: 0 },
    archetypeCounts: { backend: 2, machine_learning: 1, infra: 1 },
  });
  assert.match(md, /## 🔥 Score ≥ 8/);
  assert.match(md, /### 🔧 Backend/);
  assert.match(md, /Acme/);
  assert.match(md, /9\/10/);
  assert.match(md, /## ⚡ Score 6-7/);
  assert.match(md, /Initech/);
  assert.match(md, /## 🚫 Score ≤ 3/);
});

test('renderDigest: preserves checkbox state from existing digest', () => {
  const existing = `# Job Digest — 2026-04-22 (updated 12:10 PST, 1 jobs)

## 🔥 Score ≥ 8 — Strong Match

### 🔧 Backend (1)
- [x] **9/10** · Acme · Backend Engineer · SF
  https://x/1
  Why: go match
`;
  const jobs = [
    { title: 'Backend Engineer', company: 'Acme', location: 'SF', url: 'https://x/1', archetype: 'backend', score: 9, reason: 'go match', sources: [] },
    { title: 'New Role', company: 'Globex', location: 'NY', url: 'https://x/2', archetype: 'backend', score: 8, reason: 'new', sources: [] },
  ];
  const md = renderDigest({
    jobs,
    existingDigest: existing,
    nowPst: '2026-04-22 14:10 PST',
    totalJobs: 2,
    bucketCounts: { strong: 2, maybe: 0, no: 0, skip: 0, unavailable: 0 },
    archetypeCounts: { backend: 2 },
  });
  assert.match(md, /\[x\].*Acme/, 'Acme retains checked state');
  assert.match(md, /\[ \].*New Role/, 'New job starts unchecked');
});
