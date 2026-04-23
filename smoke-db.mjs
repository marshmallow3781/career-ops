#!/usr/bin/env node
/**
 * smoke-db.mjs — one-off connectivity smoke test against the real
 * MongoDB Atlas cluster. Inserts a test doc, reads it back, deletes it.
 *
 * Usage: node smoke-db.mjs
 */
import 'dotenv/config';
import { getDb, ensureIndexes, closeDb } from './lib/db.mjs';

async function main() {
  console.error('[smoke-db] Connecting to', process.env.MONGODB_CLUSTER);
  const db = await getDb();
  console.error('[smoke-db] Connected. Ensuring indexes...');
  await ensureIndexes();
  console.error('[smoke-db] Indexes ready.');

  const col = db.collection('_smoke');
  const testDoc = { _id: `smoke-${Date.now()}`, hello: 'world', ts: new Date() };
  await col.insertOne(testDoc);
  console.error(`[smoke-db] Inserted ${testDoc._id}`);

  const read = await col.findOne({ _id: testDoc._id });
  if (!read || read.hello !== 'world') throw new Error('Read-back mismatch');
  console.error('[smoke-db] Read-back OK');

  await col.deleteOne({ _id: testDoc._id });
  console.error('[smoke-db] Cleanup OK');

  await closeDb();
  console.log(JSON.stringify({ ok: true, cluster: process.env.MONGODB_CLUSTER, database: process.env.MONGODB_DATABASE }, null, 2));
}

main().catch(err => {
  console.error('[smoke-db] FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
