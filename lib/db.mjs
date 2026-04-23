/**
 * lib/db.mjs — MongoDB persistence layer for career-ops.
 *
 * Connection: lazy singleton MongoClient with Stable API v1 (strict +
 * deprecationErrors). Credentials assembled at runtime from env parts
 * so the full URI never lives on disk.
 *
 * All DB calls wrap in withRetry(): 3 attempts with exponential backoff
 * (1s, 5s, 30s). Transient network errors retry; non-retryable errors
 * (duplicate key, validation) fail fast.
 *
 * CRUD groups per collection: jobs, scan_runs, applications, reports,
 * cv_artifacts. See docs/superpowers/specs/2026-04-23-mongodb-persistence-design.md
 * for the document schemas.
 */
import { MongoClient, ServerApiVersion } from 'mongodb';

const REQUIRED_ENV = ['MONGODB_USER', 'MONGODB_PASSWORD', 'MONGODB_CLUSTER'];

/**
 * Assemble a mongodb+srv:// URI from env parts. Password URL-encoded so
 * any special chars (`@`, `/`, `:`) survive the URI parse.
 */
export function buildMongoUri(env = process.env) {
  for (const k of REQUIRED_ENV) {
    if (!env[k]) throw new Error(`buildMongoUri: missing env var ${k}`);
  }
  const user = encodeURIComponent(env.MONGODB_USER);
  const pass = encodeURIComponent(env.MONGODB_PASSWORD);
  const host = env.MONGODB_CLUSTER;
  const appName = env.MONGODB_APP_NAME || 'career-ops';
  return `mongodb+srv://${user}:${pass}@${host}/?retryWrites=true&w=majority&appName=${appName}`;
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 30000];

/**
 * Retryable = transient network / server-unavailable errors.
 * NOT retryable = duplicate-key, validation, auth failures.
 */
export function _isRetryableError(err) {
  if (!err) return false;
  const retryableNames = [
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoServerSelectionError',
    'MongoTopologyClosedError',
  ];
  if (retryableNames.includes(err.name)) return true;
  // Duplicate key (11000) or document validation (121) → fail fast.
  if (err.code === 11000 || err.code === 121) return false;
  return false;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Run fn with exponential-backoff retry. On retryable errors, wait
 * delays[0], delays[1], ... between attempts. On final failure (or
 * non-retryable), rethrow.
 */
export async function withRetry(fn, { delays = DEFAULT_RETRY_DELAYS_MS } = {}) {
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === delays.length || !_isRetryableError(err)) throw err;
      console.error(`[db] transient error (attempt ${i + 1}): ${err.message}; retrying in ${delays[i]}ms`);
      await sleep(delays[i]);
    }
  }
}
