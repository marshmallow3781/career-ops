import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  upsertJob, updateJobStage, findJobByLinkedinId, findJobsBySeenSet, findDigestCandidates,
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
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection('jobs').deleteMany({});
});

const sampleJob = (overrides = {}) => ({
  linkedin_id: '4404321456',
  url: 'https://linkedin.com/jobs/view/4404321456',
  title: 'Software Engineer II, Backend',
  title_normalized: 'software-engineer-ii-backend',
  company: 'Pinterest',
  company_slug: 'pinterest',
  company_title_key: 'pinterest|software-engineer-ii-backend',
  jd_fingerprint: 'sha256:abc123',
  location: 'San Francisco, CA',
  description: 'Backend eng.',
  source_metro: 'bay-area',
  posted_at_raw: '2026-04-22',
  posted_time_relative: '6 hours ago',
  first_scan_run_id: null,
  ...overrides,
});

test('upsertJob: inserts new job with stage=raw and first_seen_at', async () => {
  const doc = sampleJob();
  const res = await upsertJob(doc);
  assert.equal(res.upsertedCount, 1);
  const stored = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  assert.equal(stored.stage, 'raw');
  assert.equal(stored.title, 'Software Engineer II, Backend');
  assert.ok(stored.first_seen_at instanceof Date);
  assert.ok(stored.updated_at instanceof Date);
  assert.ok(Array.isArray(stored.stage_history));
  assert.equal(stored.stage_history.length, 1);
  assert.equal(stored.stage_history[0].stage, 'raw');
});

test('upsertJob: re-seeing same linkedin_id updates last_seen_at only (preserves first_seen)', async () => {
  const doc = sampleJob();
  await upsertJob(doc);
  const before = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  await new Promise(r => setTimeout(r, 5));
  await upsertJob(doc);
  const after = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  assert.equal(after.first_seen_at.getTime(), before.first_seen_at.getTime());
  assert.ok(after.last_seen_at.getTime() >= before.last_seen_at.getTime());
  assert.equal(after.stage_history.length, 1, 'does not re-append raw stage');
});

test('updateJobStage: appends to stage_history and updates stage + fields', async () => {
  await upsertJob(sampleJob());
  await updateJobStage('4404321456', 'scored', {
    prefilter_archetype: 'backend',
    prefilter_score: 8,
    prefilter_reason: 'Great Go/Kafka match',
    prefilter_source: 'llm',
  });
  const stored = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  assert.equal(stored.stage, 'scored');
  assert.equal(stored.prefilter_score, 8);
  assert.equal(stored.prefilter_archetype, 'backend');
  assert.equal(stored.stage_history.length, 2);
  assert.equal(stored.stage_history[1].stage, 'scored');
  assert.equal(stored.stage_history[1].archetype, 'backend');
});

test('findJobByLinkedinId: returns null for unknown id', async () => {
  const res = await findJobByLinkedinId('nonexistent');
  assert.equal(res, null);
});

test('findJobsBySeenSet: returns set of linkedin_ids already in the collection', async () => {
  await upsertJob(sampleJob({ linkedin_id: 'a1' }));
  await upsertJob(sampleJob({ linkedin_id: 'b2' }));
  const seen = await findJobsBySeenSet(['a1', 'b2', 'c3']);
  assert.ok(seen instanceof Set);
  assert.equal(seen.size, 2);
  assert.ok(seen.has('a1'));
  assert.ok(seen.has('b2'));
  assert.ok(!seen.has('c3'));
});

test('findDigestCandidates: returns jobs matching stage filter, sorted by score desc', async () => {
  await upsertJob(sampleJob({ linkedin_id: 'low' }));
  await upsertJob(sampleJob({ linkedin_id: 'high' }));
  await upsertJob(sampleJob({ linkedin_id: 'cut' }));
  await updateJobStage('low', 'scored', { prefilter_score: 4, prefilter_archetype: 'backend' });
  await updateJobStage('high', 'scored', { prefilter_score: 9, prefilter_archetype: 'backend' });
  await updateJobStage('cut', 'title_cut', {});

  const results = await findDigestCandidates({ stage: 'scored' });
  assert.equal(results.length, 2);
  assert.equal(results[0].linkedin_id, 'high');
  assert.equal(results[1].linkedin_id, 'low');
});
