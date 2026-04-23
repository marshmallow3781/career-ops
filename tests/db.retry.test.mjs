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
