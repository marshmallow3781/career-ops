# MongoDB Persistence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate career-ops structured data (scanned jobs, dedup state, applications, report metadata, CV metadata) from flat files to MongoDB Atlas. CV and report *bodies* stay on disk as file-backed artifacts indexed by Mongo docs.

**Architecture:** New `lib/db.mjs` module with a lazy singleton MongoClient and per-collection CRUD function groups. All DB calls wrapped in a 3-retry backoff helper. Each consumer (`apify-scan.mjs`, `digest-builder.mjs`, `assemble-cv.mjs`, `validate-cv.mjs`, mode files, `merge-tracker.mjs`) is migrated in a phased rollout; dual-writes to existing files are preserved during transition behind a `DUAL_WRITE_FILES=1` env flag.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, `mongodb` npm package (Stable API v1 + strict + deprecationErrors), `mongodb-memory-server` for unit tests, MongoDB Atlas M0 for production.

**Spec reference:** `docs/superpowers/specs/2026-04-23-mongodb-persistence-design.md` (commit `182e631`).

---

## Open-question resolutions

1. **Job ID for `assemble-cv.mjs` when CLI is `--jd=jds/{slug}.md`:** Derive `job_id` by computing the JD fingerprint (`computeJdFingerprint` from `lib/dedup.mjs`) and querying `jobs` for a match. If found, use that `linkedin_id`. If not, fall back to the slug (without `.md`) as a synthetic id and write CV files under `cvs/{company-slug}/{slug}/{slug}_cv.md`. The `cv_artifacts` doc sets `job_id = synthetic-{slug}` and `_link_status = "unlinked"`. This keeps ad-hoc JD flows working without forcing every user to carry a linkedin_id.
2. **`merge-tracker.mjs` fate:** Keep the script, turn it into render-only. It queries `applications` in Mongo and writes `data/applications.md` as a human-readable mirror. The TSV dropbox (`batch/tracker-additions/*.tsv`) is still supported as an input for batch mode, but now each TSV row gets upserted to Mongo instead of appended to the markdown file.
3. **`data/digest.md`:** Continue generating it, drive from a Mongo query instead of the in-memory job list.

---

## File Structure

### Files created
- `lib/db.mjs` — connection singleton, `withRetry()`, `ensureIndexes()`, CRUD for all 5 collections (~300 lines)
- `tests/db.jobs.test.mjs` — unit tests for jobs CRUD against `mongodb-memory-server`
- `tests/db.scan-runs.test.mjs` — unit tests for scan_runs
- `tests/db.applications.test.mjs` — unit tests for applications
- `tests/db.reports.test.mjs` — unit tests for reports
- `tests/db.cv-artifacts.test.mjs` — unit tests for cv_artifacts
- `tests/db.retry.test.mjs` — unit tests for the retry wrapper
- `tests/db.integration.test.mjs` — gated by `MONGO_INTEGRATION_TEST=1`; real Atlas connection
- `smoke-db.mjs` — one-off connectivity smoke test (insert-read-delete)
- `add-application.mjs` — CLI helper for manual application entry

### Files modified
- `apify-scan.mjs` — Mongo-first scan writes with optional TSV dual-write
- `digest-builder.mjs` — reads and writes from Mongo; data/digest.md is rendered from query result
- `assemble-cv.mjs` — writes per-job CV paths + upserts `cv_artifacts`; back-compat `cv.tailored.md` copy
- `validate-cv.mjs` — calls `updateCvValidation` after running checks
- `merge-tracker.mjs` — becomes a render-only Mongo-query → `data/applications.md` step
- `package.json` — adds `mongodb` and `mongodb-memory-server`
- `modes/oferta.md`, `modes/auto-pipeline.md` — pointers updated to note per-job CV/report paths (minor text edits)
- `.env` — already contains `MONGODB_USER` / `MONGODB_PASSWORD` / `MONGODB_CLUSTER` / `MONGODB_APP_NAME` / `MONGODB_DATABASE` (user added these)

---

## Phase 1 — `lib/db.mjs` foundation

Build the DB module with connection, retry, indexes, and collection CRUD. No consumer changes yet.

### Task 1.1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `mongodb` and `mongodb-memory-server`**

Run:
```bash
cd /Users/xiaoxuan/resume/career-ops
npm install mongodb
npm install --save-dev mongodb-memory-server
```

Expected: `package.json` dependencies now include `mongodb: "^6.x.x"`; devDependencies include `mongodb-memory-server: "^10.x.x"`. The `mongodb-memory-server` postinstall downloads a ~100 MB MongoDB binary — this takes 1-2 minutes on first install.

- [ ] **Step 2: Verify import works**

Run: `node -e "import('mongodb').then(m => console.log('MongoClient:', typeof m.MongoClient, 'ServerApiVersion.v1:', m.ServerApiVersion.v1))"`
Expected:
```
MongoClient: function ServerApiVersion.v1: 1
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add mongodb driver + mongodb-memory-server for tests"
```

---

### Task 1.2: Create `lib/db.mjs` skeleton with URI builder

**Files:**
- Create: `lib/db.mjs`
- Create: `tests/db.retry.test.mjs`

- [ ] **Step 1: Write a failing test for the URI builder**

Create `tests/db.retry.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.retry.test.mjs`
Expected: `SyntaxError: The requested module '../lib/db.mjs' does not provide an export named 'buildMongoUri'`

- [ ] **Step 3: Create `lib/db.mjs` with the URI builder**

Create `lib/db.mjs`:

```js
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
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.retry.test.mjs`
Expected: `# pass 2  # fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.retry.test.mjs
git commit -m "feat(db): buildMongoUri env-parts assembler with URL encoding"
```

---

### Task 1.3: Add `withRetry()` helper with exponential backoff

**Files:**
- Modify: `lib/db.mjs`
- Modify: `tests/db.retry.test.mjs`

- [ ] **Step 1: Append failing tests for retry semantics**

Append to `tests/db.retry.test.mjs`:

```js
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
  const result = await withRetry(fn, { delays: [1, 1, 1] });  // tiny delays for tests
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
  assert.equal(calls, 4);  // initial + 3 retries
});

test('_isRetryableError: true for MongoNetworkError', () => {
  const err = new Error('x'); err.name = 'MongoNetworkError';
  assert.equal(_isRetryableError(err), true);
});

test('_isRetryableError: false for duplicate key', () => {
  const err = new Error('x'); err.code = 11000;
  assert.equal(_isRetryableError(err), false);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.retry.test.mjs`
Expected: fails with "does not provide an export named 'withRetry'"

- [ ] **Step 3: Add `withRetry` and `_isRetryableError` to `lib/db.mjs`**

Append to `lib/db.mjs`:

```js
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
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.retry.test.mjs`
Expected: `# pass 8  # fail 0`

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.retry.test.mjs
git commit -m "feat(db): withRetry helper — 3 attempts, exponential backoff, retryable-only"
```

---

### Task 1.4: Connection singleton + `ensureIndexes`

**Files:**
- Modify: `lib/db.mjs`
- Create: `tests/db.connection.test.mjs`

- [ ] **Step 1: Write a failing integration-style test using `mongodb-memory-server`**

Create `tests/db.connection.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { connectWithClient, ensureIndexes, closeDb, _resetDbForTesting } from '../lib/db.mjs';

let mongod, client, db;

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('career-ops-test');
  connectWithClient(client, 'career-ops-test');
});

after(async () => {
  await closeDb();
  _resetDbForTesting();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

test('ensureIndexes: creates all expected indexes idempotently', async () => {
  await ensureIndexes();
  // run twice to confirm idempotent
  await ensureIndexes();

  const jobsIdx = await db.collection('jobs').indexes();
  const names = jobsIdx.map(i => i.name);
  assert.ok(names.includes('linkedin_id_1'), `jobs missing linkedin_id_1; got: ${names.join(', ')}`);
  assert.ok(names.includes('jd_fingerprint_1'));
  assert.ok(names.includes('company_title_key_1'));

  const scanRunsIdx = await db.collection('scan_runs').indexes();
  assert.ok(scanRunsIdx.map(i => i.name).includes('run_started_at_-1'));

  const appsIdx = await db.collection('applications').indexes();
  assert.ok(appsIdx.map(i => i.name).includes('num_1'));

  const reportsIdx = await db.collection('reports').indexes();
  assert.ok(reportsIdx.map(i => i.name).includes('num_1'));

  const cvIdx = await db.collection('cv_artifacts').indexes();
  assert.ok(cvIdx.map(i => i.name).includes('job_id_1'));
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.connection.test.mjs`
Expected: fails with missing exports `connectWithClient`, `ensureIndexes`, `closeDb`, `_resetDbForTesting`.

- [ ] **Step 3: Add connection + index code to `lib/db.mjs`**

Append to `lib/db.mjs`:

```js
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
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.connection.test.mjs`
Expected: `# pass 1`. First run downloads mongod binary (~100 MB) if not cached — may take 1-2 minutes.

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.connection.test.mjs
git commit -m "feat(db): connection singleton + idempotent ensureIndexes"
```

---

### Task 1.5: `jobs` collection CRUD

**Files:**
- Modify: `lib/db.mjs`
- Create: `tests/db.jobs.test.mjs`

- [ ] **Step 1: Write failing tests for jobs CRUD**

Create `tests/db.jobs.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  upsertJob, updateJobStage, findJobByLinkedinId, findJobsBySeenSet, findDigestCandidates,
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
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection('jobs').deleteMany({});
});

const sampleJob = (overrides = {}) => ({
  linkedin_id: '4404321456',
  url: 'https://linkedin.com/jobs/view/4404321456',
  title: 'Software Engineer II, Backend',
  title_normalized: 'software-engineer-ii-backend',
  company: 'Pinterest',
  company_slug: 'pinterest',
  company_title_key: 'pinterest|software-engineer-ii-backend',
  jd_fingerprint: 'sha256:abc123',
  location: 'San Francisco, CA',
  description: 'Backend eng.',
  source_metro: 'bay-area',
  posted_at_raw: '2026-04-22',
  posted_time_relative: '6 hours ago',
  first_scan_run_id: null,
  ...overrides,
});

test('upsertJob: inserts new job with stage=raw and first_seen_at', async () => {
  const doc = sampleJob();
  const res = await upsertJob(doc);
  assert.equal(res.upsertedCount, 1);
  const stored = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  assert.equal(stored.stage, 'raw');
  assert.equal(stored.title, 'Software Engineer II, Backend');
  assert.ok(stored.first_seen_at instanceof Date);
  assert.ok(stored.updated_at instanceof Date);
  assert.ok(Array.isArray(stored.stage_history));
  assert.equal(stored.stage_history.length, 1);
  assert.equal(stored.stage_history[0].stage, 'raw');
});

test('upsertJob: re-seeing same linkedin_id updates last_seen_at only (preserves first_seen)', async () => {
  const doc = sampleJob();
  await upsertJob(doc);
  const before = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  await new Promise(r => setTimeout(r, 5));
  await upsertJob(doc);
  const after = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  assert.equal(after.first_seen_at.getTime(), before.first_seen_at.getTime());
  assert.ok(after.last_seen_at.getTime() >= before.last_seen_at.getTime());
  assert.equal(after.stage_history.length, 1, 'does not re-append raw stage');
});

test('updateJobStage: appends to stage_history and updates stage + fields', async () => {
  await upsertJob(sampleJob());
  await updateJobStage('4404321456', 'scored', {
    prefilter_archetype: 'backend',
    prefilter_score: 8,
    prefilter_reason: 'Great Go/Kafka match',
    prefilter_source: 'llm',
  });
  const stored = await db.collection('jobs').findOne({ linkedin_id: '4404321456' });
  assert.equal(stored.stage, 'scored');
  assert.equal(stored.prefilter_score, 8);
  assert.equal(stored.prefilter_archetype, 'backend');
  assert.equal(stored.stage_history.length, 2);
  assert.equal(stored.stage_history[1].stage, 'scored');
  assert.equal(stored.stage_history[1].archetype, 'backend');
});

test('findJobByLinkedinId: returns null for unknown id', async () => {
  const res = await findJobByLinkedinId('nonexistent');
  assert.equal(res, null);
});

test('findJobsBySeenSet: returns set of linkedin_ids already in the collection', async () => {
  await upsertJob(sampleJob({ linkedin_id: 'a1' }));
  await upsertJob(sampleJob({ linkedin_id: 'b2' }));
  const seen = await findJobsBySeenSet(['a1', 'b2', 'c3']);
  assert.ok(seen instanceof Set);
  assert.equal(seen.size, 2);
  assert.ok(seen.has('a1'));
  assert.ok(seen.has('b2'));
  assert.ok(!seen.has('c3'));
});

test('findDigestCandidates: returns jobs matching stage filter, sorted by score desc', async () => {
  await upsertJob(sampleJob({ linkedin_id: 'low' }));
  await upsertJob(sampleJob({ linkedin_id: 'high' }));
  await upsertJob(sampleJob({ linkedin_id: 'cut' }));
  await updateJobStage('low', 'scored', { prefilter_score: 4, prefilter_archetype: 'backend' });
  await updateJobStage('high', 'scored', { prefilter_score: 9, prefilter_archetype: 'backend' });
  await updateJobStage('cut', 'title_cut', {});

  const results = await findDigestCandidates({ stage: 'scored' });
  assert.equal(results.length, 2);
  assert.equal(results[0].linkedin_id, 'high');
  assert.equal(results[1].linkedin_id, 'low');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.jobs.test.mjs`
Expected: fails with missing exports `upsertJob`, `updateJobStage`, `findJobByLinkedinId`, `findJobsBySeenSet`, `findDigestCandidates`.

- [ ] **Step 3: Add jobs CRUD to `lib/db.mjs`**

Append to `lib/db.mjs`:

```js
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
  const historyEntry = { stage, at: now, ...patch };
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
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.jobs.test.mjs`
Expected: `# pass 6`

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.jobs.test.mjs
git commit -m "feat(db): jobs CRUD — upsert, stage transitions, seen-set lookup, digest candidates"
```

---

### Task 1.6: `scan_runs` CRUD

**Files:**
- Modify: `lib/db.mjs`
- Create: `tests/db.scan-runs.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/db.scan-runs.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  insertScanRun, listRecentScanRuns,
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
beforeEach(async () => { await db.collection('scan_runs').deleteMany({}); });

test('insertScanRun: stores doc and returns the ObjectId', async () => {
  const id = await insertScanRun({
    source: 'apify-linkedin',
    metro: 'bay-area',
    apify_actor_id: 'BHzefUZlZRKWxkTck',
    apify_run_id: 'run-123',
    input_params: { title: 'Software Engineer', rows: 20 },
    fetched_count: 20,
    new_count: 5,
    blacklisted_count: 1,
    errors: [],
    run_started_at: new Date('2026-04-23T00:00:00Z'),
    run_finished_at: new Date('2026-04-23T00:01:30Z'),
  });
  assert.ok(id, 'returned an id');
  const stored = await db.collection('scan_runs').findOne({ _id: id });
  assert.equal(stored.source, 'apify-linkedin');
  assert.equal(stored.metro, 'bay-area');
  assert.equal(stored.fetched_count, 20);
});

test('listRecentScanRuns: returns runs sorted by run_started_at desc', async () => {
  await insertScanRun({ source: 's', metro: 'a', run_started_at: new Date('2026-04-22'), input_params: {} });
  await insertScanRun({ source: 's', metro: 'b', run_started_at: new Date('2026-04-23'), input_params: {} });
  await insertScanRun({ source: 's', metro: 'c', run_started_at: new Date('2026-04-21'), input_params: {} });
  const runs = await listRecentScanRuns({ limit: 10 });
  assert.equal(runs.length, 3);
  assert.equal(runs[0].metro, 'b');
  assert.equal(runs[1].metro, 'a');
  assert.equal(runs[2].metro, 'c');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.scan-runs.test.mjs`
Expected: fails with missing exports.

- [ ] **Step 3: Add scan_runs CRUD to `lib/db.mjs`**

Append:

```js
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
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.scan-runs.test.mjs`
Expected: `# pass 2`

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.scan-runs.test.mjs
git commit -m "feat(db): scan_runs CRUD — insert and recent listing"
```

---

### Task 1.7: `applications` CRUD

**Files:**
- Modify: `lib/db.mjs`
- Create: `tests/db.applications.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/db.applications.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  upsertApplication, updateApplicationStatus, listApplications, getNextApplicationNum,
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
beforeEach(async () => { await db.collection('applications').deleteMany({}); });

test('getNextApplicationNum: returns 1 when empty, increments thereafter', async () => {
  assert.equal(await getNextApplicationNum(), 1);
  await upsertApplication({ num: 1, date: '2026-04-23', company: 'Foo', role: 'SWE', status: 'Applied', job_id: 'a' });
  assert.equal(await getNextApplicationNum(), 2);
  await upsertApplication({ num: 2, date: '2026-04-23', company: 'Bar', role: 'SWE', status: 'Applied', job_id: 'b' });
  assert.equal(await getNextApplicationNum(), 3);
});

test('upsertApplication: inserts by job_id, updates existing on re-upsert', async () => {
  await upsertApplication({ num: 1, date: '2026-04-22', company: 'Foo', role: 'SWE', status: 'Evaluated', job_id: 'x1', score: 4.2 });
  let stored = await db.collection('applications').findOne({ job_id: 'x1' });
  assert.equal(stored.status, 'Evaluated');

  await upsertApplication({ num: 1, date: '2026-04-23', company: 'Foo', role: 'SWE', status: 'Applied', job_id: 'x1', score: 4.2 });
  stored = await db.collection('applications').findOne({ job_id: 'x1' });
  assert.equal(stored.status, 'Applied');
  assert.equal(stored.date, '2026-04-23');
});

test('updateApplicationStatus: transitions status and appends history', async () => {
  await upsertApplication({ num: 1, date: '2026-04-22', company: 'Foo', role: 'SWE', status: 'Applied', job_id: 'y1' });
  await updateApplicationStatus(1, 'Interview', 'Phone screen scheduled');
  const stored = await db.collection('applications').findOne({ num: 1 });
  assert.equal(stored.status, 'Interview');
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].status, 'Interview');
  assert.equal(stored.history[0].note, 'Phone screen scheduled');
});

test('listApplications: filters by status, sorts by date desc', async () => {
  await upsertApplication({ num: 1, date: '2026-04-20', company: 'A', role: 'r', status: 'Applied', job_id: '1' });
  await upsertApplication({ num: 2, date: '2026-04-22', company: 'B', role: 'r', status: 'Applied', job_id: '2' });
  await upsertApplication({ num: 3, date: '2026-04-21', company: 'C', role: 'r', status: 'Rejected', job_id: '3' });
  const applied = await listApplications({ status: 'Applied' });
  assert.equal(applied.length, 2);
  assert.equal(applied[0].company, 'B');
  assert.equal(applied[1].company, 'A');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.applications.test.mjs`
Expected: missing exports.

- [ ] **Step 3: Add applications CRUD to `lib/db.mjs`**

Append:

```js
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
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.applications.test.mjs`
Expected: `# pass 4`

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.applications.test.mjs
git commit -m "feat(db): applications CRUD — upsert, status transitions, list"
```

---

### Task 1.8: `reports` CRUD

**Files:**
- Modify: `lib/db.mjs`
- Create: `tests/db.reports.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/db.reports.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  insertReport, updateReportVerdict, getNextReportNum, findReportByJobId,
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
beforeEach(async () => { await db.collection('reports').deleteMany({}); });

test('getNextReportNum: starts at 1, increments', async () => {
  assert.equal(await getNextReportNum(), 1);
  await insertReport({
    num: 1, job_id: 'a', company_slug: 'foo',
    report_path: 'reports/foo/a_report.md',
    score: 4, verdict: 'evaluated', url: 'http://x',
    generated_at: new Date(),
    checksum_md: 'sha256:x',
  });
  assert.equal(await getNextReportNum(), 2);
});

test('insertReport: stores doc, retrievable by job_id', async () => {
  const id = await insertReport({
    num: 1, job_id: 'abc', company_slug: 'pinterest',
    report_path: 'reports/pinterest/abc_report.md',
    score: 4.5, verdict: 'evaluated', url: 'http://x', generated_at: new Date(),
    checksum_md: 'sha256:x',
    block_scores: { a: 4.5, b: 4.0 },
  });
  assert.ok(id);
  const got = await findReportByJobId('abc');
  assert.equal(got.num, 1);
  assert.equal(got.score, 4.5);
  assert.deepEqual(got.block_scores, { a: 4.5, b: 4.0 });
});

test('updateReportVerdict: changes verdict and stamps updated_at', async () => {
  await insertReport({
    num: 1, job_id: 'ver', company_slug: 'c',
    report_path: 'reports/c/ver_report.md',
    score: 4, verdict: 'evaluated', url: 'http://x', generated_at: new Date(),
    checksum_md: 'sha256:x',
  });
  await updateReportVerdict(1, 'applied');
  const got = await findReportByJobId('ver');
  assert.equal(got.verdict, 'applied');
  assert.ok(got.updated_at instanceof Date);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.reports.test.mjs`
Expected: missing exports.

- [ ] **Step 3: Add reports CRUD to `lib/db.mjs`**

Append:

```js
// ── reports ────────────────────────────────────────────────────────

export async function getNextReportNum() {
  const db = await getDb();
  const highest = await withRetry(() => db.collection('reports')
    .find({}, { projection: { num: 1, _id: 0 } })
    .sort({ num: -1 })
    .limit(1)
    .toArray());
  return highest.length === 0 ? 1 : highest[0].num + 1;
}

export async function insertReport(doc) {
  const db = await getDb();
  const result = await withRetry(() => db.collection('reports').insertOne(doc));
  return result.insertedId;
}

export async function updateReportVerdict(num, verdict) {
  const db = await getDb();
  return await withRetry(() => db.collection('reports').updateOne(
    { num },
    { $set: { verdict, updated_at: new Date() } },
  ));
}

export async function findReportByJobId(job_id) {
  const db = await getDb();
  return await withRetry(() => db.collection('reports').findOne({ job_id }));
}
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.reports.test.mjs`
Expected: `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.reports.test.mjs
git commit -m "feat(db): reports CRUD — insert, verdict updates, lookup by job_id"
```

---

### Task 1.9: `cv_artifacts` CRUD

**Files:**
- Modify: `lib/db.mjs`
- Create: `tests/db.cv-artifacts.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/db.cv-artifacts.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.cv-artifacts.test.mjs`
Expected: missing exports.

- [ ] **Step 3: Add cv_artifacts CRUD**

Append to `lib/db.mjs`:

```js
// ── cv_artifacts ───────────────────────────────────────────────────

export async function upsertCvArtifact(doc) {
  const db = await getDb();
  const now = new Date();
  const { job_id, ...rest } = doc;
  return await withRetry(() => db.collection('cv_artifacts').updateOne(
    { job_id },
    {
      $set: { ...rest, job_id, generated_at: now },
    },
    { upsert: true },
  ));
}

export async function updateCvValidation(job_id, status, errors = []) {
  const db = await getDb();
  return await withRetry(() => db.collection('cv_artifacts').updateOne(
    { job_id },
    { $set: { validation_status: status, validation_errors: errors, validated_at: new Date() } },
  ));
}

export async function findCvArtifactByJobId(job_id) {
  const db = await getDb();
  return await withRetry(() => db.collection('cv_artifacts').findOne({ job_id }));
}
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/db.cv-artifacts.test.mjs`
Expected: `# pass 2`

- [ ] **Step 5: Commit**

```bash
git add lib/db.mjs tests/db.cv-artifacts.test.mjs
git commit -m "feat(db): cv_artifacts CRUD — upsert, validation updates, lookup"
```

---

### Task 1.10: Connectivity smoke test script

**Files:**
- Create: `smoke-db.mjs`
- Create: `tests/db.integration.test.mjs`

- [ ] **Step 1: Create `smoke-db.mjs`**

Create `smoke-db.mjs`:

```js
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
```

- [ ] **Step 2: Run the smoke script**

Run: `cd /Users/xiaoxuan/resume/career-ops && node smoke-db.mjs`
Expected output:
```
[smoke-db] Connecting to brick-free-cluster0.suun1hz.mongodb.net
[smoke-db] Connected. Ensuring indexes...
[smoke-db] Indexes ready.
[smoke-db] Inserted smoke-...
[smoke-db] Read-back OK
[smoke-db] Cleanup OK
{ "ok": true, "cluster": "...", "database": "career-ops" }
```

If it fails: verify `.env` has all 5 MONGODB_* vars, and Atlas Network Access allows your IP (or 0.0.0.0/0).

- [ ] **Step 3: Create a gated integration test**

Create `tests/db.integration.test.mjs`:

```js
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
```

- [ ] **Step 4: Run gated integration test**

Run: `cd /Users/xiaoxuan/resume/career-ops && MONGO_INTEGRATION_TEST=1 node --test tests/db.integration.test.mjs`
Expected: `# pass 1`. (Without the env var: test is skipped.)

- [ ] **Step 5: Commit**

```bash
git add smoke-db.mjs tests/db.integration.test.mjs
git commit -m "feat(db): smoke-db script + gated integration test against Atlas"
```

---

## Phase 2 — `apify-scan.mjs` migration

Move scan dedup + new-job writes from `seen-jobs.tsv` / `apify-new-*.json` to Mongo. Keep TSV writes behind `DUAL_WRITE_FILES=1` during transition.

### Task 2.1: `apify-scan.mjs` — Mongo-first dedup + upserts

**Files:**
- Modify: `apify-scan.mjs`
- Create: `tests/apify-scan.mongo.test.mjs`

- [ ] **Step 1: Write a failing integration-style test**

Create `tests/apify-scan.mongo.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  connectWithClient, closeDb, _resetDbForTesting, ensureIndexes,
  findJobByLinkedinId, listRecentScanRuns,
} from '../lib/db.mjs';
import { runApifyScan } from '../apify-scan.mjs';

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
beforeEach(async () => {
  await db.collection('jobs').deleteMany({});
  await db.collection('scan_runs').deleteMany({});
});

function makeMockApifyClient(items) {
  return {
    actor: () => ({ call: async () => ({ defaultDatasetId: 'd1' }) }),
    dataset: () => ({ listItems: async () => ({ items }) }),
  };
}

test('runApifyScan: writes scan_run + upserts jobs to Mongo', async () => {
  const apifyClient = makeMockApifyClient([
    { jobUrl: 'https://www.linkedin.com/jobs/view/9001', title: 'Backend Eng', companyName: 'Acme', location: 'SF', description: 'Go Kafka.', postedTime: '1 hour ago' },
    { jobUrl: 'https://www.linkedin.com/jobs/view/9002', title: 'Platform Eng', companyName: 'Globex', location: 'SF', description: 'K8s Terraform.', postedTime: '2 hours ago' },
  ]);
  const config = {
    actor_id: 'TEST', api_token_env: 'F',
    default_params: { title: 'Software Engineer', proxy: {} },
    locations: [{ name: 'bay-area', location: 'SF Bay Area', geoId: '90000084', baseline_rows: 20, hourly_rows: 10 }],
    baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
    hourly: { params: { publishedAt: 'r86400' } },
  };
  const result = await runApifyScan({
    config,
    client: apifyClient,
    hourOverride: 7,
    seenJobsPath: '/tmp/unused.tsv',   // not used when DUAL_WRITE_FILES unset
    apifyNewPath: '/tmp/unused.json',  // not used when DUAL_WRITE_FILES unset
  });
  assert.equal(result.totalNew, 2);

  const job1 = await findJobByLinkedinId('9001');
  assert.ok(job1);
  assert.equal(job1.stage, 'raw');
  assert.equal(job1.company, 'Acme');
  assert.equal(job1.source_metro, 'bay-area');

  const runs = await listRecentScanRuns({});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, 'apify-linkedin');
  assert.equal(runs[0].metro, 'bay-area');
  assert.equal(runs[0].fetched_count, 2);
  assert.equal(runs[0].new_count, 2);
});

test('runApifyScan: re-seeing a job upserts without re-adding to raw', async () => {
  const apifyClient = makeMockApifyClient([
    { jobUrl: 'https://www.linkedin.com/jobs/view/9003', title: 'Infra', companyName: 'Init', location: 'SF', description: 'K8s.', postedTime: '3h' },
  ]);
  const config = {
    actor_id: 'T', api_token_env: 'F',
    default_params: { title: 'SWE', proxy: {} },
    locations: [{ name: 'bay-area', location: 'SF', geoId: 'g', baseline_rows: 5, hourly_rows: 5 }],
    baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
    hourly: { params: { publishedAt: 'r86400' } },
  };
  await runApifyScan({ config, client: apifyClient, hourOverride: 7, seenJobsPath: '/tmp/x.tsv', apifyNewPath: '/tmp/x.json' });
  const first = await findJobByLinkedinId('9003');

  await new Promise(r => setTimeout(r, 5));
  const result = await runApifyScan({ config, client: apifyClient, hourOverride: 7, seenJobsPath: '/tmp/x.tsv', apifyNewPath: '/tmp/x.json' });
  assert.equal(result.totalNew, 0);

  const second = await findJobByLinkedinId('9003');
  assert.equal(second.first_seen_at.getTime(), first.first_seen_at.getTime(), 'first_seen preserved');
  assert.ok(second.last_seen_at.getTime() >= first.last_seen_at.getTime(), 'last_seen advanced');
  assert.equal(second.stage_history.length, 1, 'did not re-append raw');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/apify-scan.mongo.test.mjs`
Expected: failures — `runApifyScan` doesn't write to Mongo yet.

- [ ] **Step 3: Update `apify-scan.mjs` to write to Mongo**

Open `apify-scan.mjs`. Modify the imports at the top:

```js
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ApifyClient } from 'apify-client';
import {
  extractLinkedInId,
  normalizeCompany,
  normalizeTitle,
  computeJdFingerprint,
  loadSeenJobs,
  appendSeenJobs,
  isCompanyBlacklisted,
} from './lib/dedup.mjs';
import { insertScanRun, upsertJob, findJobsBySeenSet } from './lib/db.mjs';
```

Inside `runApifyScan`, replace the dedup-via-seen-jobs-tsv logic + new-job push. Before the fetch loop, insert a scan run; after each fetched item, upsert to Mongo (instead of the current `seen.linkedinIds.has` check). Full new body of the function:

```js
export async function runApifyScan({ config, client, seenJobsPath, apifyNewPath, hourOverride, dryRun = false, blacklist = [] }) {
  const hour = hourOverride !== undefined
    ? hourOverride
    : new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
  const hourNum = typeof hour === 'number' ? hour : parseInt(hour, 10);
  const isBaseline = hourNum === 7;
  const dualWrite = process.env.DUAL_WRITE_FILES === '1';

  const params = {
    defaultParams: config.default_params,
    publishedAt: isBaseline ? config.baseline.params.publishedAt : config.hourly.params.publishedAt,
  };

  const runStartedAt = new Date();
  const settled = await Promise.allSettled(
    config.locations.map(loc =>
      dryRun
        ? Promise.resolve({ metro: loc.name, items: [] })
        : scanOneLocation({
            location: loc,
            params: { ...params, rows: isBaseline ? loc.baseline_rows : loc.hourly_rows },
            client,
            actorId: config.actor_id,
          })
    )
  );
  const runFinishedAt = new Date();

  const sources = [];
  const errors = [];
  const newRows = [];
  const newJobs = [];

  // Run-level totals for the scan_runs audit doc
  let totalFetched = 0;
  let totalNewCount = 0;
  let totalBlacklistedCount = 0;

  // TSV dedup seed (only loaded if dual-write enabled)
  let tsvSeen = null;
  if (dualWrite) {
    tsvSeen = await loadSeenJobs(seenJobsPath);
  }

  // Pre-pull Mongo's seen-set in one query (cheap) for the metros' collective
  // fetched linkedin_ids. We do this per metro so Mongo updates from earlier
  // metros are visible to later ones in the same run.
  const scanRunId = dryRun ? null : await insertScanRun({
    source: 'apify-linkedin',
    metro: config.locations.length === 1 ? config.locations[0].name : 'multi',
    apify_actor_id: config.actor_id,
    apify_run_id: null,  // could thread through from scanOneLocation if needed
    input_params: {
      title: (params.defaultParams && params.defaultParams.title) || null,
      publishedAt: params.publishedAt,
      locations: config.locations.map(l => ({ name: l.name, geoId: l.geoId })),
    },
    run_started_at: runStartedAt,
    run_finished_at: runFinishedAt,
    fetched_count: 0,
    new_count: 0,
    blacklisted_count: 0,
    errors: [],
  });

  for (let i = 0; i < settled.length; i++) {
    const loc = config.locations[i];
    const r = settled[i];
    if (r.status === 'rejected') {
      errors.push({ metro: loc.name, error: r.reason?.message || String(r.reason) });
      continue;
    }
    const items = r.value.items || [];
    totalFetched += items.length;
    let newCount = 0;
    let blacklistedCount = 0;
    const linkedinIds = items.map(j => extractLinkedInId(j.jobUrl || j.url)).filter(Boolean);

    // Query Mongo for which of these IDs are already seen in one round-trip.
    const mongoSeen = dryRun ? new Set() : await findJobsBySeenSet(linkedinIds);

    for (const j of items) {
      const jobUrl      = j.jobUrl      || j.url;
      const companyName = j.companyName || j.company;
      const title       = j.title       || '';
      const jobLocation = j.location    || '';
      const publishedAt = j.publishedAt || j.posted_at || '';

      const linkedin_id = extractLinkedInId(jobUrl);
      if (!linkedin_id) continue;

      if (isCompanyBlacklisted(companyName, blacklist)) {
        blacklistedCount++;
        continue;
      }

      if (mongoSeen.has(linkedin_id)) {
        // Still upsert to refresh last_seen_at / last_scan_run_id.
        if (!dryRun) {
          await upsertJob({
            linkedin_id,
            url: jobUrl,
            title,
            title_normalized: normalizeTitle(title || ''),
            company: companyName,
            company_slug: normalizeCompany(companyName || ''),
            company_title_key: `${normalizeCompany(companyName || '')}|${normalizeTitle(title || '')}`,
            jd_fingerprint: j.description ? computeJdFingerprint(j.description) : null,
            location: jobLocation,
            description: (j.description || '').slice(0, 4000),
            source_metro: loc.name,
            posted_at_raw: publishedAt,
            posted_time_relative: j.postedTime || '',
            first_scan_run_id: scanRunId,
          });
        }
        continue;
      }

      // New job → upsert inserts
      const company_slug = normalizeCompany(companyName || '');
      const title_normalized = normalizeTitle(title || '');
      const fingerprint = j.description ? computeJdFingerprint(j.description) : null;

      if (!dryRun) {
        await upsertJob({
          linkedin_id,
          url: jobUrl,
          title,
          title_normalized,
          company: companyName,
          company_slug,
          company_title_key: `${company_slug}|${title_normalized}`,
          jd_fingerprint: fingerprint,
          location: jobLocation,
          description: (j.description || '').slice(0, 4000),
          source_metro: loc.name,
          posted_at_raw: publishedAt,
          posted_time_relative: j.postedTime || '',
          first_scan_run_id: scanRunId,
        });
      }

      newJobs.push({
        linkedin_id,
        url: jobUrl,
        title,
        company: companyName,
        company_slug,
        location: jobLocation || loc.location,
        description: (j.description || '').slice(0, 4000),
        posted_at: publishedAt || '',
        source_metro: loc.name,
      });

      if (dualWrite && tsvSeen) {
        newRows.push({
          linkedin_id,
          url: jobUrl,
          company_slug,
          title_normalized,
          first_seen_utc: runStartedAt.toISOString(),
          last_seen_utc: runStartedAt.toISOString(),
          source: `apify-linkedin-${loc.name}`,
          status: 'new',
          jd_fingerprint: fingerprint || '(none)',
          prefilter_archetype: '(none)',
          prefilter_score: '(none)',
          prefilter_reason: '(none)',
        });
      }
      newCount++;
    }
    totalNewCount += newCount;
    totalBlacklistedCount += blacklistedCount;
    sources.push({ metro: loc.name, fetched: items.length, new: newCount, blacklisted: blacklistedCount });
  }

  // Update scan_runs doc with the per-metro totals
  if (!dryRun && scanRunId) {
    const { getDb } = await import('./lib/db.mjs');
    const db = await getDb();
    await db.collection('scan_runs').updateOne(
      { _id: scanRunId },
      { $set: { fetched_count: totalFetched, new_count: totalNewCount, blacklisted_count: totalBlacklistedCount, errors } },
    );
  }

  if (dualWrite && newRows.length > 0) await appendSeenJobs(seenJobsPath, newRows);
  if (dualWrite) {
    const payload = {
      run_started_utc: runStartedAt.toISOString(),
      run_finished_utc: runFinishedAt.toISOString(),
      sources,
      total_new_jobs: newJobs.length,
      cost_estimate_usd: Number((newJobs.length * 0.001).toFixed(3)),
      errors,
      new_jobs: newJobs,
    };
    writeFileSync(apifyNewPath, JSON.stringify(payload, null, 2));
  }

  return { sources, errors, totalNew: newJobs.length, scanRunId };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/apify-scan.mongo.test.mjs tests/apify-scan.test.mjs`
Expected: all existing `apify-scan.test.mjs` tests still pass + 2 new Mongo tests pass. The existing TSV-writing tests need to set `DUAL_WRITE_FILES=1`. If they fail because they expect a TSV file to be written unconditionally, update them to set the env var or assert only the return-value shape.

- [ ] **Step 5: Fix existing `apify-scan.test.mjs` tests to account for dual-write gating**

Open `tests/apify-scan.test.mjs`. For each existing test that asserts `seen-jobs.tsv` was written, wrap the call with `process.env.DUAL_WRITE_FILES = '1'` before and `delete process.env.DUAL_WRITE_FILES` after. Also set up + tear down a mongodb-memory-server like the new tests do (since `runApifyScan` now always talks to Mongo).

The simplest path: make each existing test stand up its own in-memory Mongo. Look at the pattern used in `tests/apify-scan.mongo.test.mjs` and replicate. If the tests are extensive, split into a separate commit.

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/apify-scan.test.mjs tests/apify-scan.mongo.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apify-scan.mjs tests/apify-scan.mongo.test.mjs tests/apify-scan.test.mjs
git commit -m "feat(apify-scan): Mongo-first dedup + scan_runs audit; DUAL_WRITE_FILES for TSV"
```

---

## Phase 3 — `digest-builder.mjs` migration

Read candidates from Mongo, write stage transitions + scores back to Mongo.

### Task 3.1: `digest-builder.mjs` — Mongo-backed candidate query + stage writes

**Files:**
- Modify: `digest-builder.mjs`
- Create: `tests/digest-builder.mongo.test.mjs`

- [ ] **Step 1: Write failing integration test**

Create `tests/digest-builder.mongo.test.mjs`:

```js
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
  const now = new Date();
  await upsertJob({ linkedin_id: 'j1', title: 'Backend Eng', company: 'Acme', company_slug: 'acme', company_title_key: 'acme|backend-eng', jd_fingerprint: 'fp1', description: 'x', source_metro: 'bay', url: 'u1', title_normalized: 'backend-eng' });
  const candidates = await loadCandidatesFromMongo({ sinceHours: 24 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].linkedin_id, 'j1');
});

test('runDigestStage2AndScoring: applies title filter, writes stage=title_cut or scored', async () => {
  await upsertJob({ linkedin_id: 'keep', title: 'Backend Engineer', company: 'Acme', company_slug: 'acme', company_title_key: 'acme|backend-engineer', jd_fingerprint: 'fp1', description: 'Go/Kafka', source_metro: 'bay', url: 'uk', title_normalized: 'backend-engineer' });
  await upsertJob({ linkedin_id: 'drop', title: 'Junior Software Engineer', company: 'B', company_slug: 'b', company_title_key: 'b|junior-software-engineer', jd_fingerprint: 'fp2', description: 'x', source_metro: 'bay', url: 'ud', title_normalized: 'junior-software-engineer' });

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
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/digest-builder.mongo.test.mjs`
Expected: missing exports `loadCandidatesFromMongo`, `runDigestStage2AndScoring`.

- [ ] **Step 3: Add Mongo-aware candidate loader + scoring driver to `digest-builder.mjs`**

In `digest-builder.mjs`, add two new exported functions. Near the top of the file, add these imports:

```js
import { findDigestCandidates, updateJobStage } from './lib/db.mjs';
```

Append the following functions at the bottom of the file:

```js
/**
 * Load candidates for today's digest from Mongo. Pulls jobs in stage='raw'
 * or stage='scored' (for re-scoring / re-digesting) whose first_seen_at is
 * within the given time window.
 */
export async function loadCandidatesFromMongo({ sinceHours = 24 } = {}) {
  const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000);
  return await findDigestCandidates({
    first_seen_at: { $gte: cutoff },
    stage: { $in: ['raw', 'scored'] },
  });
}

/**
 * Run title filter + Haiku scoring across the candidate list. Writes
 * stage transitions to Mongo via updateJobStage.
 */
export async function runDigestStage2AndScoring({ candidates, portals, profile, sources, haikuClient, llmConfig, dealBreakers }) {
  const candidateSummary = buildCandidateSummary(profile, sources);
  for (const job of candidates) {
    if (!applyTitleFilter(job.title, portals.title_filter, dealBreakers)) {
      await updateJobStage(job.linkedin_id, 'title_cut', { reason: 'title filter' });
      continue;
    }
    const { archetype, score, reason } = await preFilterJob(job, SYSTEM_PROMPT, candidateSummary, haikuClient, llmConfig);
    await updateJobStage(job.linkedin_id, 'scored', {
      prefilter_archetype: archetype,
      prefilter_score: score,
      prefilter_reason: reason,
      prefilter_source: 'llm',  // extend to 'llm-retry' / 'deterministic-fallback' when preFilterJob exposes it
    });
  }
}
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/digest-builder.mongo.test.mjs`
Expected: `# pass 2`

- [ ] **Step 5: Wire Mongo-backed flow into `digest-builder.mjs` main()**

In `digest-builder.mjs`, replace the existing main() orchestration that loads `data/apify-new-*.json` with a Mongo-based flow. Locate the existing `buildDigest` call in `main()` and prepend a Mongo pull:

```js
// In main(), after loading config + portals but before building digest:
const candidates = await loadCandidatesFromMongo({ sinceHours: 24 });
console.error(`[digest-builder] ${candidates.length} candidates from Mongo (last 24h)`);

// Haiku client setup (existing)...

await runDigestStage2AndScoring({
  candidates, portals, profile, sources,
  haikuClient, llmConfig, dealBreakers,
});

// Now query Mongo for scored jobs and render digest.md from that:
const digested = await findDigestCandidates({ stage: 'scored' });
// ...pass digested into buildDigest() instead of reading files...
```

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test`
Expected: all prior tests green + new Mongo tests green (except pre-existing Go dashboard failure).

- [ ] **Step 7: Commit**

```bash
git add digest-builder.mjs tests/digest-builder.mongo.test.mjs
git commit -m "feat(digest-builder): pull candidates from Mongo + write stage transitions"
```

---

## Phase 4 — `assemble-cv.mjs` + `validate-cv.mjs` migration

Per-job CV paths, `cv_artifacts` metadata, validation results persisted.

### Task 4.1: `assemble-cv.mjs` — job id derivation + per-job paths

**Files:**
- Modify: `assemble-cv.mjs`
- Create: `tests/assemble-cv.mongo.test.mjs`

- [ ] **Step 1: Write failing test for job-id derivation from JD fingerprint**

Create `tests/assemble-cv.mongo.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectWithClient, closeDb, _resetDbForTesting, ensureIndexes, upsertJob, findCvArtifactByJobId } from '../lib/db.mjs';
import { deriveJobIdForCv, buildCvPaths } from '../assemble-cv.mjs';

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
beforeEach(async () => { await db.collection('jobs').deleteMany({}); await db.collection('cv_artifacts').deleteMany({}); });

test('deriveJobIdForCv: matches by JD fingerprint when present', async () => {
  await upsertJob({ linkedin_id: '42', title: 'X', company: 'Y', company_slug: 'y', company_title_key: 'y|x', jd_fingerprint: 'sha256:fp1', url: 'u', title_normalized: 'x', description: 'd', source_metro: 'bay' });
  const id = await deriveJobIdForCv({ jdText: 'd' });  // fingerprint computed internally matches 'sha256:fp1' if description is 'd'
  assert.equal(id.job_id, '42');
  assert.equal(id.link_status, 'linked');
});

test('deriveJobIdForCv: falls back to synthetic id when no match', async () => {
  const id = await deriveJobIdForCv({ jdText: 'unmatched-content', jdSlug: 'instacart-ml-platform' });
  assert.equal(id.job_id, 'synthetic-instacart-ml-platform');
  assert.equal(id.link_status, 'unlinked');
});

test('buildCvPaths: produces cvs/{company}/{title}/{job_id}_cv.{md,tex}', () => {
  const paths = buildCvPaths({ company_slug: 'instacart', title_slug: 'senior-engineer-ml-ai-platform', job_id: '4404321456' });
  assert.equal(paths.cv_md_path, 'cvs/instacart/senior-engineer-ml-ai-platform/4404321456_cv.md');
  assert.equal(paths.cv_tex_path, 'cvs/instacart/senior-engineer-ml-ai-platform/4404321456_cv.tex');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/assemble-cv.mongo.test.mjs`
Expected: missing exports.

- [ ] **Step 3: Add the two helpers to `assemble-cv.mjs`**

At the top of `assemble-cv.mjs`, add the import:

```js
import { computeJdFingerprint } from './lib/dedup.mjs';
import { getDb, upsertCvArtifact } from './lib/db.mjs';
```

Near the other utility functions, export:

```js
/**
 * Resolve the job_id for CV generation. If the JD's fingerprint matches a
 * record in the jobs collection, use that record's linkedin_id. Otherwise
 * fall back to a synthetic id derived from the JD file slug — the CV gets
 * written but with link_status='unlinked' in the cv_artifacts doc.
 */
export async function deriveJobIdForCv({ jdText, jdSlug = null }) {
  const fp = computeJdFingerprint(jdText);
  const db = await getDb();
  const match = await db.collection('jobs').findOne({ jd_fingerprint: fp });
  if (match) return { job_id: match.linkedin_id, link_status: 'linked', fingerprint: fp, matched_job: match };
  return { job_id: `synthetic-${jdSlug || 'unknown'}`, link_status: 'unlinked', fingerprint: fp };
}

/**
 * Build the per-job CV file paths (relative to repo root).
 */
export function buildCvPaths({ company_slug, title_slug, job_id }) {
  const dir = `cvs/${company_slug}/${title_slug}`;
  return {
    cv_md_path:  `${dir}/${job_id}_cv.md`,
    cv_tex_path: `${dir}/${job_id}_cv.tex`,
    cv_pdf_path: `${dir}/${job_id}_cv.pdf`,
    dir,
  };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/assemble-cv.mongo.test.mjs`
Expected: `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add assemble-cv.mjs tests/assemble-cv.mongo.test.mjs
git commit -m "feat(assemble-cv): job-id derivation via JD fingerprint + per-job CV paths"
```

---

### Task 4.2: `assemble-cv.mjs` — write to per-job paths + upsert metadata

**Files:**
- Modify: `assemble-cv.mjs`

- [ ] **Step 1: Update main() to write to per-job path + call upsertCvArtifact**

In `assemble-cv.mjs`, locate the `writeFileSync(OUT_TAILORED, md)` call near the end of `main()`. Replace the file-output section with:

```js
  // 9. Determine per-job CV paths + write files
  const jdSlug = args.jd.replace(/^.*\//, '').replace(/\.md$/, '');
  const { job_id, link_status, fingerprint, matched_job } = await deriveJobIdForCv({ jdText, jdSlug });
  const company_slug = matched_job?.company_slug || jdSlug;
  const title_slug = matched_job
    ? matched_job.title_normalized
    : jdSlug;  // synthetic-path unlinked CVs
  const paths = buildCvPaths({ company_slug, title_slug, job_id });

  // Ensure per-job directory exists
  const { mkdirSync } = await import('node:fs');
  mkdirSync(resolve(__dirname, paths.dir), { recursive: true });

  // Write the per-job CV file
  const cvMdFullPath = resolve(__dirname, paths.cv_md_path);
  writeFileSync(cvMdFullPath, md);

  // Compute checksum for integrity detection
  const { createHash } = await import('node:crypto');
  const checksum_md = 'sha256:' + createHash('sha256').update(md).digest('hex');

  // Profile fingerprint — captures "did the candidate change their profile"
  const profileText = readFileSync(PROFILE_PATH, 'utf-8');
  const profile_version_hash = 'sha256:' + createHash('sha256').update(profileText).digest('hex');

  // Upsert cv_artifacts doc
  await upsertCvArtifact({
    job_id,
    company_slug,
    title_slug,
    cv_md_path: paths.cv_md_path,
    cv_tex_path: null,
    cv_pdf_path: null,
    jd_fingerprint: fingerprint,
    profile_version_hash,
    archetype,
    intent_source: intent._source,
    checksum_md,
    _link_status: link_status,
  });

  // Back-compat: keep writing cv.tailored.md as the flat "latest CV" during transition
  writeFileSync(OUT_TAILORED, md);
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2));

  console.log(JSON.stringify({
    ok: true,
    output: cvMdFullPath,
    output_flat: OUT_TAILORED,
    job_id,
    link_status,
    archetype,
    companies: meta.companies,
  }, null, 2));
}
```

- [ ] **Step 2: Run assemble against a test JD**

Run (requires live Mongo env):
```bash
cd /Users/xiaoxuan/resume/career-ops && node assemble-cv.mjs --jd=__fixtures__/jds/instacart-senior-engineer-ml-ai-platform.md 2>&1 | tail -15
```
Expected: the output JSON includes `output: .../cvs/.../...`, `job_id`, and `link_status`. File exists at the new path; `cv.tailored.md` still exists as copy; `cv_artifacts` collection has a new document for the job_id.

- [ ] **Step 3: Run existing e2e tests to ensure nothing broke**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/e2e.assemble.test.mjs`
Expected: all pass. If they explicitly check `cv.tailored.md`, they still find it (back-compat copy).

- [ ] **Step 4: Commit**

```bash
git add assemble-cv.mjs
git commit -m "feat(assemble-cv): write CV to per-job path + upsert cv_artifacts"
```

---

### Task 4.3: `validate-cv.mjs` — persist validation result to Mongo

**Files:**
- Modify: `validate-cv.mjs`

- [ ] **Step 1: Add Mongo update after validation runs**

Open `validate-cv.mjs`. At the top, add imports:

```js
import 'dotenv/config';
import { updateCvValidation } from './lib/db.mjs';
```

After the validation result is computed but before `process.exit()`, add:

```js
  // Persist validation result to cv_artifacts (if the user ran assemble-cv.mjs,
  // a cv_artifacts doc exists keyed by job_id derived from the same JD).
  if (result.ok !== undefined) {
    const fs = await import('node:fs');
    let job_id = null;
    try {
      // The simplest mapping: read .cv-tailored-meta.json to get intent / jd path,
      // then derive job_id via the same fingerprint lookup used in assemble-cv.
      const metaRaw = fs.readFileSync('.cv-tailored-meta.json', 'utf-8');
      const meta = JSON.parse(metaRaw);
      if (meta.jd) {
        const jdText = fs.readFileSync(meta.jd, 'utf-8');
        const { deriveJobIdForCv } = await import('./assemble-cv.mjs');
        const jdSlug = meta.jd.replace(/^.*\//, '').replace(/\.md$/, '');
        const derived = await deriveJobIdForCv({ jdText, jdSlug });
        job_id = derived.job_id;
      }
    } catch (err) {
      console.error(`[validate-cv] could not resolve job_id for validation record: ${err.message}`);
    }
    if (job_id) {
      const status = result.ok ? 'ok' : (result.errors[0]?.type || 'failed');
      await updateCvValidation(job_id, status, result.errors || []);
    }
  }
```

- [ ] **Step 2: Run validation on a test CV**

```bash
cd /Users/xiaoxuan/resume/career-ops && node validate-cv.mjs cv.tailored.md
```
Expected: existing stdout (`{ok: true, checks_passed: 3}`) plus a new `cv_artifacts` doc in Mongo with `validation_status: 'ok'`.

- [ ] **Step 3: Commit**

```bash
git add validate-cv.mjs
git commit -m "feat(validate-cv): persist validation result to cv_artifacts"
```

---

## Phase 5 — Reports + applications

### Task 5.1: `add-application.mjs` CLI for manual entry

**Files:**
- Create: `add-application.mjs`

- [ ] **Step 1: Create the CLI**

Create `add-application.mjs`:

```js
#!/usr/bin/env node
/**
 * add-application.mjs — CLI to manually enter an application into Mongo.
 *
 * Usage:
 *   node add-application.mjs \
 *     --job-id=4405461688 \
 *     --company="Rippling" \
 *     --role="SWE II Backend" \
 *     --url=https://linkedin.com/... \
 *     --status=Applied \
 *     [--date=2026-04-23] \
 *     [--score=4.5] \
 *     [--note="phone screen scheduled"]
 */
import 'dotenv/config';
import { upsertApplication, getNextApplicationNum, closeDb } from './lib/db.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1].replace(/-/g, '_')] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['company', 'role', 'status']) {
    if (!args[required]) {
      console.error(`Missing --${required}`);
      process.exit(1);
    }
  }
  const num = await getNextApplicationNum();
  await upsertApplication({
    num,
    job_id: args.job_id || `synthetic-${num}`,
    company: args.company,
    role: args.role,
    status: args.status,
    url: args.url || '',
    date: args.date || new Date().toISOString().split('T')[0],
    score: args.score ? parseFloat(args.score) : null,
    notes: args.note || '',
    pdf_generated: false,
    report_id: null,
    cv_artifact_ids: [],
  });
  console.log(JSON.stringify({ ok: true, num }, null, 2));
  await closeDb();
}

main().catch(err => {
  console.error('add-application failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Test manually**

Run:
```bash
cd /Users/xiaoxuan/resume/career-ops && node add-application.mjs --company=TestCo --role="SWE" --status=Applied
```
Expected: `{"ok": true, "num": N}` where N is the next sequential number.

- [ ] **Step 3: Commit**

```bash
git add add-application.mjs
git commit -m "feat(applications): add-application.mjs CLI for manual entries"
```

---

### Task 5.2: `merge-tracker.mjs` — render applications.md from Mongo

**Files:**
- Modify: `merge-tracker.mjs`

- [ ] **Step 1: Rewrite merge-tracker to query Mongo and render the markdown**

Read the current `merge-tracker.mjs` to understand its output format. Then replace its body with:

```js
#!/usr/bin/env node
/**
 * merge-tracker.mjs — render applications.md from the Mongo applications
 * collection. Replaces the old TSV-merge approach (TSV additions in
 * batch/tracker-additions/ were once merged into the .md; now those flow
 * through Mongo via add-application.mjs and upsertApplication).
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { listApplications, closeDb } from './lib/db.mjs';

const OUTPUT = 'data/applications.md';

async function main() {
  const apps = await listApplications({});
  const lines = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
  ];
  for (const a of apps) {
    const reportLink = a.report_id ? `[${a.num}](reports/${a.company?.toLowerCase().replace(/\s+/g, '-')}/${a.job_id}_report.md)` : '';
    const score = a.score !== null && a.score !== undefined ? `${a.score}/5` : '';
    const pdf = a.pdf_generated ? '✅' : '❌';
    lines.push(`| ${a.num} | ${a.date} | ${a.company} | ${a.role} | ${score} | ${a.status} | ${pdf} | ${reportLink} | ${a.notes || ''} |`);
  }
  writeFileSync(OUTPUT, lines.join('\n') + '\n');
  console.log(`Wrote ${apps.length} applications to ${OUTPUT}`);
  await closeDb();
}

main().catch(err => { console.error('merge-tracker failed:', err.message); process.exit(1); });
```

- [ ] **Step 2: Run it**

```bash
cd /Users/xiaoxuan/resume/career-ops && node merge-tracker.mjs
```
Expected: `Wrote N applications to data/applications.md`. The file contains the rendered table.

- [ ] **Step 3: Commit**

```bash
git add merge-tracker.mjs
git commit -m "refactor(merge-tracker): render applications.md from Mongo query"
```

---

### Task 5.3: Reports — write path + insertReport wiring (in batch mode / manual)

**Files:**
- Modify: `modes/oferta.md` (minor instruction update)
- Create: `lib/reports.mjs` — helper for writing a report with Mongo side effect

- [ ] **Step 1: Create `lib/reports.mjs`**

Create `lib/reports.mjs`:

```js
/**
 * lib/reports.mjs — helper for persisting evaluation reports.
 *
 * Writes the markdown body to reports/{company-slug}/{job_id}_report.md and
 * inserts a metadata doc into the reports collection. Returns the num
 * (sequential) assigned by the collection so callers can use it in
 * cross-refs (applications.report_id, tracker additions, etc.).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { getNextReportNum, insertReport } from './db.mjs';

export async function persistReport({ job_id, company, company_slug, url, score, block_scores, body, legitimacy = 'unverified' }) {
  const num = await getNextReportNum();
  const report_path = `reports/${company_slug}/${job_id}_report.md`;
  const fullPath = resolve(process.cwd(), report_path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body);
  const checksum_md = 'sha256:' + createHash('sha256').update(body).digest('hex');
  await insertReport({
    num, job_id, company_slug, report_path,
    generated_at: new Date(),
    score, verdict: 'evaluated',
    url, legitimacy, block_scores, checksum_md,
  });
  return { num, report_path, full_path: fullPath };
}
```

- [ ] **Step 2: Add a unit test**

Create `tests/reports.helper.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectWithClient, closeDb, _resetDbForTesting, ensureIndexes, findReportByJobId } from '../lib/db.mjs';
import { persistReport } from '../lib/reports.mjs';

let mongod, client, db, tmp, prevCwd;
before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('test');
  connectWithClient(client, 'test');
  await ensureIndexes();
  tmp = mkdtempSync(join(tmpdir(), 'reports-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
});
after(async () => {
  process.chdir(prevCwd);
  await closeDb();
  _resetDbForTesting();
  await client.close();
  await mongod.stop();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => { await db.collection('reports').deleteMany({}); });

test('persistReport: writes file + inserts mongo doc', async () => {
  const { num, report_path } = await persistReport({
    job_id: 'abc',
    company: 'Acme',
    company_slug: 'acme',
    url: 'https://...',
    score: 4.5,
    block_scores: { a: 4, b: 5 },
    body: '# Report body\n\ndetails.',
  });
  assert.equal(num, 1);
  assert.equal(report_path, 'reports/acme/abc_report.md');
  assert.ok(existsSync(report_path));
  assert.ok(readFileSync(report_path, 'utf-8').includes('Report body'));
  const mongoDoc = await findReportByJobId('abc');
  assert.equal(mongoDoc.num, 1);
  assert.equal(mongoDoc.score, 4.5);
});
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/reports.helper.test.mjs`
Expected: `# pass 1`

- [ ] **Step 4: Commit**

```bash
git add lib/reports.mjs tests/reports.helper.test.mjs
git commit -m "feat(reports): persistReport helper — file + mongo in one call"
```

---

## Phase 6 — Remove dual-writes

After 1-2 weeks of running with DUAL_WRITE_FILES=1 and confirming Mongo has the same data as the files, retire the file paths.

### Task 6.1: Delete TSV / apify-new JSON dual-write code

**Files:**
- Modify: `apify-scan.mjs`

- [ ] **Step 1: Remove DUAL_WRITE_FILES branches**

In `apify-scan.mjs`, delete:
- The `dualWrite` variable
- The `tsvSeen = await loadSeenJobs(...)` block
- The conditional `newRows.push(...)` block inside the fetch loop
- The `appendSeenJobs(...)` call
- The `writeFileSync(apifyNewPath, ...)` call

Remove the `loadSeenJobs` and `appendSeenJobs` imports (they're no longer used here — `lib/dedup.mjs` still exports them for any other consumer; delete from that file too if truly unused).

- [ ] **Step 2: Run tests**

Run: `cd /Users/xiaoxuan/resume/career-ops && node --test tests/apify-scan.test.mjs tests/apify-scan.mongo.test.mjs`
Expected: all pass.

- [ ] **Step 3: Delete `data/seen-jobs.tsv` and old `data/apify-new-*.json` files**

```bash
cd /Users/xiaoxuan/resume/career-ops
rm -f data/seen-jobs.tsv data/apify-new-*.json
```

- [ ] **Step 4: Commit**

```bash
git add apify-scan.mjs lib/dedup.mjs
git commit -m "refactor(apify-scan): remove DUAL_WRITE_FILES transition path"
```

---

### Task 6.2: Remove `cv.tailored.md` back-compat copy

**Files:**
- Modify: `assemble-cv.mjs`

- [ ] **Step 1: Delete the two lines that write cv.tailored.md + .cv-tailored-meta.json**

In `assemble-cv.mjs` main(), after the per-job CV write, delete:

```js
  writeFileSync(OUT_TAILORED, md);
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2));
```

Also delete the `OUT_TAILORED` and `OUT_META` constants near the top if they're no longer used.

- [ ] **Step 2: Update any modes that reference cv.tailored.md**

Grep for `cv.tailored.md` in `modes/*.md` and update each to point to the per-job path `cvs/{company}/{title}/{job_id}_cv.md` or to look up the latest via Mongo. Where modes used `cat cv.tailored.md`, replace with a Mongo-query + file-read pattern — or keep a final-renderer step in `assemble-cv.mjs` that symlinks the most recent CV to `cv.tailored.md` for humans.

- [ ] **Step 3: Delete old artifacts**

```bash
cd /Users/xiaoxuan/resume/career-ops
rm -f cv.tailored.md .cv-tailored-meta.json
```

- [ ] **Step 4: Commit**

```bash
git add assemble-cv.mjs modes/
git commit -m "refactor(cv): drop flat cv.tailored.md back-compat path"
```

---

## Self-review checklist (implementer runs this at the end)

1. **All tests pass:** `cd /Users/xiaoxuan/resume/career-ops && node --test` → green except pre-existing Go dashboard.
2. **Integration test passes:** `MONGO_INTEGRATION_TEST=1 node --test tests/db.integration.test.mjs` → `# pass 1`.
3. **Smoke-db succeeds:** `node smoke-db.mjs` → `{ok: true, cluster: ..., database: career-ops}`.
4. **Indexes exist:** Open Atlas UI, confirm each collection has the indexes from §5 of the spec.
5. **No placeholder code:** `grep -rn "TODO\|FIXME\|XXX" lib/db.mjs` — only expected references (if any).
6. **Live smoke of the full pipeline:** `node apify-scan.mjs --dry-run` → no errors; `node smoke-apify.mjs --metros=bay-area --rows=20` → jobs land in Mongo; `node digest-builder.mjs` → produces digest; `node merge-tracker.mjs` → renders applications.md from Mongo.

---

## Out of scope (do NOT implement in this plan)

- Automated migration from existing `seen-jobs.tsv` / `applications.md` / `reports/*`.
- Multi-user / shared-access features.
- Transactions — every write is single-collection single-document.
- Real-time dashboards / Change Streams.
- Backup automation (`mongodump` cron) — add in a follow-up if needed.
- Deprecation of `lib/dedup.mjs` — stays as the shared kebab-case / fingerprint utilities.
