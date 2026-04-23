# MongoDB Persistence Layer — Design

**Date:** 2026-04-23
**Status:** Design approved, ready for implementation plan
**Fork:** `marshmallow3781/career-ops`, branch `main` (HEAD includes `05e3bcf`)

---

## 1. Problem

Career-ops currently persists everything to local files:

- `data/seen-jobs.tsv` — Apify dedup state, grows monotonically
- `data/apify-new-*.json` — per-run Apify snapshots
- `data/digest.md` + `data/digest-history/` — daily ranked digest
- `data/applications.md` — manual application tracker
- `reports/*.md` — per-evaluation reports
- `cv.tailored.md` + `.cv-tailored-meta.json` — latest tailored CV (overwritten every run)

Three pain points:

1. **No structured query layer.** Want "show me all fullstack jobs I scored ≥8 in the last week"? You `grep` across six files.
2. **Lossy CV history.** `cv.tailored.md` is regenerated per JD and overwrites the previous one — no record of what you sent to company X.
3. **Dedup state is a single plain-text file.** Corruption risk (the current `lib/dedup.mjs` already has corruption-detection + backup logic, which is a bandaid on a fragile format).

## 2. Goal

Move structured data into MongoDB Atlas while keeping file-native artifacts (markdown reports + CV markdown/LaTeX) on disk, indexed by Mongo metadata. Preserve every job fetched and every CV generated. Enable ad-hoc queries across the entire history.

Success criteria:

- Every Apify fetch writes a `scan_runs` entry and upserts `jobs` documents.
- Every Haiku pre-filter score updates the relevant `jobs` doc with timestamped `stage_history`.
- Every CV generation creates a per-job file at `cvs/{company}/{title}/{job_id}_cv.{md,tex}` and a `cv_artifacts` doc linking to it.
- Every evaluation report creates a per-company file at `reports/{company}/{job_id}_report.md` and a `reports` doc.
- Dedup works via Mongo lookups, not TSV parsing.
- Pipeline fails fast (after 3-retry backoff) if Atlas is unreachable — no silent data loss.

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ MongoDB Atlas (M0 free tier, us-west-2)                        │
│                                                                │
│ Database: career-ops                                           │
│   ├── jobs           (canonical state per linkedin_id)         │
│   ├── scan_runs      (audit: one doc per Apify/portal fetch)   │
│   ├── applications   (manual application tracker)              │
│   ├── reports        (metadata; body on disk)                  │
│   └── cv_artifacts   (metadata; body on disk)                  │
└────────────────────────────────────────────────────────────────┘
                    ↑
                    │ (via lib/db.mjs — 3-retry backoff wrapper)
                    │
┌───────────────────┴────────────────────────────────────────────┐
│ Career-ops scripts (modified to use Mongo)                      │
│                                                                 │
│   apify-scan.mjs       → scan_runs INSERT + jobs UPSERT         │
│   digest-builder.mjs   → jobs READ + jobs UPDATE (scoring)      │
│   assemble-cv.mjs      → cv_artifacts INSERT + write file       │
│   validate-cv.mjs      → cv_artifacts UPDATE (validation)       │
│   (evaluate mode)      → reports INSERT + write file            │
│   (applications)       → applications INSERT/UPDATE             │
└─────────────────────────────────────────────────────────────────┘
                    │
                    ↓
        ┌───────────────────────────────┐
        │ Local filesystem              │
        │                               │
        │   cvs/{company-slug}/         │
        │     {title-slug}/             │
        │       {job_id}_cv.md          │
        │       {job_id}_cv.tex         │
        │       {job_id}_cv.pdf         │
        │                               │
        │   reports/{company-slug}/     │
        │     {job_id}_report.md        │
        └───────────────────────────────┘
```

Every collection document for a file-backed artifact (reports, CVs) stores:
- The relative path to the file.
- A SHA-256 `checksum_md` of the file content at write time — detects hand edits.

## 4. Scope

| Family | Storage | Mongo collection | Migration |
|---|---|---|---|
| A. Raw Apify fetches | Mongo | `scan_runs` | Not migrated — starts fresh |
| B. Seen-jobs dedup | Mongo | `jobs` | Not migrated — starts fresh |
| C. Digest | Mongo | Implicit via `jobs.stage = "digested"` | Not migrated |
| D. Applications | Mongo | `applications` | Not migrated — user re-enters in-flight |
| E. Evaluation reports | Files + Mongo | `reports` | Not migrated |
| F. CV artifacts | Files + Mongo | `cv_artifacts` | Not migrated |

Per user choice: start fresh. First week of autopilot will show some duplicate jobs as Mongo rebuilds its seen-set; acceptable one-time cost.

## 5. Collections

### 5.1 `jobs`

Canonical current state per LinkedIn job ID. Updated in place as pipeline stages complete.

```js
{
  _id:                  ObjectId,
  linkedin_id:          "4404321456",                 // UNIQUE
  url:                  "https://linkedin.com/jobs/view/...",

  // Identity + dedup
  title:                "Software Engineer II, Backend",
  title_normalized:     "software-engineer-ii-backend",
  company:              "Pinterest",
  company_slug:         "pinterest",
  company_title_key:    "pinterest|software-engineer-ii-backend",
  jd_fingerprint:       "sha256:...",
  location:             "San Francisco, CA",
  salary:               "$164K-$178K" | null,

  // JD content
  description:          "...",                        // up to 4000 chars
  posted_at_raw:        "2026-04-22",                 // from Apify publishedAt (date)
  posted_time_relative: "6 hours ago",                // from Apify postedTime
  source_metro:         "bay-area",

  // Pipeline state
  stage:                "raw" | "blacklisted" | "title_cut" | "scored" | "digested" | "applied" | "rejected" | "discarded",
  stage_history: [
    { stage: "raw",      at: ISODate, source: "apify-linkedin-bay-area" },
    { stage: "scored",   at: ISODate, archetype: "backend", score: 8 },
    { stage: "digested", at: ISODate, bucket: "strong" },
  ],

  // Scoring (latest)
  prefilter_archetype:  "backend" | "fullstack" | "applied_ai" | ...,
  prefilter_score:      8,
  prefilter_reason:     "Deep Go/Kafka experience...",
  prefilter_source:     "llm" | "llm-retry" | "deterministic-fallback",
  prefilter_at:         ISODate,

  // Cross-refs (null when not yet linked)
  first_scan_run_id:    ObjectId,
  last_scan_run_id:     ObjectId,
  application_id:       ObjectId | null,
  cv_artifact_ids:      [ObjectId, ...],
  report_id:            ObjectId | null,

  // Timestamps
  first_seen_at:        ISODate,
  last_seen_at:         ISODate,
  updated_at:           ISODate,
}
```

**Indexes:**
- `{ linkedin_id: 1 }` — unique
- `{ jd_fingerprint: 1 }` — cross-source dedup lookup
- `{ company_title_key: 1 }` — fallback dedup
- `{ stage: 1, prefilter_score: -1 }` — digest rankings
- `{ source_metro: 1, first_seen_at: -1 }` — per-metro timeline

**Write pattern:** upsert by `linkedin_id`. Each pipeline stage appends a `stage_history` entry via `$push` and updates `stage` + relevant fields.

### 5.2 `scan_runs`

Immutable record of each Apify/portal fetch operation.

```js
{
  _id:              ObjectId,
  run_started_at:   ISODate,
  run_finished_at:  ISODate,
  source:           "apify-linkedin" | "greenhouse" | "ashby" | "lever",
  metro:            "bay-area" | "seattle" | null,
  apify_actor_id:   "BHzefUZlZRKWxkTck" | null,
  apify_run_id:     "..." | null,
  input_params:     { title, location, geoId, publishedAt, rows, workType, ... },
  fetched_count:    192,
  new_count:        42,
  blacklisted_count: 3,
  errors:           [],
}
```

**Indexes:**
- `{ run_started_at: -1 }` — recent-first listing
- `{ source: 1, metro: 1, run_started_at: -1 }` — per-source history

**Write pattern:** insert-only. Never updated after write.

### 5.3 `applications`

One document per applied job. Existing `data/applications.md` canonical state lifts into structured form.

```js
{
  _id:              ObjectId,
  job_id:           "4404321456",                     // → jobs.linkedin_id
  num:              42,                               // sequential, matches report num
  date:             "2026-04-23",                     // application date
  company:          "Pinterest",
  role:             "Software Engineer II, Backend",
  status:           "Evaluated" | "Applied" | "Responded" | "Interview" | "Offer" | "Rejected" | "Discarded" | "SKIP",
  score:            4.5,                              // A-F aggregate from report
  url:              "https://linkedin.com/...",
  pdf_generated:    true,
  report_id:        ObjectId | null,                  // → reports._id
  cv_artifact_ids:  [ObjectId, ...],                  // → cv_artifacts._id[]
  notes:            "One-line note",
  history: [                                          // status transitions
    { status: "Evaluated", at: ISODate, note: "..." },
    { status: "Applied",   at: ISODate, note: "..." },
  ],
  created_at:       ISODate,
  updated_at:       ISODate,
}
```

**Indexes:**
- `{ num: 1 }` — unique
- `{ job_id: 1 }` — lookup by linkedin_id
- `{ company: 1, role: 1 }` — fallback uniqueness (matches current "NEVER create new entries if company+role exists" rule)
- `{ status: 1, date: -1 }` — filter by status

**Write pattern:** insert for new applications; updates for status transitions (append to `history`, update `status`).

### 5.4 `reports`

Metadata for per-evaluation markdown reports. Body lives on disk at `reports/{company-slug}/{job_id}_report.md`.

```js
{
  _id:            ObjectId,
  job_id:         "4404321456",                       // → jobs.linkedin_id
  num:            17,                                 // sequential (existing convention)
  company_slug:   "pinterest",
  report_path:    "reports/pinterest/4404321456_report.md",
  generated_at:   ISODate,
  score:          4.5,
  verdict:        "evaluated" | "applied" | "discarded" | "rejected" | ...,
  url:            "https://linkedin.com/...",
  legitimacy:     "verified" | "unverified" | "expired",
  block_scores:   { a: 4.5, b: 4.0, c: 5.0, d: 4.5, e: 4.0, f: 4.5, g: 4.0 },
  checksum_md:    "sha256:...",
}
```

**Indexes:**
- `{ num: 1 }` — unique
- `{ job_id: 1 }` — unique
- `{ score: -1 }` — top-scored listing

**Write pattern:** insert on report generation. Update on verdict change.

### 5.5 `cv_artifacts`

Metadata for per-JD tailored CVs. Bodies live on disk at `cvs/{company-slug}/{title-slug}/{job_id}_cv.{md,tex,pdf}`.

```js
{
  _id:                  ObjectId,
  job_id:               "4404321456",                 // → jobs.linkedin_id
  company_slug:         "pinterest",
  title_slug:           "software-engineer-ii-backend",
  generated_at:         ISODate,
  cv_md_path:           "cvs/pinterest/software-engineer-ii-backend/4404321456_cv.md",
  cv_tex_path:          "cvs/pinterest/software-engineer-ii-backend/4404321456_cv.tex" | null,
  cv_pdf_path:          "cvs/pinterest/software-engineer-ii-backend/4404321456_cv.pdf" | null,
  jd_fingerprint:       "sha256:...",
  profile_version_hash: "sha256:...",
  archetype:            "ml_platform",
  intent_source:        "llm" | "llm-retry" | "deterministic-fallback",
  validation_status:    "ok" | "fabricated_bullet" | "coverage_failure" | null,
  validation_errors:    [] | [{ type, bullet }, ...],
  checksum_md:          "sha256:...",
}
```

**Indexes:**
- `{ job_id: 1 }` — unique
- `{ company_slug: 1, generated_at: -1 }`

**Write pattern:** upsert by `job_id`. Regenerating a CV replaces the file AND the doc.

## 6. Hosting

**MongoDB Atlas free tier (M0 Sandbox)**, user's personal account.

- Cluster provider/region: user choice, AWS `us-west-2` recommended (closest to Bay Area).
- Database user: least-privilege role sufficient (`readWrite` on `career-ops` db only).
- Network access: `0.0.0.0/0` (password-protected; simplest for a personal project with a dynamic IP).

**Credentials via `.env`:**

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority&appName=...
MONGODB_DATABASE=career-ops
```

## 7. Driver + code organization

**Driver:** raw `mongodb` npm package (no Mongoose). Field-level validation at each write site.

**Client options (matches Atlas's recommended starter):**
- `serverApi.version = ServerApiVersion.v1` — stable API contract.
- `serverApi.strict = true` — reject commands not in Stable API (catches legacy usage early).
- `serverApi.deprecationErrors = true` — surface deprecations as errors, not warnings.

**New module:** `lib/db.mjs` (~300 lines).

```js
// lib/db.mjs
import { MongoClient, ServerApiVersion } from 'mongodb';

let clientPromise = null;

async function getClient() { /* singleton with 3-retry backoff */ }
async function getDb() { /* returns db handle */ }
export async function closeDb() { /* for test teardown */ }

// ── jobs ──
export async function upsertJob(doc) { /* upsert by linkedin_id */ }
export async function updateJobStage(linkedinId, stage, patch) { /* $push history, $set fields */ }
export async function findJobByLinkedinId(id) { ... }
export async function findJobsBySeenSet(linkedinIds) { /* bulk fetch for dedup */ }
export async function findDigestCandidates(filter) { /* ranked list */ }

// ── scan_runs ──
export async function insertScanRun(doc) { ... }

// ── applications ──
export async function upsertApplication(doc) { ... }
export async function updateApplicationStatus(num, status, note) { ... }
export async function listApplications(filter) { ... }

// ── reports ──
export async function insertReport(doc) { ... }
export async function updateReportVerdict(num, verdict) { ... }

// ── cv_artifacts ──
export async function upsertCvArtifact(doc) { ... }
export async function updateCvValidation(jobId, status, errors) { ... }

// ── bootstrap ──
export async function ensureIndexes() { /* idempotent CREATE INDEX */ }
```

**Retry wrapper** wraps every database call:

```js
async function withRetry(fn) {
  const delays = [1000, 5000, 30000];
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === delays.length) throw err;            // final attempt → fail fast
      if (!isRetryable(err)) throw err;              // non-network errors → fail fast
      console.error(`[db] transient error (attempt ${i+1}): ${err.message}; retrying in ${delays[i]}ms`);
      await sleep(delays[i]);
    }
  }
}
```

Retryable errors: `MongoNetworkError`, timeouts, connection resets. Non-retryable: duplicate-key violations, invalid-input errors — those fail fast.

## 8. Consumer changes

**Additive — no breaking changes until flip-over.** Each consumer reads/writes Mongo for the new structured path and keeps existing file I/O during a transition window (removable in a follow-up commit once confidence is built).

### 8.1 `apify-scan.mjs`

- Insert `scan_runs` doc at start (with `run_started_at`, `input_params`).
- For each fetched job: `upsertJob()` with `stage: "raw"` on first sight, or update `last_seen_at` + `last_scan_run_id` on subsequent sightings.
- Blacklisted jobs get `stage: "blacklisted"` + `stage_history` entry; still written to Mongo (so we can audit which companies got cut).
- Seen-set lookup: query `{ linkedin_id: { $in: [...] } }` instead of loading `seen-jobs.tsv`.
- `seen-jobs.tsv` writes: keep for one release cycle behind a `DUAL_WRITE_FILES=1` env flag; remove in follow-up.

### 8.2 `digest-builder.mjs`

- Stop reading `data/apify-new-*.json` and `seen-jobs.tsv`. Instead: `findDigestCandidates({ stage: "raw" or "scored", first_seen_at: { $gte: today - 24h } })`.
- After title filter: `updateJobStage(id, "title_cut")` for drops, leave others at `stage: "raw"`.
- After Haiku scoring: `updateJobStage(id, "scored", { prefilter_archetype, prefilter_score, prefilter_reason, prefilter_source, prefilter_at })`.
- After bucketing: `updateJobStage(id, "digested", { bucket })` for survivors.
- `data/digest.md` continues to be generated as today's human-readable summary — driven from Mongo query, not from the in-memory `candidateJobs` list.

### 8.3 `assemble-cv.mjs`

- Derive `job_id` and `company_slug`/`title_slug` from the JD file (`jds/{slug}.md` — but this is a user-provided JD, not necessarily mapped to a linkedin_id; see §10 Open Questions).
- Write CV to `cvs/{company-slug}/{title-slug}/{job_id}_cv.md` instead of `cv.tailored.md`.
- `upsertCvArtifact()` with paths, fingerprint, source, archetype.
- For back-compat, also copy the generated CV to `cv.tailored.md` (flat latest) during transition — so downstream modes that still read `cv.tailored.md` keep working until they're migrated.

### 8.4 `validate-cv.mjs`

- After validation: `updateCvValidation(jobId, status, errors)` with the result.
- Reads CV from the per-job path (or from `cv.tailored.md` during transition).

### 8.5 Reports (mode logic)

- Modes like `oferta.md` / `batch` currently write `reports/{num}-{slug}-{date}.md`. Switch to `reports/{company-slug}/{job_id}_report.md` and `insertReport()`.
- `data/applications.md` TSV-style additions via `batch/tracker-additions/*.tsv` → migrate to `upsertApplication()` + `updateApplicationStatus()`. `merge-tracker.mjs` either disappears or becomes a Mongo-query-and-render for `applications.md`.

## 9. Migration (start fresh)

No data migration from existing files. On first run:

1. `lib/db.mjs` connects + calls `ensureIndexes()` (idempotent — safe to call every run).
2. First apify-scan populates `scan_runs` and `jobs` fresh.
3. User re-enters any in-flight applications manually via a small CLI:
   ```bash
   node add-application.mjs --company=Rippling --role="SWE II Backend" --url=... --status=Applied
   ```
   (or directly in the Mongo shell / Atlas UI).

One-time cost: first ~week, dedup shows some already-seen LinkedIn jobs.

## 10. Error handling

- All DB calls wrapped in `withRetry()` (§7). Transient network errors retried 3× with 1s / 5s / 30s backoff. Permanent errors (bad queries, duplicate keys) fail fast.
- On connect failure: the script exits non-zero with a clear message. Launchd-scheduled runs will retry on the next scheduled tick automatically.
- No local fallback buffer. If Atlas is unreachable long enough to skip multiple scheduled runs, the user sees empty results and investigates.

## 11. Testing

- **Unit tests (`tests/db.*.test.mjs`):** mock the `MongoClient` with an in-memory `mongodb-memory-server` instance. Test every CRUD function for correct query shape, upsert behavior, index usage.
- **Integration tests:** flag-gated by `MONGO_INTEGRATION_TEST=1` — uses a real connection (Atlas staging cluster OR localhost if available) to verify end-to-end writes. Skipped in default `node --test` runs.
- **Smoke test:** modified `smoke-apify.mjs` writes to Mongo (replacing JSON file persistence) and reads back to verify round-trip.

## 12. Operational

- **Backup:** Atlas free-tier M0 doesn't include automated backup. Weekly `mongodump` via a cron job → `data/backups/{YYYY-MM-DD}.archive.gz`. Tiny (MB-scale).
- **Monitoring:** Atlas UI shows connection count + operation rate. No custom alerts needed.
- **Schema evolution:** since we're using the raw driver (no Mongoose), schema is enforced by code at write sites. When a field is added, old docs simply lack it; reads handle `undefined` gracefully.

## 13. Out of scope

- Automated migration from existing files.
- Multi-user access (database user is the single CLI).
- Multi-machine sync (Atlas handles this trivially if user spins up career-ops on a second machine; nothing special needed).
- Real-time dashboards on top of Mongo.
- Transactions. Every write operation in this design is single-collection, single-document — no cross-collection atomic semantics needed.
- Changes to CV generation logic (`assemble-core.mjs`, `assemble-llm.mjs`) beyond routing output to per-job paths.
- Changes to validators (`validate-cv.mjs`, `validate-core.mjs`) beyond reading from per-job paths.

## 14. Open questions

Resolved during brainstorm, but flag for plan-writer:

1. **Job ID for assembled CVs:** `assemble-cv.mjs` takes `--jd=jds/{slug}.md` today. The slug isn't a linkedin_id. Plan must specify how we derive or require a `--job-id=...` arg, OR match the JD against `jobs` collection by fingerprint.
2. **`merge-tracker.mjs`:** existing script merges TSVs into `applications.md`. Once applications live in Mongo, this script either (a) disappears entirely (Mongo query replaces it), or (b) becomes a render-only step (query Mongo → write `applications.md` for human readability). Plan should choose.
3. **`data/digest.md`:** existing file is regenerated every run. Continue generating it (useful morning summary), drive from Mongo query, same output format. No deprecation.

## 15. Rollout

1. Phase 1: `lib/db.mjs` + indexes + smoke test. No consumer changes yet.
2. Phase 2: `apify-scan.mjs` dual-writes (Mongo + TSV). Confirm Mongo has correct data for a week.
3. Phase 3: `digest-builder.mjs` reads Mongo, writes Mongo. TSV reads can drop.
4. Phase 4: `assemble-cv.mjs` + `validate-cv.mjs` migrate to per-job CV paths.
5. Phase 5: Reports + applications collections wired up. `merge-tracker.mjs` becomes render-only.
6. Phase 6: Remove TSV dual-writes. `seen-jobs.tsv` + `.cv-tailored-meta.json` deleted. `cv.tailored.md` back-compat copy removed.
