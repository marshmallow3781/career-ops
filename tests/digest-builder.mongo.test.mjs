import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  upsertJob, findJobByLinkedinId,
} from '../lib/db.mjs';
import { loadCandidatesFromMongo, runDigestStage2AndScoring } from '../digest-builder.mjs';

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
beforeEach(async () => { await db.collection('jobs').deleteMany({}); });

test('loadCandidatesFromMongo: returns raw-stage jobs from recent window', async () => {
  await upsertJob({
    linkedin_id: 'j1',
    title: 'Backend Eng',
    company: 'Acme',
    company_slug: 'acme',
    company_title_key: 'acme|backend-eng',
    jd_fingerprint: 'fp1',
    description: 'x',
    source_metro: 'bay',
    url: 'u1',
    title_normalized: 'backend-eng',
  });
  const candidates = await loadCandidatesFromMongo({ sinceHours: 24 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].linkedin_id, 'j1');
});

test('runDigestStage2AndScoring: applies title filter, writes stage=title_cut or scored', async () => {
  await upsertJob({
    linkedin_id: 'keep',
    title: 'Backend Engineer',
    company: 'Acme',
    company_slug: 'acme',
    company_title_key: 'acme|backend-engineer',
    jd_fingerprint: 'fp1',
    description: 'Go/Kafka',
    source_metro: 'bay',
    url: 'uk',
    title_normalized: 'backend-engineer',
  });
  await upsertJob({
    linkedin_id: 'drop',
    title: 'Junior Software Engineer',
    company: 'B',
    company_slug: 'b',
    company_title_key: 'b|junior-software-engineer',
    jd_fingerprint: 'fp2',
    description: 'x',
    source_metro: 'bay',
    url: 'ud',
    title_normalized: 'junior-software-engineer',
  });

  // Mock Haiku client that returns a single content-block with valid JSON.
  const mockHaiku = {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ archetype: 'backend', score: 8, reason: 'good match' }) }] }),
    },
  };
  const portals = { title_filter: { positive: ['Backend'], negative: ['Junior'] } };
  const profile = { target_roles: { deal_breakers: [] }, candidate: { full_name: 'x' } };
  const sources = {};

  await runDigestStage2AndScoring({
    candidates: await loadCandidatesFromMongo({ sinceHours: 24 }),
    portals, profile, sources, haikuClient: mockHaiku, llmConfig: null, dealBreakers: [],
  });

  const keep = await findJobByLinkedinId('keep');
  const drop = await findJobByLinkedinId('drop');
  assert.equal(keep.stage, 'scored');
  assert.equal(keep.prefilter_score, 8);
  assert.equal(keep.prefilter_archetype, 'backend');
  assert.equal(drop.stage, 'title_cut');
});
