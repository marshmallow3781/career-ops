import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { connectWithClient, ensureIndexes, closeDb, _resetDbForTesting } from '../lib/db.mjs';

let mongod, client, db;

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('career-ops-test');
  connectWithClient(client, 'career-ops-test');
});

after(async () => {
  await closeDb();
  _resetDbForTesting();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

test('ensureIndexes: creates all expected indexes idempotently', async () => {
  await ensureIndexes();
  // run twice to confirm idempotent
  await ensureIndexes();

  const jobsIdx = await db.collection('jobs').indexes();
  const names = jobsIdx.map(i => i.name);
  assert.ok(names.includes('linkedin_id_1'), `jobs missing linkedin_id_1; got: ${names.join(', ')}`);
  assert.ok(names.includes('jd_fingerprint_1'));
  assert.ok(names.includes('company_title_key_1'));

  const scanRunsIdx = await db.collection('scan_runs').indexes();
  assert.ok(scanRunsIdx.map(i => i.name).includes('run_started_at_-1'));

  const appsIdx = await db.collection('applications').indexes();
  assert.ok(appsIdx.map(i => i.name).includes('num_1'));

  const reportsIdx = await db.collection('reports').indexes();
  assert.ok(reportsIdx.map(i => i.name).includes('num_1'));

  const cvIdx = await db.collection('cv_artifacts').indexes();
  assert.ok(cvIdx.map(i => i.name).includes('job_id_1'));
});
