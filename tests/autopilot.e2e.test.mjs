import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { buildDigest } from '../digest-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../__fixtures__/autopilot');

function loadFixture(relPath) {
  return readFileSync(join(FIXTURES, relPath), 'utf-8');
}

function mockHaiku(responseMap, companyToId) {
  // responseMap: { id → {archetype, score, reason} }
  // companyToId:  { companyName → id } — used to match prompts to fixture jobs
  //   because preFilterJob does NOT include the URL in the Haiku prompt;
  //   we discriminate by the job's Company line instead.
  return {
    messages: {
      create: async ({ messages }) => {
        const userText = messages[0].content;
        let id = null;
        for (const [company, mappedId] of Object.entries(companyToId || {})) {
          if (userText.includes(`Company: ${company}`)) {
            id = mappedId;
            break;
          }
        }
        const resp = responseMap[id] || { archetype: 'unknown', score: 0, reason: 'no mock' };
        return { content: [{ text: JSON.stringify(resp) }] };
      },
    },
  };
}

test('E2E: 4-job fixture → stage1+stage2+stage3 pipeline → expected digest structure', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));
  const apifyNew = JSON.parse(loadFixture('apify-new-example.json'));

  // Convert fixture jobs to candidateJobs shape
  const candidateJobs = apifyNew.new_jobs.map(j => ({
    ...j,
    sources: [`apify-${j.source_metro}`],
  }));

  // Mock Haiku: response per job.
  // Note: profile.yml's deal_breakers list does NOT include "Junior", so
  // job 3003 (Junior Backend Engineer) passes Stage 1 and reaches Haiku.
  const haikuClient = mockHaiku(
    {
      '3001': { archetype: 'infra', score: 9, reason: 'Exact Spark+Airflow match' },
      // 3002 is a legal role — "Infrastructure" matches positive filter so it
      //   passes Stage 1 → Haiku should score it 1
      '3002': { archetype: 'backend', score: 1, reason: 'Legal role, not engineering' },
      // 3003 is junior but not filtered (Junior NOT in deal_breakers) — Haiku
      //   should rate it low on stack+seniority match
      '3003': { archetype: 'backend', score: 3, reason: 'Junior role, stack match but entry-level' },
      '3004': { archetype: 'machine_learning', score: 8, reason: 'ML infra match' },
    },
    {
      'Acme Corp': '3001',
      'Globex': '3002',
      'Initech': '3003',
      'Anthropic': '3004',
    },
  );

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  // Stage 1: all 4 jobs pass (positive title keywords match: Infrastructure,
  //   Backend, ML; no deal-breaker match in current profile)
  assert.equal(result.stats.stage1_passed, 4, 'all 4 jobs pass title filter');
  // Stage 2: no duplicates in fixture, so still 4
  assert.equal(result.stats.stage2_passed, 4);
  // Stage 3: all 4 scored
  assert.equal(result.stats.total_scored, 4);

  // Bucket counts: 2 strong (3001=9, 3004=8), 0 maybe, 0 no, 2 skip (3002=1, 3003=3)
  assert.equal(result.stats.bucketCounts.strong, 2, '3001 and 3004 scored ≥ 8');
  assert.equal(result.stats.bucketCounts.skip, 2, '3002 (legal) and 3003 (junior) scored ≤ 3');

  // Digest contains expected sections
  assert.match(result.digestMd, /🔥 Score ≥ 8/);
  assert.match(result.digestMd, /🚫 Score ≤ 3/);
  assert.match(result.digestMd, /Acme Corp/);
  assert.match(result.digestMd, /Anthropic/);
  assert.match(result.digestMd, /Globex/);

  // Pipeline additions: only score ≥ 6 → 3001 and 3004
  assert.equal(result.pipelineAdditions.length, 2);
  assert.ok(result.pipelineAdditions.some(l => l.includes('3001')));
  assert.ok(result.pipelineAdditions.some(l => l.includes('3004')));

  // Notification mentions top job
  assert.match(result.notification, /Acme Corp|Anthropic/);
  assert.match(result.notification, /9\/10|8\/10/);
});

test('E2E: Haiku API failure → job falls into Unavailable bucket', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));
  const apifyNew = JSON.parse(loadFixture('apify-new-example.json'));

  const candidateJobs = apifyNew.new_jobs.slice(0, 1).map(j => ({
    ...j,
    sources: [`apify-${j.source_metro}`],
  }));

  const haikuClient = {
    messages: { create: async () => { throw new Error('rate limit'); } },
  };

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  assert.equal(result.stats.bucketCounts.unavailable, 1);
  assert.match(result.digestMd, /Pre-filter unavailable/);
});

test('E2E: blacklisted company → dropped in Stage 1 before Haiku runs', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));

  // Inject a Walmart job — should be blacklisted
  profile.target_roles = profile.target_roles || {};
  profile.target_roles.company_blacklist = ['Walmart', 'PayPal'];

  const candidateJobs = [
    {
      linkedin_id: '6001',
      url: 'https://www.linkedin.com/jobs/view/6001',
      title: 'Senior Backend Engineer',
      company: 'Walmart Labs',  // substring of "Walmart" blacklist entry
      location: 'SF',
      description: 'Backend role at Walmart. Go, Kafka, distributed systems.',
      source_metro: 'california',
      sources: ['apify-california'],
    },
    {
      linkedin_id: '6002',
      url: 'https://www.linkedin.com/jobs/view/6002',
      title: 'Staff Backend Engineer',
      company: 'Acme Corp',
      location: 'SF',
      description: 'Backend role at Acme. Go, Kafka, distributed systems.',
      source_metro: 'california',
      sources: ['apify-california'],
    },
  ];

  let haikuCalls = 0;
  const haikuClient = {
    messages: {
      create: async () => {
        haikuCalls++;
        return { content: [{ text: '{"archetype":"backend","score":8,"reason":"match"}' }] };
      },
    },
  };

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  assert.equal(result.stats.stage1_passed, 1, 'Walmart Labs blacklisted, only Acme passes');
  assert.equal(haikuCalls, 1, 'Haiku only called for non-blacklisted job');
  assert.ok(!result.digestMd.includes('Walmart'), 'Walmart absent from digest');
  assert.ok(result.digestMd.includes('Acme'), 'Acme present in digest');
});

test('E2E: cross-source duplicate via same jd_fingerprint → single entry in digest', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));

  // Same description = same fingerprint → stage 2 dedup
  const sameDescription = 'We need a backend engineer with Go, Kafka, and Postgres experience. 5+ years.';
  const candidateJobs = [
    {
      linkedin_id: '5001',
      url: 'https://www.linkedin.com/jobs/view/5001',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'SF',
      description: sameDescription,
      source_metro: 'california',
      sources: ['apify-california'],
    },
    {
      linkedin_id: '(none)',
      url: 'https://job-boards.greenhouse.io/acme/jobs/5001',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'SF',
      description: sameDescription,  // same content → same fingerprint
      source_metro: null,
      sources: ['scan-greenhouse'],
    },
  ];

  const haikuClient = mockHaiku(
    { '5001': { archetype: 'backend', score: 7, reason: 'Go match' } },
    { 'Acme': '5001' },
  );

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  assert.equal(result.stats.stage1_passed, 2);
  assert.equal(result.stats.stage2_passed, 1, 'cross-source dedup');
  assert.equal(result.stats.total_scored, 1);
});
