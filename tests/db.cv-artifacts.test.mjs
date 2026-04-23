import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  upsertCvArtifact, updateCvValidation, findCvArtifactByJobId,
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
beforeEach(async () => { await db.collection('cv_artifacts').deleteMany({}); });

test('upsertCvArtifact: inserts new, updates existing by job_id', async () => {
  await upsertCvArtifact({
    job_id: '123',
    company_slug: 'acme',
    title_slug: 'swe-backend',
    cv_md_path: 'cvs/acme/swe-backend/123_cv.md',
    cv_tex_path: null,
    cv_pdf_path: null,
    jd_fingerprint: 'sha256:jd',
    profile_version_hash: 'sha256:prof',
    archetype: 'backend',
    intent_source: 'llm',
    checksum_md: 'sha256:md1',
  });
  let stored = await findCvArtifactByJobId('123');
  assert.equal(stored.archetype, 'backend');
  assert.equal(stored.checksum_md, 'sha256:md1');

  // re-upsert (e.g. regeneration) replaces fields
  await upsertCvArtifact({
    job_id: '123',
    company_slug: 'acme',
    title_slug: 'swe-backend',
    cv_md_path: 'cvs/acme/swe-backend/123_cv.md',
    cv_tex_path: 'cvs/acme/swe-backend/123_cv.tex',
    cv_pdf_path: null,
    jd_fingerprint: 'sha256:jd2',
    profile_version_hash: 'sha256:prof2',
    archetype: 'fullstack',
    intent_source: 'llm-retry',
    checksum_md: 'sha256:md2',
  });
  stored = await findCvArtifactByJobId('123');
  assert.equal(stored.archetype, 'fullstack');
  assert.equal(stored.cv_tex_path, 'cvs/acme/swe-backend/123_cv.tex');
  assert.equal(stored.jd_fingerprint, 'sha256:jd2');
});

test('updateCvValidation: records status and errors', async () => {
  await upsertCvArtifact({
    job_id: 'valid',
    company_slug: 'c', title_slug: 't',
    cv_md_path: 'cvs/c/t/valid_cv.md',
    jd_fingerprint: 'x', profile_version_hash: 'y',
    archetype: 'backend', intent_source: 'llm',
    checksum_md: 'sha256:x',
  });
  await updateCvValidation('valid', 'ok', []);
  let stored = await findCvArtifactByJobId('valid');
  assert.equal(stored.validation_status, 'ok');
  assert.deepEqual(stored.validation_errors, []);

  await updateCvValidation('valid', 'fabricated_bullet', [{ type: 'fabricated_bullet', bullet: 'x' }]);
  stored = await findCvArtifactByJobId('valid');
  assert.equal(stored.validation_status, 'fabricated_bullet');
  assert.equal(stored.validation_errors.length, 1);
});
