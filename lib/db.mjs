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

let _client = null;
let _db = null;

/**
 * Default lazy-singleton getter. Reads env, builds URI, connects with
 * Stable API v1 (strict + deprecationErrors), retries on transient errors.
 */
export async function getDb() {
  if (_db) return _db;
  const uri = buildMongoUri();
  _client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  await withRetry(() => _client.connect());
  _db = _client.db(process.env.MONGODB_DATABASE || 'career-ops');
  return _db;
}

/**
 * Test-only: inject an already-connected client + db name. Bypasses
 * env-based URI assembly so tests can point at mongodb-memory-server.
 */
export function connectWithClient(client, dbName) {
  _client = client;
  _db = client.db(dbName);
}

/**
 * Close the singleton connection. Idempotent.
 */
export async function closeDb() {
  if (_client) {
    await _client.close().catch(() => {});
  }
  _client = null;
  _db = null;
}

/**
 * Test-only escape hatch.
 */
export function _resetDbForTesting() {
  _client = null;
  _db = null;
}

/**
 * Idempotent index creation. Safe to call on every startup.
 * Indexes match the spec §5 Indexes subsection per collection.
 */
export async function ensureIndexes() {
  const db = await getDb();

  await db.collection('jobs').createIndexes([
    { key: { linkedin_id: 1 },                     name: 'linkedin_id_1', unique: true },
    { key: { jd_fingerprint: 1 },                  name: 'jd_fingerprint_1' },
    { key: { company_title_key: 1 },               name: 'company_title_key_1' },
    { key: { stage: 1, prefilter_score: -1 },      name: 'stage_1_prefilter_score_-1' },
    { key: { source_metro: 1, first_seen_at: -1 }, name: 'source_metro_1_first_seen_at_-1' },
  ]);

  await db.collection('scan_runs').createIndexes([
    { key: { run_started_at: -1 }, name: 'run_started_at_-1' },
    { key: { source: 1, metro: 1, run_started_at: -1 }, name: 'source_1_metro_1_run_started_at_-1' },
  ]);

  await db.collection('applications').createIndexes([
    { key: { num: 1 }, name: 'num_1', unique: true },
    { key: { job_id: 1 }, name: 'job_id_1' },
    { key: { company: 1, role: 1 }, name: 'company_1_role_1' },
    { key: { status: 1, date: -1 }, name: 'status_1_date_-1' },
  ]);

  await db.collection('reports').createIndexes([
    { key: { num: 1 }, name: 'num_1', unique: true },
    { key: { job_id: 1 }, name: 'job_id_1', unique: true },
    { key: { score: -1 }, name: 'score_-1' },
  ]);

  await db.collection('cv_artifacts').createIndexes([
    { key: { job_id: 1 }, name: 'job_id_1', unique: true },
    { key: { company_slug: 1, generated_at: -1 }, name: 'company_slug_1_generated_at_-1' },
  ]);
}
