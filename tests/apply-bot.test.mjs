import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetDbForTesting, connectWithClient } from '../lib/db.mjs';
import { runApplyBot } from '../apply-bot.mjs';

test('runApplyBot: skips jobs already in applications collection', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-apply-bot-dedup');
  const db = client.db('test-apply-bot-dedup');

  try {
    await db.collection('jobs').insertOne({
      linkedin_id: 'j-applied',
      stage: 'scored',
      prefilter_score: 9,
      company: 'A', title: 'Backend',
      first_seen_at: new Date(),
      url: 'file:///dev/null',
    });
    await db.collection('applications').insertOne({
      num: 1, job_id: 'j-applied', status: 'Applied',
    });

    const result = await runApplyBot({
      minScore: 9, submit: false, workers: 1,
      mockAgent: async () => ({ status: 'DryRun', stepCount: 1 }),
    });
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_already_applied, 1);
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});

test('runApplyBot: one eligible job → mockAgent called → applications row created', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-apply-bot-happy');
  const db = client.db('test-apply-bot-happy');

  try {
    await db.collection('jobs').insertOne({
      linkedin_id: 'j-new',
      stage: 'scored',
      prefilter_score: 10,
      company: 'Z', title: 'Backend',
      first_seen_at: new Date(),
      url: 'file:///dev/null',
      prefilter_archetype: 'backend',
    });

    const calls = [];
    const result = await runApplyBot({
      minScore: 9, submit: false, workers: 1,
      mockAgent: async (args) => {
        calls.push(args.job.linkedin_id);
        return { status: 'DryRun', stepCount: 3, reason: 'mock' };
      },
    });
    assert.equal(result.processed, 1);
    assert.equal(calls[0], 'j-new');
    const app = await db.collection('applications').findOne({ job_id: 'j-new' });
    assert.equal(app.status, 'DryRun');
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});
