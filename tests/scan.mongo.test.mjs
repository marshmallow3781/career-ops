import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  findJobsBySeenUrls, listRecentScanRuns,
} from '../lib/db.mjs';

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

test('scan.mjs Mongo: writing scan_run + upserting jobs end-to-end', async () => {
  // Import scanJobsToMongo (new helper we're adding) — runs the Mongo-write
  // portion of scan.mjs against a prepared set of jobs + config.
  const { scanJobsToMongo } = await import('../scan.mjs');
  const jobs = [
    { url: 'https://greenhouse.io/acme/jobs/1', title: 'Backend Eng', company: 'Acme', location: 'SF, CA', description: 'Go Kafka', api_type: 'greenhouse', posted_at: '2026-04-22T10:00:00Z', updated_at: null },
    { url: 'https://greenhouse.io/acme/jobs/2', title: 'Infra Eng',   company: 'Acme', location: 'Seattle, WA', description: 'K8s',   api_type: 'greenhouse', posted_at: '2026-04-22T11:00:00Z', updated_at: null },
  ];
  const result = await scanJobsToMongo({
    jobs,
    runStartedAt: new Date('2026-04-22T12:00:00Z'),
    runFinishedAt: new Date('2026-04-22T12:01:00Z'),
    totalFetched: 2,
    totalBlacklisted: 0,
    totalFiltered: 0,
    totalLocationFiltered: 0,
    totalStale: 0,
    sourceTypes: ['greenhouse'],
    errors: [],
  });

  assert.ok(result.scanRunId);

  const runs = await listRecentScanRuns({});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, 'greenhouse');
  assert.equal(runs[0].fetched_count, 2);
  assert.equal(runs[0].new_count, 2);

  const seen = await findJobsBySeenUrls(['https://greenhouse.io/acme/jobs/1', 'https://greenhouse.io/acme/jobs/2']);
  assert.equal(seen.size, 2);
  const job1 = await db.collection('jobs').findOne({ url: 'https://greenhouse.io/acme/jobs/1' });
  assert.equal(job1.stage, 'raw');
  assert.equal(job1.source_type, 'greenhouse');
  assert.equal(job1.company, 'Acme');
  assert.equal(job1.linkedin_id, null);
});

test('scan.mjs Mongo: mixed api types gets source="mixed"', async () => {
  const { scanJobsToMongo } = await import('../scan.mjs');
  const jobs = [
    { url: 'https://gh/1', title: 't', company: 'A', location: 'SF, CA', description: '', api_type: 'greenhouse', posted_at: null, updated_at: null },
    { url: 'https://ashby/2', title: 't', company: 'B', location: 'SF, CA', description: '', api_type: 'ashby', posted_at: null, updated_at: null },
  ];
  await scanJobsToMongo({
    jobs,
    runStartedAt: new Date(), runFinishedAt: new Date(),
    totalFetched: 2, totalBlacklisted: 0, totalFiltered: 0, totalLocationFiltered: 0, totalStale: 0,
    sourceTypes: ['greenhouse', 'ashby'],
    errors: [],
  });
  const runs = await listRecentScanRuns({});
  assert.equal(runs[0].source, 'mixed');
});

test('scan.mjs Mongo: re-running with same jobs upserts without stage_history growth', async () => {
  const { scanJobsToMongo } = await import('../scan.mjs');
  const jobs = [
    { url: 'https://gh/x', title: 't', company: 'A', location: 'SF, CA', description: '', api_type: 'greenhouse', posted_at: null, updated_at: null },
  ];
  await scanJobsToMongo({
    jobs, runStartedAt: new Date(), runFinishedAt: new Date(),
    totalFetched: 1, totalBlacklisted: 0, totalFiltered: 0, totalLocationFiltered: 0, totalStale: 0,
    sourceTypes: ['greenhouse'], errors: [],
  });
  const before = await db.collection('jobs').findOne({ url: 'https://gh/x' });
  await new Promise(r => setTimeout(r, 5));
  await scanJobsToMongo({
    jobs, runStartedAt: new Date(), runFinishedAt: new Date(),
    totalFetched: 1, totalBlacklisted: 0, totalFiltered: 0, totalLocationFiltered: 0, totalStale: 0,
    sourceTypes: ['greenhouse'], errors: [],
  });
  const after = await db.collection('jobs').findOne({ url: 'https://gh/x' });
  assert.equal(after.first_seen_at.getTime(), before.first_seen_at.getTime());
  assert.ok(after.last_seen_at.getTime() >= before.last_seen_at.getTime());
  assert.equal(after.stage_history.length, 1);
});
