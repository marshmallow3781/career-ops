import { test } from 'node:test';
import assert from 'node:assert/strict';

const SKIP = process.env.MONGO_INTEGRATION_TEST !== '1';

test('integration: real Atlas insert-read-delete (gated)', { skip: SKIP ? 'set MONGO_INTEGRATION_TEST=1 to enable' : false }, async () => {
  await import('dotenv/config.js');
  const { getDb, ensureIndexes, closeDb } = await import('../lib/db.mjs');

  const db = await getDb();
  await ensureIndexes();
  const col = db.collection('_integration_test');
  const doc = { _id: `it-${Date.now()}`, test: true };
  try {
    await col.insertOne(doc);
    const read = await col.findOne({ _id: doc._id });
    assert.equal(read.test, true);
  } finally {
    await col.deleteOne({ _id: doc._id });
    await closeDb();
  }
});
