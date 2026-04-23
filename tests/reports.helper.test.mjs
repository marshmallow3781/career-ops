import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectWithClient, closeDb, _resetDbForTesting, ensureIndexes, findReportByJobId } from '../lib/db.mjs';
import { persistReport } from '../lib/reports.mjs';

let mongod, client, db, tmp, prevCwd;
before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('test');
  connectWithClient(client, 'test');
  await ensureIndexes();
  tmp = mkdtempSync(join(tmpdir(), 'reports-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
});
after(async () => {
  process.chdir(prevCwd);
  await closeDb();
  _resetDbForTesting();
  await client.close();
  await mongod.stop();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => { await db.collection('reports').deleteMany({}); });

test('persistReport: writes file + inserts mongo doc', async () => {
  const { num, report_path } = await persistReport({
    job_id: 'abc',
    company: 'Acme',
    company_slug: 'acme',
    url: 'https://...',
    score: 4.5,
    block_scores: { a: 4, b: 5 },
    body: '# Report body\n\ndetails.',
  });
  assert.equal(num, 1);
  assert.equal(report_path, 'reports/acme/abc_report.md');
  assert.ok(existsSync(report_path));
  assert.ok(readFileSync(report_path, 'utf-8').includes('Report body'));
  const mongoDoc = await findReportByJobId('abc');
  assert.equal(mongoDoc.num, 1);
  assert.equal(mongoDoc.score, 4.5);
});
