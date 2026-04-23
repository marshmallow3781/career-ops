import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the main orchestrator function. It accepts an injected client for testing.
import { runApifyScan } from '../apify-scan.mjs';

async function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'apify-scan-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeMockClient(itemsByLocation) {
  return {
    actor: (_id) => ({
      call: async (input) => {
        // Store items keyed by input.location so the dataset(id).listItems can find them
        return { defaultDatasetId: input.location };
      },
    }),
    dataset: (id) => ({
      listItems: async () => ({ items: itemsByLocation[id] || [] }),
    }),
  };
}

test('runApifyScan: baseline hour fetches all metros in parallel, dedups via seen-set', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
        { name: 'seattle',    location: 'Greater Seattle Area',       baseline_rows: 300, hourly_rows: 100 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    const client = makeMockClient({
      'California, United States': [
        { url: 'https://www.linkedin.com/jobs/view/1001', title: 'Backend Engineer', company: 'Acme', location: 'SF', description: 'We want a backend engineer with Go experience.' },
        { url: 'https://www.linkedin.com/jobs/view/1002', title: 'Frontend Engineer', company: 'Globex', location: 'SF', description: 'React and TypeScript.' },
      ],
      'Greater Seattle Area': [
        { url: 'https://www.linkedin.com/jobs/view/1003', title: 'Infra Engineer', company: 'Initech', location: 'Seattle', description: 'Kubernetes, Terraform, AWS.' },
      ],
    });

    const result = await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,
    });

    assert.equal(result.totalNew, 3, 'all 3 jobs are new');
    assert.equal(result.sources.length, 2);
    assert.ok(existsSync(join(dir, 'seen-jobs.tsv')), 'seen-jobs.tsv written');
    assert.ok(existsSync(join(dir, 'apify-new-TEST.json')), 'apify-new json written');
  });
});

test('runApifyScan: hourly hour fetches with smaller row cap', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    let capturedInput;
    const client = {
      actor: (_id) => ({
        call: async (input) => { capturedInput = input; return { defaultDatasetId: 'd' }; },
      }),
      dataset: (_id) => ({
        listItems: async () => ({ items: [] }),
      }),
    };

    await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 9,
    });

    assert.equal(capturedInput.rows, 200, 'hourly uses hourly_rows cap');
    assert.equal(capturedInput.publishedAt, 'r7200', 'hourly uses r7200 window');
  });
});

test('runApifyScan: one metro failure does not block others (Promise.allSettled)', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: {} },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
        { name: 'seattle',    location: 'Greater Seattle Area',       baseline_rows: 300, hourly_rows: 100 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    const client = {
      actor: (_id) => ({
        call: async (input) => {
          if (input.location === 'Greater Seattle Area') {
            throw new Error('Apify rate limit');
          }
          return { defaultDatasetId: 'd' };
        },
      }),
      dataset: (_id) => ({
        listItems: async () => ({
          items: [{ url: 'https://www.linkedin.com/jobs/view/2001', title: 'Backend Eng', company: 'Acme', location: 'SF', description: 'Go, Kafka.' }],
        }),
      }),
    };

    const result = await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,
    });

    assert.equal(result.totalNew, 1, 'california succeeded');
    assert.equal(result.errors.length, 1, 'seattle error captured');
    assert.match(result.errors[0].error, /rate limit/);
  });
});

test('runApifyScan: reads new actor schema (jobUrl / companyName)', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: {} },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    const client = makeMockClient({
      'California, United States': [
        // New-schema fields (current actor output)
        { jobUrl: 'https://www.linkedin.com/jobs/view/3001', title: 'Backend Eng', companyName: 'Acme', location: 'SF', description: 'Go, Kafka.', publishedAt: '2026-04-22' },
      ],
    });

    const result = await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,
    });

    assert.equal(result.totalNew, 1, 'new-schema item was processed');
    const tsv = readFileSync(join(dir, 'seen-jobs.tsv'), 'utf-8');
    assert.match(tsv, /3001/, 'linkedin_id extracted from jobUrl');
    assert.match(tsv, /acme/, 'company_slug derived from companyName');
  });
});

test('runApifyScan: filters blacklisted companies BEFORE dedup', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: {} },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    const client = makeMockClient({
      'California, United States': [
        { jobUrl: 'https://www.linkedin.com/jobs/view/4001', title: 'SWE', companyName: 'Acme',           location: 'SF', description: 'x' },
        { jobUrl: 'https://www.linkedin.com/jobs/view/4002', title: 'SWE', companyName: 'Turing',         location: 'SF', description: 'y' },
        { jobUrl: 'https://www.linkedin.com/jobs/view/4003', title: 'SWE', companyName: 'Jobs via Dice',  location: 'SF', description: 'z' },
        { jobUrl: 'https://www.linkedin.com/jobs/view/4004', title: 'SWE', companyName: 'Walmart Labs',   location: 'SF', description: 'q' },  // substring match via "Walmart"
      ],
    });

    const result = await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,
      blacklist: ['Turing', 'Jobs via Dice', 'Walmart'],
    });

    assert.equal(result.totalNew, 1, 'only Acme survives the blacklist');
    assert.equal(result.sources[0].blacklisted, 3, '3 items blacklisted per-metro telemetry');
    // Blacklisted companies must NOT appear in seen-jobs.tsv (filtered before dedup)
    const tsv = readFileSync(join(dir, 'seen-jobs.tsv'), 'utf-8');
    assert.match(tsv, /4001/, 'Acme saved');
    assert.doesNotMatch(tsv, /4002/, 'Turing not saved');
    assert.doesNotMatch(tsv, /4003/, 'Jobs via Dice not saved');
    assert.doesNotMatch(tsv, /4004/, 'Walmart Labs not saved (substring match)');
  });
});

test('runApifyScan: empty or missing blacklist is a no-op', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: {} },
      locations: [{ name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 }],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    const client = makeMockClient({
      'California, United States': [
        { jobUrl: 'https://www.linkedin.com/jobs/view/5001', title: 'SWE', companyName: 'Turing', location: 'SF', description: 'x' },
      ],
    });

    const result = await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,
      // no blacklist arg
    });

    assert.equal(result.totalNew, 1, 'Turing saved when blacklist is empty/omitted');
    assert.equal(result.sources[0].blacklisted, 0);
  });
});

test('runApifyScan: scanOneLocation filters null fields from input to actor', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      // These nulls simulate the real config/apify-search.yml layout for
      // "all" filters. The actor rejects nulls outright, so they must be
      // stripped before dispatching.
      default_params: {
        title: 'Software Engineer',
        workType: null,
        contractType: null,
        experienceLevel: null,
        proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
      },
      locations: [
        { name: 'california', location: 'California, United States', geoId: '102095887', baseline_rows: 500, hourly_rows: 200 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    let capturedInput;
    const client = {
      actor: (_id) => ({
        call: async (input) => { capturedInput = input; return { defaultDatasetId: 'd' }; },
      }),
      dataset: (_id) => ({ listItems: async () => ({ items: [] }) }),
    };

    await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,
    });

    assert.ok(!('workType' in capturedInput), 'null workType stripped');
    assert.ok(!('contractType' in capturedInput), 'null contractType stripped');
    assert.ok(!('experienceLevel' in capturedInput), 'null experienceLevel stripped');
    assert.equal(capturedInput.title, 'Software Engineer', 'non-null title kept');
    assert.equal(capturedInput.geoId, '102095887', 'geoId from location passed through');
  });
});
