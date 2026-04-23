import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { connectWithClient, closeDb, _resetDbForTesting, ensureIndexes, upsertJob } from '../lib/db.mjs';
import { deriveJobIdForCv, buildCvPaths } from '../assemble-cv.mjs';

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
  await db.collection('cv_artifacts').deleteMany({});
});

test('deriveJobIdForCv: matches by JD fingerprint when present', async () => {
  // Upsert a job whose jd_fingerprint matches what computeJdFingerprint('d') produces.
  // Use the same helper to compute the fingerprint stored in the job doc.
  const { computeJdFingerprint } = await import('../lib/dedup.mjs');
  const fp = computeJdFingerprint('d');
  await upsertJob({
    linkedin_id: '42',
    title: 'X',
    company: 'Y',
    company_slug: 'y',
    company_title_key: 'y|x',
    jd_fingerprint: fp,
    url: 'u',
    title_normalized: 'x',
    description: 'd',
    source_metro: 'bay',
  });
  const result = await deriveJobIdForCv({ jdText: 'd' });
  assert.equal(result.job_id, '42');
  assert.equal(result.link_status, 'linked');
});

test('deriveJobIdForCv: falls back to synthetic id when no match', async () => {
  const result = await deriveJobIdForCv({ jdText: 'unmatched-content', jdSlug: 'instacart-ml-platform' });
  assert.equal(result.job_id, 'synthetic-instacart-ml-platform');
  assert.equal(result.link_status, 'unlinked');
});

test('buildCvPaths: produces cvs/{company}/{title}/{job_id}_cv.{md,tex}', () => {
  const paths = buildCvPaths({ company_slug: 'instacart', title_slug: 'senior-engineer-ml-ai-platform', job_id: '4404321456' });
  assert.equal(paths.cv_md_path, 'cvs/instacart/senior-engineer-ml-ai-platform/4404321456_cv.md');
  assert.equal(paths.cv_tex_path, 'cvs/instacart/senior-engineer-ml-ai-platform/4404321456_cv.tex');
});
