import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  upsertApplication, updateApplicationStatus, listApplications, getNextApplicationNum,
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
beforeEach(async () => { await db.collection('applications').deleteMany({}); });

test('getNextApplicationNum: returns 1 when empty, increments thereafter', async () => {
  assert.equal(await getNextApplicationNum(), 1);
  await upsertApplication({ num: 1, date: '2026-04-23', company: 'Foo', role: 'SWE', status: 'Applied', job_id: 'a' });
  assert.equal(await getNextApplicationNum(), 2);
  await upsertApplication({ num: 2, date: '2026-04-23', company: 'Bar', role: 'SWE', status: 'Applied', job_id: 'b' });
  assert.equal(await getNextApplicationNum(), 3);
});

test('upsertApplication: inserts by job_id, updates existing on re-upsert', async () => {
  await upsertApplication({ num: 1, date: '2026-04-22', company: 'Foo', role: 'SWE', status: 'Evaluated', job_id: 'x1', score: 4.2 });
  let stored = await db.collection('applications').findOne({ job_id: 'x1' });
  assert.equal(stored.status, 'Evaluated');

  await upsertApplication({ num: 1, date: '2026-04-23', company: 'Foo', role: 'SWE', status: 'Applied', job_id: 'x1', score: 4.2 });
  stored = await db.collection('applications').findOne({ job_id: 'x1' });
  assert.equal(stored.status, 'Applied');
  assert.equal(stored.date, '2026-04-23');
});

test('updateApplicationStatus: transitions status and appends history', async () => {
  await upsertApplication({ num: 1, date: '2026-04-22', company: 'Foo', role: 'SWE', status: 'Applied', job_id: 'y1' });
  await updateApplicationStatus(1, 'Interview', 'Phone screen scheduled');
  const stored = await db.collection('applications').findOne({ num: 1 });
  assert.equal(stored.status, 'Interview');
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].status, 'Interview');
  assert.equal(stored.history[0].note, 'Phone screen scheduled');
});

test('listApplications: filters by status, sorts by date desc', async () => {
  await upsertApplication({ num: 1, date: '2026-04-20', company: 'A', role: 'r', status: 'Applied', job_id: '1' });
  await upsertApplication({ num: 2, date: '2026-04-22', company: 'B', role: 'r', status: 'Applied', job_id: '2' });
  await upsertApplication({ num: 3, date: '2026-04-21', company: 'C', role: 'r', status: 'Rejected', job_id: '3' });
  const applied = await listApplications({ status: 'Applied' });
  assert.equal(applied.length, 2);
  assert.equal(applied[0].company, 'B');
  assert.equal(applied[1].company, 'A');
});
