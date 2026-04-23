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

// ── jobs ───────────────────────────────────────────────────────────

/**
 * Upsert a job by linkedin_id. First sighting → inserts with stage='raw'
 * and a stage_history entry. Subsequent sightings → updates last_seen_at
 * and last_scan_run_id without touching first_seen_at or stage_history.
 */
export async function upsertJob(doc) {
  const db = await getDb();
  const now = new Date();
  const { linkedin_id, first_scan_run_id, ...fields } = doc;
  return await withRetry(() => db.collection('jobs').updateOne(
    { linkedin_id },
    {
      $set: {
        ...fields,
        linkedin_id,
        last_seen_at: now,
        updated_at: now,
        ...(first_scan_run_id ? { last_scan_run_id: first_scan_run_id } : {}),
      },
      $setOnInsert: {
        stage: 'raw',
        first_seen_at: now,
        first_scan_run_id: first_scan_run_id || null,
        stage_history: [{ stage: 'raw', at: now, source: fields.source_metro ? `apify-linkedin-${fields.source_metro}` : null }],
        cv_artifact_ids: [],
        application_id: null,
        report_id: null,
      },
    },
    { upsert: true },
  ));
}

/**
 * Update a job's stage + stage-specific fields. Appends a stage_history
 * entry. patch is merged into $set (top-level fields like
 * prefilter_archetype / prefilter_score / etc.) AND into the new
 * stage_history entry.
 */
export async function updateJobStage(linkedin_id, stage, patch = {}) {
  const db = await getDb();
  const now = new Date();
  const { prefilter_archetype, ...restPatch } = patch;
  const historyEntry = {
    stage,
    at: now,
    ...(prefilter_archetype !== undefined ? { archetype: prefilter_archetype } : {}),
    ...restPatch,
  };
  const setFields = { stage, updated_at: now, ...patch };
  if (stage === 'scored') setFields.prefilter_at = now;
  return await withRetry(() => db.collection('jobs').updateOne(
    { linkedin_id },
    {
      $set: setFields,
      $push: { stage_history: historyEntry },
    },
  ));
}

export async function findJobByLinkedinId(linkedin_id) {
  const db = await getDb();
  return await withRetry(() => db.collection('jobs').findOne({ linkedin_id }));
}

/**
 * For dedup: given an array of linkedin_ids we just fetched, return a
 * Set of those already in the collection. Used by apify-scan to skip
 * already-seen jobs.
 */
export async function findJobsBySeenSet(linkedinIds) {
  const db = await getDb();
  if (!linkedinIds || linkedinIds.length === 0) return new Set();
  const docs = await withRetry(() => db.collection('jobs')
    .find({ linkedin_id: { $in: linkedinIds } }, { projection: { linkedin_id: 1, _id: 0 } })
    .toArray());
  return new Set(docs.map(d => d.linkedin_id));
}

/**
 * Find candidates for digest building. Returns jobs sorted by
 * prefilter_score desc (nulls last).
 */
export async function findDigestCandidates(filter = {}) {
  const db = await getDb();
  return await withRetry(() => db.collection('jobs')
    .find(filter)
    .sort({ prefilter_score: -1 })
    .toArray());
}

// ── scan_runs ──────────────────────────────────────────────────────

/**
 * Insert an audit record for one scan operation. Returns the inserted
 * _id (ObjectId) so callers can link jobs to the originating run.
 */
export async function insertScanRun(doc) {
  const db = await getDb();
  const result = await withRetry(() => db.collection('scan_runs').insertOne(doc));
  return result.insertedId;
}

/**
 * Recent scan runs, newest first. Default limit 20.
 */
export async function listRecentScanRuns({ limit = 20, source = null, metro = null } = {}) {
  const db = await getDb();
  const filter = {};
  if (source) filter.source = source;
  if (metro) filter.metro = metro;
  return await withRetry(() => db.collection('scan_runs')
    .find(filter)
    .sort({ run_started_at: -1 })
    .limit(limit)
    .toArray());
}

// ── applications ───────────────────────────────────────────────────

/**
 * Next sequential application number (monotonic, matches existing TSV convention).
 */
export async function getNextApplicationNum() {
  const db = await getDb();
  const highest = await withRetry(() => db.collection('applications')
    .find({}, { projection: { num: 1, _id: 0 } })
    .sort({ num: -1 })
    .limit(1)
    .toArray());
  return highest.length === 0 ? 1 : highest[0].num + 1;
}

/**
 * Upsert an application by job_id (the existing "never create duplicate
 * for company+role" rule is enforced via index + the job_id key).
 */
export async function upsertApplication(doc) {
  const db = await getDb();
  const now = new Date();
  const { job_id, ...rest } = doc;
  return await withRetry(() => db.collection('applications').updateOne(
    { job_id },
    {
      $set: { ...rest, job_id, updated_at: now },
      $setOnInsert: { created_at: now, history: [] },
    },
    { upsert: true },
  ));
}

/**
 * Transition application status + append history entry.
 */
export async function updateApplicationStatus(num, status, note = '') {
  const db = await getDb();
  const now = new Date();
  return await withRetry(() => db.collection('applications').updateOne(
    { num },
    {
      $set: { status, updated_at: now },
      $push: { history: { status, at: now, note } },
    },
  ));
}

/**
 * List applications matching a filter. Sorted by date descending.
 */
export async function listApplications(filter = {}) {
  const db = await getDb();
  return await withRetry(() => db.collection('applications')
    .find(filter)
    .sort({ date: -1 })
    .toArray());
}
