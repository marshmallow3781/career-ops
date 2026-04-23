import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  findJobByLinkedinId, listRecentScanRuns,
} from '../lib/db.mjs';
import { runApifyScan } from '../apify-scan.mjs';

let mongod, client, db;
before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('test');
  connectWithClient(client, 'test');
  await ensureIndexes();
});
after(async () => {
  await closeDb();
  _resetDbForTesting();
  await client.close();
  await mongod.stop();
});
beforeEach(async () => {
  await db.collection('jobs').deleteMany({});
  await db.collection('scan_runs').deleteMany({});
});

function makeMockApifyClient(items) {
  return {
    actor: () => ({ call: async () => ({ defaultDatasetId: 'd1' }) }),
    dataset: () => ({ listItems: async () => ({ items }) }),
  };
}

test('runApifyScan: writes scan_run + upserts jobs to Mongo', async () => {
  const apifyClient = makeMockApifyClient([
    { jobUrl: 'https://www.linkedin.com/jobs/view/9001', title: 'Backend Eng', companyName: 'Acme', location: 'SF', description: 'Go Kafka.', postedTime: '1 hour ago' },
    { jobUrl: 'https://www.linkedin.com/jobs/view/9002', title: 'Platform Eng', companyName: 'Globex', location: 'SF', description: 'K8s Terraform.', postedTime: '2 hours ago' },
  ]);
  const config = {
    actor_id: 'TEST', api_token_env: 'F',
    default_params: { title: 'Software Engineer', proxy: {} },
    locations: [{ name: 'bay-area', location: 'SF Bay Area', geoId: '90000084', baseline_rows: 20, hourly_rows: 10 }],
    baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
    hourly: { params: { publishedAt: 'r86400' } },
  };
  const result = await runApifyScan({
    config,
    client: apifyClient,
    hourOverride: 7,
    seenJobsPath: '/tmp/unused.tsv',
    apifyNewPath: '/tmp/unused.json',
  });
  assert.equal(result.totalNew, 2);

  const job1 = await findJobByLinkedinId('9001');
  assert.ok(job1);
  assert.equal(job1.stage, 'raw');
  assert.equal(job1.company, 'Acme');
  assert.equal(job1.source_metro, 'bay-area');

  const runs = await listRecentScanRuns({});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, 'apify-linkedin');
  assert.equal(runs[0].metro, 'bay-area');
  assert.equal(runs[0].fetched_count, 2);
  assert.equal(runs[0].new_count, 2);
});

test('runApifyScan: re-seeing a job upserts without re-adding to raw', async () => {
  const apifyClient = makeMockApifyClient([
    { jobUrl: 'https://www.linkedin.com/jobs/view/9003', title: 'Infra', companyName: 'Init', location: 'SF', description: 'K8s.', postedTime: '3h' },
  ]);
  const config = {
    actor_id: 'T', api_token_env: 'F',
    default_params: { title: 'SWE', proxy: {} },
    locations: [{ name: 'bay-area', location: 'SF', geoId: 'g', baseline_rows: 5, hourly_rows: 5 }],
    baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
    hourly: { params: { publishedAt: 'r86400' } },
  };
  await runApifyScan({ config, client: apifyClient, hourOverride: 7, seenJobsPath: '/tmp/x.tsv', apifyNewPath: '/tmp/x.json' });
  const first = await findJobByLinkedinId('9003');

  await new Promise(r => setTimeout(r, 5));
  const result = await runApifyScan({ config, client: apifyClient, hourOverride: 7, seenJobsPath: '/tmp/x.tsv', apifyNewPath: '/tmp/x.json' });
  assert.equal(result.totalNew, 0);

  const second = await findJobByLinkedinId('9003');
  assert.equal(second.first_seen_at.getTime(), first.first_seen_at.getTime(), 'first_seen preserved');
  assert.ok(second.last_seen_at.getTime() >= first.last_seen_at.getTime(), 'last_seen advanced');
  assert.equal(second.stage_history.length, 1, 'did not re-append raw');
});
