import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  insertScanRun, listRecentScanRuns,
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
beforeEach(async () => { await db.collection('scan_runs').deleteMany({}); });

test('insertScanRun: stores doc and returns the ObjectId', async () => {
  const id = await insertScanRun({
    source: 'apify-linkedin',
    metro: 'bay-area',
    apify_actor_id: 'BHzefUZlZRKWxkTck',
    apify_run_id: 'run-123',
    input_params: { title: 'Software Engineer', rows: 20 },
    fetched_count: 20,
    new_count: 5,
    blacklisted_count: 1,
    errors: [],
    run_started_at: new Date('2026-04-23T00:00:00Z'),
    run_finished_at: new Date('2026-04-23T00:01:30Z'),
  });
  assert.ok(id, 'returned an id');
  const stored = await db.collection('scan_runs').findOne({ _id: id });
  assert.equal(stored.source, 'apify-linkedin');
  assert.equal(stored.metro, 'bay-area');
  assert.equal(stored.fetched_count, 20);
});

test('listRecentScanRuns: returns runs sorted by run_started_at desc', async () => {
  await insertScanRun({ source: 's', metro: 'a', run_started_at: new Date('2026-04-22'), input_params: {} });
  await insertScanRun({ source: 's', metro: 'b', run_started_at: new Date('2026-04-23'), input_params: {} });
  await insertScanRun({ source: 's', metro: 'c', run_started_at: new Date('2026-04-21'), input_params: {} });
  const runs = await listRecentScanRuns({ limit: 10 });
  assert.equal(runs.length, 3);
  assert.equal(runs[0].metro, 'b');
  assert.equal(runs[1].metro, 'a');
  assert.equal(runs[2].metro, 'c');
});
