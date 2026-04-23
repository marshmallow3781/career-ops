import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMongoUri } from '../lib/db.mjs';

test('buildMongoUri: assembles from env parts with URL-encoded password', () => {
  const env = {
    MONGODB_USER: 'brick_db_dev_user',
    MONGODB_PASSWORD: 'p@ss w/ord',
    MONGODB_CLUSTER: 'brick-free-cluster0.suun1hz.mongodb.net',
    MONGODB_APP_NAME: 'brick-free-Cluster0',
  };
  const uri = buildMongoUri(env);
  assert.match(uri, /^mongodb\+srv:\/\/brick_db_dev_user:/);
  assert.match(uri, /p%40ss%20w%2Ford/);  // password URL-encoded
  assert.match(uri, /@brick-free-cluster0\.suun1hz\.mongodb\.net\//);
  assert.match(uri, /retryWrites=true/);
  assert.match(uri, /appName=brick-free-Cluster0/);
});

test('buildMongoUri: throws if required var missing', () => {
  assert.throws(() => buildMongoUri({ MONGODB_USER: 'x' }), /MONGODB_PASSWORD/);
});

import { withRetry, _isRetryableError } from '../lib/db.mjs';

test('withRetry: returns result on first success', async () => {
  const fn = async () => 42;
  assert.equal(await withRetry(fn, { delays: [] }), 42);
});

test('withRetry: retries on retryable error then succeeds', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) {
      const err = new Error('ECONNRESET');
      err.name = 'MongoNetworkError';
      throw err;
    }
    return 'ok';
  };
  const result = await withRetry(fn, { delays: [1, 1, 1] });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry: fails fast on non-retryable error', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  };
  await assert.rejects(withRetry(fn, { delays: [1, 1, 1] }), /duplicate key/);
  assert.equal(calls, 1);
});

test('withRetry: gives up after final retry and rethrows', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    const err = new Error('timeout');
    err.name = 'MongoNetworkTimeoutError';
    throw err;
  };
  await assert.rejects(withRetry(fn, { delays: [1, 1, 1] }), /timeout/);
  assert.equal(calls, 4);
});

test('_isRetryableError: true for MongoNetworkError', () => {
  const err = new Error('x'); err.name = 'MongoNetworkError';
  assert.equal(_isRetryableError(err), true);
});

test('_isRetryableError: false for duplicate key', () => {
  const err = new Error('x'); err.code = 11000;
  assert.equal(_isRetryableError(err), false);
});
