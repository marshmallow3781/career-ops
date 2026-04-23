import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  insertReport, updateReportVerdict, getNextReportNum, findReportByJobId,
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
beforeEach(async () => { await db.collection('reports').deleteMany({}); });

test('getNextReportNum: starts at 1, increments', async () => {
  assert.equal(await getNextReportNum(), 1);
  await insertReport({
    num: 1, job_id: 'a', company_slug: 'foo',
    report_path: 'reports/foo/a_report.md',
    score: 4, verdict: 'evaluated', url: 'http://x',
    generated_at: new Date(),
    checksum_md: 'sha256:x',
  });
  assert.equal(await getNextReportNum(), 2);
});

test('insertReport: stores doc, retrievable by job_id', async () => {
  const id = await insertReport({
    num: 1, job_id: 'abc', company_slug: 'pinterest',
    report_path: 'reports/pinterest/abc_report.md',
    score: 4.5, verdict: 'evaluated', url: 'http://x', generated_at: new Date(),
    checksum_md: 'sha256:x',
    block_scores: { a: 4.5, b: 4.0 },
  });
  assert.ok(id);
  const got = await findReportByJobId('abc');
  assert.equal(got.num, 1);
  assert.equal(got.score, 4.5);
  assert.deepEqual(got.block_scores, { a: 4.5, b: 4.0 });
});

test('updateReportVerdict: changes verdict and stamps updated_at', async () => {
  await insertReport({
    num: 1, job_id: 'ver', company_slug: 'c',
    report_path: 'reports/c/ver_report.md',
    score: 4, verdict: 'evaluated', url: 'http://x', generated_at: new Date(),
    checksum_md: 'sha256:x',
  });
  await updateReportVerdict(1, 'applied');
  const got = await findReportByJobId('ver');
  assert.equal(got.verdict, 'applied');
  assert.ok(got.updated_at instanceof Date);
});
