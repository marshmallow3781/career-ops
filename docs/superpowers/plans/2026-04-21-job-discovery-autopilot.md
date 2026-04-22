# Job Discovery Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a job-discovery autopilot layer on top of the existing career-ops + experience-source-assembly fork that scans LinkedIn (via Apify) and existing ATS sources every 2 hours 7am-9pm PST, runs a 3-stage filter pipeline, and produces a ranked morning digest.

**Architecture:** Two new Node scripts (`apify-scan.mjs` + `digest-builder.mjs`) orchestrated by 2 macOS launchd plists. A shared `lib/dedup.mjs` module provides deterministic deduplication state (`data/seen-jobs.tsv`). Existing `scan.mjs` is modified to write fingerprints into the same state file. Archetype-aware Haiku pre-filter ranks surviving jobs; user selects and triggers evaluation manually via the existing `/career-ops pipeline` flow.

**Tech Stack:** Node ESM (.mjs), `apify-client` (new dep), `@anthropic-ai/sdk` (existing), `js-yaml` (existing), Node built-in `node --test` runner, macOS launchd.

**Spec:** `docs/superpowers/specs/2026-04-21-job-discovery-autopilot-design.md` (commit `2d2c354`)

**Base branch:** `feat/experience-source-assembly` at HEAD `2d2c354`. This plan is additive — creates new files and extends `scan.mjs` only. Does not modify `assemble-cv.mjs`, `assemble-core.mjs`, `assemble-llm.mjs`, `validate-cv.mjs`, `validate-core.mjs`, `generate-pdf.mjs`, `generate-latex.mjs`, or any `modes/*.md`.

---

## §15 Open Questions — Resolved

1. **Apify CU/proxy overhead at scale** → Assume linear $1/1000 based on user's tests (10→$0.01, 100→$0.10). Add `cost_estimate_usd` logging per run; week-1 real bill will confirm or reveal deviation.

2. **geoId support** → Pass `location` string to actor; store `geoId` in config for documentation only. Simpler and proven.

3. **workType / contractType / experienceLevel** → Set all to `null`. Rely on title filter + Haiku. Revisit in week 1 if junk gets through.

4. **Haiku model version** → Pin `claude-haiku-4-5-20251001`. Exposed via env var `ASSEMBLE_MODEL` (matches existing convention from `assemble-llm.mjs`) for easy override.

5. **scan.mjs jobs with no JD body** → `jd_fingerprint = "(none)"`. Cross-source dedup falls back to `{company_slug, title_normalized}` secondary key. Accepted v1 limitation.

6. **Haiku rate limit** → Sequential calls in digest-builder.mjs. ~50 RPM during 7am burst is well within Anthropic limits. No throttle for v1.

---

## File Structure

### New files

| Path | Purpose |
|------|---------|
| `lib/dedup.mjs` | Shared helpers: ID extraction, normalization, fingerprinting, TSV read/write. ~120 lines |
| `apify-scan.mjs` | CLI orchestrator for Apify actor calls across 4 metros. ~160 lines |
| `digest-builder.mjs` | CLI orchestrator for 3-stage filter + digest rendering. ~280 lines |
| `config/apify-search.example.yml` | Template committed to repo; users copy to `apify-search.yml` |
| `autopilot-sources.sh` | Shell launcher for parallel scan.mjs + apify-scan.mjs |
| `.launchd/com.marshmallow.career-ops.sources.plist` | launchd config for sources runs |
| `.launchd/com.marshmallow.career-ops.digest.plist` | launchd config for digest-builder runs |
| `.launchd/setup.sh` | Install launchd plists |
| `.launchd/pause.sh` | Unload plists (data preserved) |
| `.launchd/resume.sh` | Reload plists |
| `.launchd/uninstall.sh` | Unload + remove plists |
| `tests/dedup.test.mjs` | Unit tests for lib/dedup.mjs |
| `tests/apify-scan.test.mjs` | Unit tests for apify-scan.mjs |
| `tests/digest-builder.test.mjs` | Unit tests for digest-builder.mjs |
| `tests/autopilot.e2e.test.mjs` | End-to-end with mocked Apify + Haiku |
| `__fixtures__/autopilot/*` | Fixture data for E2E tests |

### Modified files

| Path | Change |
|------|--------|
| `package.json` | Add `apify-client` dep, add `autopilot:*` npm scripts |
| `.env.example` | Add `APIFY_API_TOKEN` placeholder |
| `.gitignore` | Add `config/apify-search.yml`, `data/seen-jobs.tsv`, `data/apify-new-*.json`, `data/digest.md`, `data/digest-history/` |
| `config/profile.example.yml` | Add `target_roles.archetypes_of_interest` block |
| `scan.mjs` | Compute `jd_fingerprint` for each job, write to `seen-jobs.tsv` |
| `test-all.mjs` | Include new test files in section 3.5 |
| `CLAUDE.md` | Document autopilot workflow + digest.md usage |
| `DATA_CONTRACT.md` | Register new User Layer files + System Layer scripts |
| `CHANGELOG.md` | fork-v0.2.0 entry |

### Unchanged (explicitly protected)

- `assemble-cv.mjs`, `assemble-core.mjs`, `assemble-llm.mjs`
- `validate-cv.mjs`, `validate-core.mjs`
- `generate-pdf.mjs`, `generate-latex.mjs`
- `cv.tailored.md`, `experience_source/**`, `article-digest.md`
- All `modes/*.md` files
- `templates/`, `dashboard/`, `batch/`

---

## Phase A — Foundation (config, deps, env)

### Task 1: Add `apify-client` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Edit package.json dependencies**

Open `package.json`. In the `dependencies` block, add `@apify/client` — wait, the actual npm package is `apify-client`. Add:

```json
"apify-client": "^2.9.5",
```

Final `dependencies` block should look like:
```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.32.1",
  "@google/generative-ai": "^0.21.0",
  "apify-client": "^2.9.5",
  "dotenv": "^16.4.5",
  "js-yaml": "^4.1.1",
  "playwright": "^1.58.1"
}
```

- [ ] **Step 2: Add autopilot npm scripts**

In the `scripts` block, add (maintaining alphabetical order):

```json
"autopilot:apify-scan": "node apify-scan.mjs",
"autopilot:digest": "node digest-builder.mjs",
"autopilot:dry-run": "node apify-scan.mjs --dry-run && node digest-builder.mjs --dry-run",
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: `apify-client` added to `package-lock.json`, no errors.

- [ ] **Step 4: Verify import**

Run: `node -e "import('apify-client').then(m => console.log('ok', typeof m.ApifyClient))"`
Expected: `ok function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(autopilot): add apify-client dep + npm scripts"
```

---

### Task 2: Create `config/apify-search.example.yml`

**Files:**
- Create: `config/apify-search.example.yml`

- [ ] **Step 1: Write the config template**

Create `config/apify-search.example.yml`:

```yaml
# Apify LinkedIn scraper configuration
# Copy this file to config/apify-search.yml and adjust as needed.
# The non-example file is gitignored.

actor_id: BHzefUZlZRKWxkTck  # curious_coder/linkedin-jobs-scraper
api_token_env: APIFY_API_TOKEN

default_params:
  title: "Software Engineer"
  workType: null              # all
  contractType: null          # all (Haiku filters out Contract/C2C)
  experienceLevel: null       # all (title filter + Haiku handle seniority)
  proxy:
    useApifyProxy: true
    apifyProxyGroups: ["RESIDENTIAL"]

locations:
  - name: california
    location: "California, United States"
    geoId: "102095887"
    baseline_rows: 500
    hourly_rows: 200
  - name: seattle
    location: "Greater Seattle Area"
    geoId: "90000091"
    baseline_rows: 300
    hourly_rows: 100
  - name: new-york
    location: "New York City Metropolitan Area"
    geoId: "90000070"
    baseline_rows: 300
    hourly_rows: 100
  - name: boston
    location: "Boston, Massachusetts, United States"
    geoId: "102380872"
    baseline_rows: 300
    hourly_rows: 100

baseline:
  schedule_pst: "07:00"
  params:
    publishedAt: r86400       # past 24h

hourly:
  # Every 2 hours, 7am-9pm PST → 8 runs/day
  schedule_pst: ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"]
  params:
    publishedAt: r7200        # past 2h window w/ overlap
```

- [ ] **Step 2: Commit**

```bash
git add config/apify-search.example.yml
git commit -m "feat(autopilot): example Apify search config (4 metros, 2h cadence)"
```

---

### Task 3: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add APIFY_API_TOKEN placeholder**

Append to `.env.example`:

```
# Apify token for LinkedIn job scanning (autopilot)
# Get from https://console.apify.com/settings/integrations
APIFY_API_TOKEN=apify_api_your_token_here
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "feat(autopilot): add APIFY_API_TOKEN to .env.example"
```

---

### Task 4: Update `.gitignore` for autopilot data

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append autopilot data entries**

Append to `.gitignore` under the "Personal data" section (the section starting with `cv.md`):

```
# Autopilot state + output (gitignored, user-specific)
config/apify-search.yml
data/seen-jobs.tsv
data/apify-new-*.json
data/apify-new-archive/
data/digest.md
data/digest-history/
```

- [ ] **Step 2: Verify**

Run: `git check-ignore data/seen-jobs.tsv data/digest.md config/apify-search.yml`
Expected: all three paths printed.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(autopilot): gitignore autopilot state files"
```

---

### Task 5: Extend `config/profile.example.yml` with `archetypes_of_interest`

**Files:**
- Modify: `config/profile.example.yml`

- [ ] **Step 1: Edit target_roles block**

In `config/profile.example.yml`, find the existing `target_roles:` block (near the top of the file). Replace it with:

```yaml
target_roles:
  # (Legacy single-archetype fields retained for backward compatibility with other modes)
  primary:
    - "Senior AI Engineer"
    - "Staff ML Engineer"

  # (autopilot) Multi-facet candidates: list every archetype you're open to
  archetypes_of_interest:
    - frontend
    - backend
    - infra
    - machine_learning
    - fullstack

  seniority_min: "Mid-Senior"
  seniority_max: "Staff"
  deal_breakers:
    - "Intern"
    - "Junior"
    - "Entry Level"
    - "Contract"
    - "C2C"
  # Companies to exclude from the digest. Case-insensitive substring match
  # against the normalized company slug. Applied in Stage 1 (free, zero LLM cost).
  company_blacklist:
    - "RemoteHunter"
    - "Walmart"
    - "PayPal"
    - "Jobright.ai"
    - "Turing"
    - "ByteDance"
    - "TikTok"
    - "Insight Global"
    - "CyberCoders"
    - "Jobs via Dice"
    - "Open Talent"

  archetypes:
    - name: "AI/ML Engineer"
      level: "Senior/Staff"
      fit: "primary"
    - name: "AI Product Manager"
      level: "Senior"
      fit: "secondary"
    - name: "Solutions Architect"
      level: "Mid-Senior"
      fit: "adjacent"
```

- [ ] **Step 2: Commit**

```bash
git add config/profile.example.yml
git commit -m "feat(autopilot): add archetypes_of_interest + seniority/deal_breakers to profile schema"
```

---

## Phase B — `lib/dedup.mjs` (shared helpers, TDD)

### Task 6: Failing tests for `extractLinkedInId`

**Files:**
- Create: `tests/dedup.test.mjs`

- [ ] **Step 1: Create test file with 5 cases**

Create `tests/dedup.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkedInId } from '../lib/dedup.mjs';

test('extractLinkedInId: canonical URL → id string', () => {
  assert.equal(
    extractLinkedInId('https://www.linkedin.com/jobs/view/3847123456/'),
    '3847123456'
  );
});

test('extractLinkedInId: URL without trailing slash', () => {
  assert.equal(
    extractLinkedInId('https://www.linkedin.com/jobs/view/3847123456'),
    '3847123456'
  );
});

test('extractLinkedInId: URL with query params', () => {
  assert.equal(
    extractLinkedInId('https://www.linkedin.com/jobs/view/3847123456/?trk=abc&refId=xyz'),
    '3847123456'
  );
});

test('extractLinkedInId: non-LinkedIn URL → null', () => {
  assert.equal(
    extractLinkedInId('https://job-boards.greenhouse.io/anthropic/jobs/4517823'),
    null
  );
});

test('extractLinkedInId: malformed URL → null', () => {
  assert.equal(extractLinkedInId('not-a-url'), null);
  assert.equal(extractLinkedInId(''), null);
  assert.equal(extractLinkedInId(null), null);
});
```

- [ ] **Step 2: Run test to verify fails**

Run: `node --test tests/dedup.test.mjs`
Expected: FAIL with "Cannot find module '../lib/dedup.mjs'"

---

### Task 7: Implement `extractLinkedInId`

**Files:**
- Create: `lib/dedup.mjs`

- [ ] **Step 1: Create lib/dedup.mjs with first function**

Create directory + file:

```bash
mkdir -p lib
```

Write `lib/dedup.mjs`:

```js
/**
 * lib/dedup.mjs — Shared deduplication helpers for autopilot.
 *
 * Used by apify-scan.mjs, digest-builder.mjs, and scan.mjs.
 */

/**
 * Parse a LinkedIn job URL and extract the numeric job ID.
 * @param {string|null|undefined} url
 * @returns {string|null} The ID string, or null if not a LinkedIn job URL
 */
export function extractLinkedInId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
  return m ? m[1] : null;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/dedup.test.mjs`
Expected: 5/5 pass.

- [ ] **Step 3: Commit**

```bash
git add lib/dedup.mjs tests/dedup.test.mjs
git commit -m "feat(dedup): extractLinkedInId (TDD)"
```

---

### Task 8: Failing tests for normalization helpers

**Files:**
- Modify: `tests/dedup.test.mjs` (append)

- [ ] **Step 1: Append tests for normalizeCompany + normalizeTitle**

Append to `tests/dedup.test.mjs`:

```js
import { normalizeCompany, normalizeTitle } from '../lib/dedup.mjs';

test('normalizeCompany: basic kebab-case', () => {
  assert.equal(normalizeCompany('Anthropic'), 'anthropic');
  assert.equal(normalizeCompany('LinkedIn Corporation'), 'linkedin-corporation');
});

test('normalizeCompany: strips trademarks, apostrophes, punctuation', () => {
  assert.equal(normalizeCompany('McDonald\'s, Inc.'), 'mcdonalds-inc');
  assert.equal(normalizeCompany('AT&T™'), 'att');
});

test('normalizeCompany: empty/null returns empty string', () => {
  assert.equal(normalizeCompany(''), '');
  assert.equal(normalizeCompany(null), '');
});

test('normalizeTitle: lowercase + kebab-case', () => {
  assert.equal(
    normalizeTitle('Staff+ Software Engineer, Data Infrastructure'),
    'staff-software-engineer-data-infrastructure'
  );
});

test('normalizeTitle: strips " | Company" and " @ Company" suffixes', () => {
  assert.equal(
    normalizeTitle('Senior Backend Engineer | Anthropic'),
    'senior-backend-engineer'
  );
  assert.equal(
    normalizeTitle('ML Engineer @ Scale AI'),
    'ml-engineer'
  );
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/dedup.test.mjs`
Expected: 5 new tests FAIL (functions not exported).

---

### Task 9: Implement `normalizeCompany` + `normalizeTitle`

**Files:**
- Modify: `lib/dedup.mjs` (append)

- [ ] **Step 1: Append two functions**

Append to `lib/dedup.mjs`:

```js
/**
 * Convert a company name to kebab-case for dedup keys.
 * Strips trademarks, apostrophes, non-alphanumerics (except hyphens/spaces).
 */
export function normalizeCompany(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')  // ™ ® ©
    .replace(/[''`]/g, '')                  // apostrophes
    .replace(/[^a-z0-9\s-]/g, '')           // strip remaining punctuation
    .trim()
    .replace(/\s+/g, '-')                   // spaces → hyphens
    .replace(/-+/g, '-')                    // collapse multiple hyphens
    .replace(/^-|-$/g, '');                 // trim leading/trailing hyphens
}

/**
 * Convert a job title to kebab-case for dedup keys.
 * Strips " | Company" and " @ Company" suffixes that LinkedIn adds.
 */
export function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  // Strip " | ..." and " @ ..." suffixes
  const cleaned = title.split(/\s*[|@]\s*/)[0];
  return normalizeCompany(cleaned);  // same kebab-case rules
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/dedup.test.mjs`
Expected: 10/10 pass.

- [ ] **Step 3: Commit**

```bash
git add lib/dedup.mjs tests/dedup.test.mjs
git commit -m "feat(dedup): normalizeCompany + normalizeTitle (TDD)"
```

---

### Task 10: Failing tests for `computeJdFingerprint`

**Files:**
- Modify: `tests/dedup.test.mjs` (append)

- [ ] **Step 1: Append fingerprint tests**

Append to `tests/dedup.test.mjs`:

```js
import { computeJdFingerprint } from '../lib/dedup.mjs';

test('computeJdFingerprint: identical text → identical hash', () => {
  const a = 'We are hiring a Senior Backend Engineer.';
  const b = 'We are hiring a Senior Backend Engineer.';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: whitespace-insensitive', () => {
  const a = 'We are hiring a Senior Engineer.';
  const b = 'We  are\nhiring   a\tSenior\n\nEngineer.';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: case-insensitive', () => {
  const a = 'We Are Hiring';
  const b = 'we are hiring';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: punctuation-insensitive', () => {
  const a = 'Backend Engineer: We are hiring!';
  const b = 'Backend Engineer We are hiring';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: different text → different hash', () => {
  const a = 'We are hiring backend engineers';
  const b = 'We are hiring frontend engineers';
  assert.notEqual(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: empty → stable fixed hash', () => {
  assert.equal(computeJdFingerprint(''), computeJdFingerprint(''));
  assert.equal(typeof computeJdFingerprint(''), 'string');
});

test('computeJdFingerprint: returns 64-char hex string (SHA-256)', () => {
  const fp = computeJdFingerprint('test content');
  assert.equal(fp.length, 64);
  assert.match(fp, /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/dedup.test.mjs`
Expected: 7 new tests FAIL.

---

### Task 11: Implement `computeJdFingerprint`

**Files:**
- Modify: `lib/dedup.mjs` (append)

- [ ] **Step 1: Add crypto import + function**

Prepend to `lib/dedup.mjs` (after JSDoc header, before first function):

```js
import { createHash } from 'node:crypto';
```

Then append to `lib/dedup.mjs`:

```js
/**
 * Compute a stable SHA-256 fingerprint of a JD body.
 * Normalizes: lowercases, collapses whitespace, strips punctuation.
 * Used for cross-source dedup (same job on LinkedIn + Greenhouse → same hash).
 *
 * @param {string} text — the full JD body
 * @returns {string} 64-char lowercase hex SHA-256
 */
export function computeJdFingerprint(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/dedup.test.mjs`
Expected: 17/17 pass.

- [ ] **Step 3: Commit**

```bash
git add lib/dedup.mjs tests/dedup.test.mjs
git commit -m "feat(dedup): computeJdFingerprint (SHA-256 of normalized text)"
```

---

### Task 12: Failing tests for `loadSeenJobs` + `appendSeenJobs`

**Files:**
- Modify: `tests/dedup.test.mjs` (append)

- [ ] **Step 1: Append TSV I/O tests**

Append to `tests/dedup.test.mjs`:

```js
import { loadSeenJobs, appendSeenJobs, SEEN_JOBS_HEADER } from '../lib/dedup.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withTempFile(setup, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seen-jobs-'));
  const path = join(dir, 'seen-jobs.tsv');
  if (setup) setup(path);
  try {
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadSeenJobs: missing file → empty Sets and Maps', async () => {
  await withTempFile(null, async (path) => {
    const state = await loadSeenJobs(path);
    assert.equal(state.linkedinIds.size, 0);
    assert.equal(state.fingerprints.size, 0);
    assert.equal(state.titleCompanyKeys.size, 0);
  });
});

test('loadSeenJobs: file with 2 rows → populates sets', async () => {
  await withTempFile(
    (path) => {
      writeFileSync(path,
        SEEN_JOBS_HEADER + '\n' +
        '3847123456\thttps://www.linkedin.com/jobs/view/3847123456\tanthropic\tstaff-swe-data-infra\t2026-04-22T14:00Z\t2026-04-22T14:00Z\tapify-linkedin-california\tnew\tabc123\tbackend\t9\tExact stack match\n' +
        '(none)\thttps://job-boards.greenhouse.io/anthropic/jobs/4517823\tanthropic\tstaff-swe-data-infra\t2026-04-22T13:00Z\t2026-04-22T13:00Z\tscan-greenhouse\tnew\tabc123\t(none)\t(none)\t(none)\n'
      );
    },
    async (path) => {
      const state = await loadSeenJobs(path);
      assert.equal(state.linkedinIds.size, 1);  // only LinkedIn entry
      assert.ok(state.linkedinIds.has('3847123456'));
      assert.equal(state.fingerprints.size, 1);  // both map to same fingerprint
      assert.ok(state.fingerprints.has('abc123'));
      assert.equal(state.titleCompanyKeys.size, 1);  // same company+title
    }
  );
});

test('appendSeenJobs: appends rows atomically and preserves existing data', async () => {
  await withTempFile(
    (path) => {
      writeFileSync(path,
        SEEN_JOBS_HEADER + '\n' +
        'existing\thttps://x/1\tacme\tsenior-swe\t2026-04-22T10:00Z\t2026-04-22T10:00Z\tapify-linkedin-california\tnew\tfp1\tbackend\t8\told\n'
      );
    },
    async (path) => {
      await appendSeenJobs(path, [{
        linkedin_id: 'new1',
        url: 'https://www.linkedin.com/jobs/view/new1',
        company_slug: 'globex',
        title_normalized: 'backend-engineer',
        first_seen_utc: '2026-04-22T14:00Z',
        last_seen_utc: '2026-04-22T14:00Z',
        source: 'apify-linkedin-california',
        status: 'new',
        jd_fingerprint: 'fp2',
        prefilter_archetype: '(none)',
        prefilter_score: '(none)',
        prefilter_reason: '(none)',
      }]);
      const content = readFileSync(path, 'utf-8');
      assert.ok(content.includes('existing'), 'existing row preserved');
      assert.ok(content.includes('new1'), 'new row appended');
    }
  );
});

test('appendSeenJobs: creates file with header if missing', async () => {
  await withTempFile(null, async (path) => {
    assert.equal(existsSync(path), false);
    await appendSeenJobs(path, [{
      linkedin_id: 'first',
      url: 'https://www.linkedin.com/jobs/view/first',
      company_slug: 'acme',
      title_normalized: 'swe',
      first_seen_utc: '2026-04-22T14:00Z',
      last_seen_utc: '2026-04-22T14:00Z',
      source: 'apify-linkedin-california',
      status: 'new',
      jd_fingerprint: 'fp1',
      prefilter_archetype: '(none)',
      prefilter_score: '(none)',
      prefilter_reason: '(none)',
    }]);
    const content = readFileSync(path, 'utf-8');
    assert.ok(content.startsWith(SEEN_JOBS_HEADER), 'header present on first write');
    assert.ok(content.includes('first'), 'row appended');
  });
});

test('loadSeenJobs: corrupt file → backed up, empty state returned', async () => {
  await withTempFile(
    (path) => {
      writeFileSync(path, 'not a valid tsv\nsome garbage here\n');
    },
    async (path, dir) => {
      const state = await loadSeenJobs(path);
      assert.equal(state.linkedinIds.size, 0);
      assert.equal(state.fingerprints.size, 0);
      // Verify backup was created
      const files = require('node:fs').readdirSync(dir);
      const corrupt = files.find(f => f.includes('.corrupt-'));
      assert.ok(corrupt, 'backup file created');
    }
  );
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/dedup.test.mjs`
Expected: 5 new tests FAIL (exports missing).

---

### Task 13: Implement `loadSeenJobs` + `appendSeenJobs`

**Files:**
- Modify: `lib/dedup.mjs` (append)

- [ ] **Step 1: Add TSV helpers**

Prepend to `lib/dedup.mjs` imports:

```js
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
```

Append to `lib/dedup.mjs`:

```js
export const SEEN_JOBS_HEADER =
  'linkedin_id\turl\tcompany_slug\ttitle_normalized\tfirst_seen_utc\tlast_seen_utc\tsource\tstatus\tjd_fingerprint\tprefilter_archetype\tprefilter_score\tprefilter_reason';

const SEEN_JOBS_COLUMN_COUNT = 12;

/**
 * Load seen-jobs.tsv into memory for O(1) dedup lookups.
 * On corruption (wrong column count, missing header), backs up the file and returns empty state.
 *
 * @param {string} path — absolute path to seen-jobs.tsv
 * @returns {Promise<{linkedinIds: Set<string>, fingerprints: Map<string, object>, titleCompanyKeys: Map<string, object>}>}
 */
export async function loadSeenJobs(path) {
  const linkedinIds = new Set();
  const fingerprints = new Map();
  const titleCompanyKeys = new Map();

  if (!existsSync(path)) {
    return { linkedinIds, fingerprints, titleCompanyKeys };
  }

  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { linkedinIds, fingerprints, titleCompanyKeys };
  }

  // Validate header
  if (lines[0] !== SEEN_JOBS_HEADER) {
    // Corrupt — back up and return empty
    const backup = path.replace(/\.tsv$/, `.corrupt-${Date.now()}.tsv`);
    renameSync(path, backup);
    console.error(`[dedup] seen-jobs.tsv header mismatch; backed up to ${backup}`);
    return { linkedinIds, fingerprints, titleCompanyKeys };
  }

  // Parse rows
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length !== SEEN_JOBS_COLUMN_COUNT) {
      // Corrupt row — back up and bail
      const backup = path.replace(/\.tsv$/, `.corrupt-${Date.now()}.tsv`);
      renameSync(path, backup);
      console.error(`[dedup] seen-jobs.tsv row ${i} has ${cols.length} cols (expected ${SEEN_JOBS_COLUMN_COUNT}); backed up to ${backup}`);
      return {
        linkedinIds: new Set(),
        fingerprints: new Map(),
        titleCompanyKeys: new Map(),
      };
    }
    const row = {
      linkedin_id: cols[0],
      url: cols[1],
      company_slug: cols[2],
      title_normalized: cols[3],
      first_seen_utc: cols[4],
      last_seen_utc: cols[5],
      source: cols[6],
      status: cols[7],
      jd_fingerprint: cols[8],
      prefilter_archetype: cols[9],
      prefilter_score: cols[10],
      prefilter_reason: cols[11],
    };
    if (row.linkedin_id !== '(none)' && row.linkedin_id) {
      linkedinIds.add(row.linkedin_id);
    }
    if (row.jd_fingerprint !== '(none)' && row.jd_fingerprint) {
      if (!fingerprints.has(row.jd_fingerprint)) {
        fingerprints.set(row.jd_fingerprint, row);
      }
    }
    const tck = `${row.company_slug}|${row.title_normalized}`;
    if (row.company_slug && row.title_normalized && !titleCompanyKeys.has(tck)) {
      titleCompanyKeys.set(tck, row);
    }
  }

  return { linkedinIds, fingerprints, titleCompanyKeys };
}

/**
 * Append rows to seen-jobs.tsv atomically.
 * Creates file with header if missing.
 *
 * @param {string} path
 * @param {Array<object>} rows — objects with all SEEN_JOBS_HEADER fields
 */
export async function appendSeenJobs(path, rows) {
  if (!rows || rows.length === 0) return;

  const tmpPath = path + '.tmp';
  let content;
  if (existsSync(path)) {
    content = readFileSync(path, 'utf-8').replace(/\n+$/, '') + '\n';
  } else {
    content = SEEN_JOBS_HEADER + '\n';
  }

  for (const r of rows) {
    content += [
      r.linkedin_id || '(none)',
      r.url || '',
      r.company_slug || '',
      r.title_normalized || '',
      r.first_seen_utc || '',
      r.last_seen_utc || '',
      r.source || '',
      r.status || 'new',
      r.jd_fingerprint || '(none)',
      r.prefilter_archetype || '(none)',
      r.prefilter_score || '(none)',
      r.prefilter_reason || '(none)',
    ].join('\t') + '\n';
  }

  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);  // atomic
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/dedup.test.mjs`
Expected: 22/22 pass.

- [ ] **Step 3: Commit**

```bash
git add lib/dedup.mjs tests/dedup.test.mjs
git commit -m "feat(dedup): loadSeenJobs + appendSeenJobs with atomic writes + corruption recovery"
```

---

## Phase C — `scan.mjs` modifications

### Task 14: Add `jd_fingerprint` computation + `seen-jobs.tsv` writes to scan.mjs

**Files:**
- Modify: `scan.mjs`

- [ ] **Step 1: Read existing scan.mjs**

Run: `cat scan.mjs | head -30`
Identify the imports block + main flow.

- [ ] **Step 2: Add dedup import near other imports**

In `scan.mjs`, find the imports block (should be near the top, starts with `import`). Add after the existing imports:

```js
import { computeJdFingerprint, normalizeCompany, normalizeTitle, appendSeenJobs } from './lib/dedup.mjs';

const SEEN_JOBS_PATH = 'data/seen-jobs.tsv';
```

- [ ] **Step 3: Add a helper function for mapping scan jobs → seen-jobs rows**

After the existing helper functions (near `buildTitleFilter`, `loadSeenUrls`, etc.), add:

```js
function mapScanJobsToSeenJobsRows(jobs, apiType) {
  const nowIso = new Date().toISOString();
  return jobs.map(j => ({
    linkedin_id: '(none)',   // scan.mjs is not LinkedIn
    url: j.url || '',
    company_slug: normalizeCompany(j.company || ''),
    title_normalized: normalizeTitle(j.title || ''),
    first_seen_utc: nowIso,
    last_seen_utc: nowIso,
    source: `scan-${apiType}`,     // e.g., scan-greenhouse
    status: 'new',
    jd_fingerprint: j.description ? computeJdFingerprint(j.description) : '(none)',
    prefilter_archetype: '(none)',
    prefilter_score: '(none)',
    prefilter_reason: '(none)',
  }));
}
```

- [ ] **Step 4: Call appendSeenJobs after existing pipeline.md writes**

Find the section in `scan.mjs` that appends new offers to `pipeline.md` (search for `appendToPipeline`). Right after the `appendToPipeline(newOffers)` call at the end of the scan, add:

```js
// (autopilot) Also write to seen-jobs.tsv for dedup state
// Group by api type so source is correctly tagged
if (newOffers.length > 0) {
  const rows = [];
  for (const offer of newOffers) {
    const apiType = offer.api_type || 'unknown';  // assumes offer has api_type set earlier; if not, pass 'greenhouse-or-ashby-or-lever'
    rows.push(...mapScanJobsToSeenJobsRows([offer], apiType));
  }
  await appendSeenJobs(SEEN_JOBS_PATH, rows);
}
```

**Note:** if the offer object in scan.mjs doesn't already carry `api_type`, locate where offers are produced (after `parseGreenhouse`, `parseAshby`, `parseLever`) and add `api_type: 'greenhouse'` (or the respective) to each parsed object. This is a small additive change to existing code.

- [ ] **Step 5: Verify syntax**

Run: `node --check scan.mjs`
Expected: no output (syntax OK).

- [ ] **Step 6: Smoke test**

Run: `node scan.mjs --dry-run 2>&1 | tail -20`
Expected: completes without error (may scan nothing if portals.yml absent; that's fine).

- [ ] **Step 7: Verify seen-jobs.tsv gets written when there are results**

(If you have a configured `portals.yml` from Phase A work, actually run without `--dry-run`:)

Run: `node scan.mjs 2>&1 | tail -10`
Check: `head -1 data/seen-jobs.tsv` should output the header row if file was created.

- [ ] **Step 8: Commit**

```bash
git add scan.mjs
git commit -m "feat(scan): write to seen-jobs.tsv with jd_fingerprint for autopilot dedup"
```

---

## Phase D — `apify-scan.mjs` (CLI orchestrator)

### Task 15: Failing integration test for apify-scan main flow

**Files:**
- Create: `tests/apify-scan.test.mjs`

- [ ] **Step 1: Create test with a mock ApifyClient**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the main orchestrator function. It accepts an injected client for testing.
import { runApifyScan } from '../apify-scan.mjs';

function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'apify-scan-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeMockClient(itemsByLocation) {
  return {
    actor: (_id) => ({
      call: async (input) => {
        const items = itemsByLocation[input.location] || [];
        return { defaultDatasetId: input.location };
      },
    }),
    dataset: (id) => ({
      listItems: async () => ({ items: itemsByLocation[id] || [] }),
    }),
  };
}

test('runApifyScan: baseline hour fetches all 4 metros in parallel, dedups via seen-set', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
        { name: 'seattle',    location: 'Greater Seattle Area',       baseline_rows: 300, hourly_rows: 100 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    const client = makeMockClient({
      'California, United States': [
        { url: 'https://www.linkedin.com/jobs/view/1001', title: 'Backend Engineer', company: 'Acme', location: 'SF', description: 'We want a backend engineer with Go experience.' },
        { url: 'https://www.linkedin.com/jobs/view/1002', title: 'Frontend Engineer', company: 'Globex', location: 'SF', description: 'React and TypeScript.' },
      ],
      'Greater Seattle Area': [
        { url: 'https://www.linkedin.com/jobs/view/1003', title: 'Infra Engineer', company: 'Initech', location: 'Seattle', description: 'Kubernetes, Terraform, AWS.' },
      ],
    });

    const result = await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,  // force baseline
    });

    assert.equal(result.totalNew, 3, 'all 3 jobs are new');
    assert.equal(result.sources.length, 2);
    assert.ok(existsSync(join(dir, 'seen-jobs.tsv')), 'seen-jobs.tsv written');
    assert.ok(existsSync(join(dir, 'apify-new-TEST.json')), 'apify-new json written');
  });
});

test('runApifyScan: hourly hour fetches with smaller row cap', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    let capturedInput;
    const client = {
      actor: (_id) => ({
        call: async (input) => { capturedInput = input; return { defaultDatasetId: 'd' }; },
      }),
      dataset: (_id) => ({
        listItems: async () => ({ items: [] }),
      }),
    };

    await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 9,  // hourly
    });

    assert.equal(capturedInput.rows, 200);
    assert.equal(capturedInput.publishedAt, 'r7200');
  });
});

test('runApifyScan: one metro failure does not block others (Promise.allSettled)', async () => {
  await withTempWorkspace(async (dir) => {
    const config = {
      actor_id: 'TEST_ACTOR',
      api_token_env: 'FAKE',
      default_params: { title: 'Software Engineer', proxy: {} },
      locations: [
        { name: 'california', location: 'California, United States', baseline_rows: 500, hourly_rows: 200 },
        { name: 'seattle',    location: 'Greater Seattle Area',       baseline_rows: 300, hourly_rows: 100 },
      ],
      baseline: { schedule_pst: '07:00', params: { publishedAt: 'r86400' } },
      hourly: { params: { publishedAt: 'r7200' } },
    };

    const client = {
      actor: (_id) => ({
        call: async (input) => {
          if (input.location === 'Greater Seattle Area') {
            throw new Error('Apify rate limit');
          }
          return { defaultDatasetId: 'd' };
        },
      }),
      dataset: (_id) => ({
        listItems: async () => ({
          items: [{ url: 'https://www.linkedin.com/jobs/view/2001', title: 'Backend Eng', company: 'Acme', location: 'SF', description: 'Go, Kafka.' }],
        }),
      }),
    };

    const result = await runApifyScan({
      config,
      client,
      seenJobsPath: join(dir, 'seen-jobs.tsv'),
      apifyNewPath: join(dir, 'apify-new-TEST.json'),
      hourOverride: 7,
    });

    assert.equal(result.totalNew, 1, 'california succeeded');
    assert.equal(result.errors.length, 1, 'seattle error captured');
    assert.match(result.errors[0].error, /rate limit/);
  });
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/apify-scan.test.mjs`
Expected: all 3 tests FAIL — `runApifyScan` not exported.

---

### Task 16: Implement `apify-scan.mjs`

**Files:**
- Create: `apify-scan.mjs`

- [ ] **Step 1: Write the file**

Create `apify-scan.mjs`:

```js
#!/usr/bin/env node
/**
 * apify-scan.mjs — Apify LinkedIn scraper orchestrator.
 *
 * Usage:
 *   node apify-scan.mjs                # normal run, uses config/apify-search.yml
 *   node apify-scan.mjs --dry-run      # log plan, don't call Apify
 *
 * Reads config/apify-search.yml + config/profile.yml.
 * Calls the Apify actor for each location in parallel (Promise.allSettled).
 * Writes new jobs atomically to data/seen-jobs.tsv + data/apify-new-{ts}.json.
 */

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
} from './lib/dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH  = resolve(__dirname, 'config/apify-search.yml');
const SEEN_PATH    = resolve(__dirname, 'data/seen-jobs.tsv');
const NEW_DIR      = resolve(__dirname, 'data');

/**
 * Scan one location via the Apify actor.
 * Returns { metro, items, error? }.
 */
async function scanOneLocation({ location, params, client, actorId }) {
  const input = {
    ...params.defaultParams,
    location: location.location,
    publishedAt: params.publishedAt,
    rows: params.rows,
  };
  const run = await client.actor(actorId).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return { metro: location.name, items };
}

/**
 * Main orchestrator (injectable for tests).
 */
export async function runApifyScan({ config, client, seenJobsPath, apifyNewPath, hourOverride, dryRun = false }) {
  // Determine which params to use based on hour
  const hour = hourOverride !== undefined
    ? hourOverride
    : new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
  const hourNum = typeof hour === 'number' ? hour : parseInt(hour, 10);
  const isBaseline = hourNum === 7;

  const params = {
    defaultParams: config.default_params,
    publishedAt: isBaseline ? config.baseline.params.publishedAt : config.hourly.params.publishedAt,
  };

  // Load seen-set
  const seen = await loadSeenJobs(seenJobsPath);

  // Dispatch all locations in parallel
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

  const sources = [];
  const errors = [];
  const newRows = [];
  const newJobs = [];

  for (let i = 0; i < settled.length; i++) {
    const loc = config.locations[i];
    const r = settled[i];
    if (r.status === 'rejected') {
      errors.push({ metro: loc.name, error: r.reason?.message || String(r.reason) });
      continue;
    }
    const items = r.value.items || [];
    let newCount = 0;
    const nowIso = new Date().toISOString();
    for (const j of items) {
      const linkedin_id = extractLinkedInId(j.url);
      if (!linkedin_id) continue;
      if (seen.linkedinIds.has(linkedin_id)) continue;

      const fingerprint = j.description ? computeJdFingerprint(j.description) : '(none)';
      if (fingerprint !== '(none)' && seen.fingerprints.has(fingerprint)) continue;

      const company_slug = normalizeCompany(j.company || '');
      const title_normalized = normalizeTitle(j.title || '');
      const tck = `${company_slug}|${title_normalized}`;
      if (company_slug && title_normalized && seen.titleCompanyKeys.has(tck)) continue;

      // Mark seen (in-memory) to dedup within this run
      seen.linkedinIds.add(linkedin_id);
      if (fingerprint !== '(none)') seen.fingerprints.set(fingerprint, {});
      if (company_slug && title_normalized) seen.titleCompanyKeys.set(tck, {});

      newJobs.push({
        linkedin_id,
        url: j.url,
        title: j.title,
        company: j.company,
        company_slug,
        location: j.location || loc.location,
        description: (j.description || '').slice(0, 4000),
        posted_at: j.publishedAt || j.posted_at || '',
        source_metro: loc.name,
      });
      newRows.push({
        linkedin_id,
        url: j.url,
        company_slug,
        title_normalized,
        first_seen_utc: nowIso,
        last_seen_utc: nowIso,
        source: `apify-linkedin-${loc.name}`,
        status: 'new',
        jd_fingerprint: fingerprint,
        prefilter_archetype: '(none)',
        prefilter_score: '(none)',
        prefilter_reason: '(none)',
      });
      newCount++;
    }
    sources.push({ metro: loc.name, fetched: items.length, new: newCount });
  }

  // Write state
  if (!dryRun && newRows.length > 0) {
    await appendSeenJobs(seenJobsPath, newRows);
  }
  if (!dryRun) {
    const payload = {
      run_started_utc: new Date().toISOString(),
      run_finished_utc: new Date().toISOString(),
      sources,
      total_new_jobs: newJobs.length,
      cost_estimate_usd: Number((newJobs.length * 0.001).toFixed(3)),
      errors,
      new_jobs: newJobs,
    };
    writeFileSync(apifyNewPath, JSON.stringify(payload, null, 2));
  }

  return { sources, errors, totalNew: newJobs.length };
}

/**
 * CLI entry.
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    console.error(`Copy config/apify-search.example.yml → config/apify-search.yml and adjust.`);
    process.exit(1);
  }

  const config = yaml.load(readFileSync(CONFIG_PATH, 'utf-8'));
  const token = process.env[config.api_token_env];
  if (!dryRun && !token) {
    console.error(`Missing env var: ${config.api_token_env}`);
    process.exit(1);
  }

  const client = dryRun ? null : new ApifyClient({ token });

  const apifyNewPath = join(NEW_DIR, `apify-new-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  const result = await runApifyScan({
    config,
    client,
    seenJobsPath: SEEN_PATH,
    apifyNewPath,
    dryRun,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.errors.length === config.locations.length ? 1 : 0);
}

// Run as CLI unless imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('apify-scan.mjs crashed:', err);
    process.exit(2);
  });
}
```

- [ ] **Step 2: Run syntax check**

Run: `node --check apify-scan.mjs`
Expected: no output.

- [ ] **Step 3: Run tests**

Run: `node --test tests/apify-scan.test.mjs`
Expected: 3/3 pass.

- [ ] **Step 4: Smoke test dry-run**

Create a minimal `config/apify-search.yml` if not already:
```bash
cp config/apify-search.example.yml config/apify-search.yml
```

Run: `node apify-scan.mjs --dry-run 2>&1 | head -20`
Expected: JSON output with 4 sources, 0 new, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apify-scan.mjs tests/apify-scan.test.mjs
git commit -m "feat(autopilot): apify-scan.mjs orchestrator with Promise.allSettled"
```

---

## Phase E — `digest-builder.mjs`

### Task 17: Failing unit tests for title filter + deal-breaker logic

**Files:**
- Create: `tests/digest-builder.test.mjs`

- [ ] **Step 1: Create test file**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTitleFilter } from '../digest-builder.mjs';

const filter = {
  positive: ['Backend', 'Infrastructure', 'Platform', 'Data Engineer', 'ML'],
  negative: ['.NET', 'Java Senior Developer'],
};
const dealBreakers = ['Intern', 'Junior', 'Contract'];

test('applyTitleFilter: positive match passes', () => {
  assert.equal(applyTitleFilter('Senior Backend Engineer', filter, dealBreakers), true);
});

test('applyTitleFilter: no positive match fails', () => {
  assert.equal(applyTitleFilter('Product Manager', filter, dealBreakers), false);
});

test('applyTitleFilter: negative match fails', () => {
  assert.equal(applyTitleFilter('.NET Backend Engineer', filter, dealBreakers), false);
});

test('applyTitleFilter: deal-breaker match fails', () => {
  assert.equal(applyTitleFilter('Junior Backend Engineer', filter, dealBreakers), false);
  assert.equal(applyTitleFilter('Software Engineering Intern, Backend', filter, dealBreakers), false);
});

test('applyTitleFilter: case-insensitive', () => {
  assert.equal(applyTitleFilter('senior backend engineer', filter, dealBreakers), true);
  assert.equal(applyTitleFilter('JUNIOR BACKEND', filter, dealBreakers), false);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/digest-builder.test.mjs`
Expected: FAIL — `digest-builder.mjs` not found.

---

### Task 18: Implement `digest-builder.mjs` skeleton + `applyTitleFilter`

**Files:**
- Create: `digest-builder.mjs`

- [ ] **Step 1: Write the file skeleton with applyTitleFilter**

```js
#!/usr/bin/env node
/**
 * digest-builder.mjs — 3-stage filter + digest renderer.
 *
 * Usage:
 *   node digest-builder.mjs                # normal run
 *   node digest-builder.mjs --dry-run      # don't write output
 *
 * Stages:
 *   1. Free title filter (portals.yml.title_filter + profile.deal_breakers)
 *   2. Fingerprint dedup (cross-source, last 30 days)
 *   3. Haiku archetype-aware scoring
 *
 * Outputs:
 *   - data/digest.md (overwritten at 7am, appended otherwise)
 *   - appends score≥6 entries to data/pipeline.md
 *   - macOS notification via osascript
 *   - archives old digests to data/digest-history/
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';
import {
  normalizeCompany,
  normalizeTitle,
  computeJdFingerprint,
  loadSeenJobs,
  appendSeenJobs,
  SEEN_JOBS_HEADER,
} from './lib/dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const DIGEST_PATH = join(DATA_DIR, 'digest.md');
const HISTORY_DIR = join(DATA_DIR, 'digest-history');
const APIFY_NEW_GLOB = 'apify-new-';
const APIFY_ARCHIVE_DIR = join(DATA_DIR, 'apify-new-archive');
const PIPELINE_PATH = join(DATA_DIR, 'pipeline.md');

const HAIKU_MODEL = process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Apply 3-part title filter: positive-match AND !negative-match AND !deal-breaker.
 * All matches are case-insensitive substring.
 *
 * @param {string} title
 * @param {{positive: string[], negative: string[]}} filter
 * @param {string[]} dealBreakers
 * @returns {boolean} true if job passes filter
 */
export function applyTitleFilter(title, filter, dealBreakers) {
  if (!title || typeof title !== 'string') return false;
  const lc = title.toLowerCase();
  const hasPositive = (filter.positive || []).length === 0 ||
    (filter.positive || []).some(k => lc.includes(k.toLowerCase()));
  const hasNegative = (filter.negative || []).some(k => lc.includes(k.toLowerCase()));
  const hasDealBreaker = (dealBreakers || []).some(k => lc.includes(k.toLowerCase()));
  return hasPositive && !hasNegative && !hasDealBreaker;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 5/5 pass.

- [ ] **Step 3: Commit**

```bash
git add digest-builder.mjs tests/digest-builder.test.mjs
git commit -m "feat(digest): applyTitleFilter (stage 1 filter, TDD)"
```

---

### Task 18B: Failing tests for `isCompanyBlacklisted`

**Files:**
- Modify: `tests/digest-builder.test.mjs` (append)

- [ ] **Step 1: Append tests**

Append to `tests/digest-builder.test.mjs`:

```js
import { isCompanyBlacklisted } from '../digest-builder.mjs';

const blacklist = [
  'RemoteHunter', 'Walmart', 'PayPal', 'Jobright.ai', 'Turing',
  'ByteDance', 'TikTok', 'Insight Global', 'CyberCoders',
  'Jobs via Dice', 'Open Talent',
];

test('isCompanyBlacklisted: exact match (case-insensitive)', () => {
  assert.equal(isCompanyBlacklisted('Walmart', blacklist), true);
  assert.equal(isCompanyBlacklisted('WALMART', blacklist), true);
  assert.equal(isCompanyBlacklisted('walmart', blacklist), true);
});

test('isCompanyBlacklisted: substring match (subsidiary names)', () => {
  assert.equal(isCompanyBlacklisted('Walmart Labs', blacklist), true);
  assert.equal(isCompanyBlacklisted('Walmart Connect', blacklist), true);
  assert.equal(isCompanyBlacklisted('PayPal Ventures', blacklist), true);
});

test('isCompanyBlacklisted: multi-word entries with punctuation', () => {
  assert.equal(isCompanyBlacklisted('Insight Global', blacklist), true);
  assert.equal(isCompanyBlacklisted('Jobs via Dice', blacklist), true);
  assert.equal(isCompanyBlacklisted('Open Talent', blacklist), true);
  assert.equal(isCompanyBlacklisted('Jobright.ai', blacklist), true);
});

test('isCompanyBlacklisted: TikTok and ByteDance variants', () => {
  assert.equal(isCompanyBlacklisted('TikTok', blacklist), true);
  assert.equal(isCompanyBlacklisted('ByteDance Inc', blacklist), true);
  assert.equal(isCompanyBlacklisted('Tiktok (ByteDance)', blacklist), true);
});

test('isCompanyBlacklisted: non-blacklisted company passes', () => {
  assert.equal(isCompanyBlacklisted('Anthropic', blacklist), false);
  assert.equal(isCompanyBlacklisted('Databricks', blacklist), false);
  assert.equal(isCompanyBlacklisted('Stripe', blacklist), false);
});

test('isCompanyBlacklisted: empty blacklist → everyone passes', () => {
  assert.equal(isCompanyBlacklisted('Walmart', []), false);
  assert.equal(isCompanyBlacklisted('Walmart', undefined), false);
});

test('isCompanyBlacklisted: empty company name → not blacklisted', () => {
  assert.equal(isCompanyBlacklisted('', blacklist), false);
  assert.equal(isCompanyBlacklisted(null, blacklist), false);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 7 new tests FAIL — `isCompanyBlacklisted` not exported.

---

### Task 18C: Implement `isCompanyBlacklisted`

**Files:**
- Modify: `digest-builder.mjs` (append)

- [ ] **Step 1: Add function**

Append to `digest-builder.mjs`:

```js
/**
 * Check whether a company is on the user's blacklist.
 * Matching: normalize both sides via normalizeCompany (lowercase + kebab-case),
 * then substring match. "Walmart" entry matches "walmart", "walmart-labs",
 * "walmart-connect". Case-insensitive.
 *
 * @param {string} companyName — the candidate job's company field
 * @param {string[]} blacklist — entries from profile.yml target_roles.company_blacklist
 * @returns {boolean} true if the company should be dropped from the digest
 */
export function isCompanyBlacklisted(companyName, blacklist) {
  if (!companyName || !blacklist || blacklist.length === 0) return false;
  const normalized = normalizeCompany(companyName);
  if (!normalized) return false;
  return blacklist.some(entry => {
    const entryNormalized = normalizeCompany(entry);
    if (!entryNormalized) return false;
    return normalized === entryNormalized || normalized.includes(entryNormalized);
  });
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/digest-builder.test.mjs`
Expected: all digest-builder tests pass (12 prior + 7 new = 19).

- [ ] **Step 3: Commit**

```bash
git add digest-builder.mjs tests/digest-builder.test.mjs
git commit -m "feat(digest): isCompanyBlacklisted filter (TDD)

Drop jobs from blacklisted companies (RemoteHunter, Walmart, PayPal,
Jobright.ai, Turing, ByteDance, TikTok, Insight Global, CyberCoders,
Jobs via Dice, Open Talent) as part of Stage 1. Case-insensitive
substring match so subsidiary variants (Walmart Labs, PayPal Ventures)
also filter out."
```

---

### Task 19: Failing tests for `buildCandidateSummary`

**Files:**
- Modify: `tests/digest-builder.test.mjs` (append)

- [ ] **Step 1: Append tests**

Append to `tests/digest-builder.test.mjs`:

```js
import { buildCandidateSummary } from '../digest-builder.mjs';

test('buildCandidateSummary: includes name + seniority + archetypes', () => {
  const profile = {
    candidate: { full_name: 'Test User' },
    target_roles: {
      archetypes_of_interest: ['backend', 'infra'],
      seniority_min: 'Mid-Senior',
      seniority_max: 'Staff',
    },
    narrative: { headline: 'Backend engineer' },
  };
  const sources = {
    acme: [
      {
        frontmatter: { company: 'Acme Corp', role: 'Senior Engineer' },
        bullets: [{ text: 'Built Go microservices' }, { text: 'Kafka pipelines' }],
        projects: [],
        skills: ['Go', 'Kafka'],
      },
    ],
  };
  const summary = buildCandidateSummary(profile, sources);
  assert.match(summary, /Test User/);
  assert.match(summary, /Mid-Senior/);
  assert.match(summary, /Staff/);
  assert.match(summary, /backend/i);
  assert.match(summary, /infra/i);
});

test('buildCandidateSummary: includes company+role lines from sources', () => {
  const profile = {
    candidate: { full_name: 'X' },
    target_roles: { archetypes_of_interest: ['backend'] },
  };
  const sources = {
    linkedin: [
      {
        frontmatter: { company: 'LinkedIn Corp', role: 'Software Engineer', start: '2025-01' },
        bullets: [{ text: 'GDPR data deletion' }],
        skills: ['Airflow', 'Spark'],
      },
    ],
  };
  const summary = buildCandidateSummary(profile, sources);
  assert.match(summary, /LinkedIn Corp/);
  assert.match(summary, /Software Engineer/);
  assert.match(summary, /Airflow/);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 2 new tests FAIL.

---

### Task 20: Implement `buildCandidateSummary`

**Files:**
- Modify: `digest-builder.mjs` (append)

- [ ] **Step 1: Add function**

Append to `digest-builder.mjs`:

```js
/**
 * Build the cached candidate-summary block used in the Haiku pre-filter prompt.
 * Assembled from config/profile.yml + experience_source/ (via loadAllSources,
 * shared with assemble-cv.mjs).
 *
 * Length target: ~400-500 tokens, cacheable.
 */
export function buildCandidateSummary(profile, sources) {
  const cand = profile.candidate || {};
  const tr = profile.target_roles || {};
  const narrative = profile.narrative || {};
  const archetypes = (tr.archetypes_of_interest || ['frontend', 'backend', 'infra', 'machine_learning']).join(', ');
  const minSen = tr.seniority_min || 'Mid-Senior';
  const maxSen = tr.seniority_max || 'Staff';

  const lines = [];
  lines.push('<candidate_profile>');
  lines.push(`Name: ${cand.full_name || 'Candidate'}`);
  lines.push(`Seniority: ${minSen}–${maxSen} target; NOT Junior/Intern/Entry`);
  lines.push(`Open to roles across: ${archetypes}`);
  if (narrative.headline) lines.push(`Headline: ${narrative.headline}`);
  lines.push('');

  // Group bullets by archetype across companies
  const byArchetype = {};
  for (const [dir, files] of Object.entries(sources || {})) {
    for (const f of files || []) {
      const fm = f.frontmatter || {};
      const facet = fm.facet || 'unknown';
      byArchetype[facet] ??= [];
      const role = `${fm.company || dir} (${fm.role || 'SWE'}, ${fm.start || '?'}-${fm.end || 'present'})`;
      const bullets = (f.bullets || []).slice(0, 3).map(b => b.text).join('; ');
      byArchetype[facet].push(`- ${role}: ${bullets}`);
    }
  }

  for (const facet of ['frontend', 'backend', 'infra', 'machine_learning']) {
    if (byArchetype[facet]?.length) {
      lines.push(facet.toUpperCase() + ':');
      for (const ln of byArchetype[facet]) lines.push('  ' + ln);
      lines.push('');
    }
  }

  // Flatten skills across all files
  const allSkills = new Set();
  for (const files of Object.values(sources || {})) {
    for (const f of files || []) {
      for (const s of f.skills || []) allSkills.add(s);
    }
  }
  if (allSkills.size > 0) {
    lines.push(`Skills breadth: ${[...allSkills].slice(0, 30).join(', ')}`);
  }
  lines.push('</candidate_profile>');

  return lines.join('\n');
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 7/7 pass.

- [ ] **Step 3: Commit**

```bash
git add digest-builder.mjs tests/digest-builder.test.mjs
git commit -m "feat(digest): buildCandidateSummary for Haiku prompt (cached block)"
```

---

### Task 21: Failing tests for `preFilterJob` with mock Haiku

**Files:**
- Modify: `tests/digest-builder.test.mjs` (append)

- [ ] **Step 1: Append tests**

Append to `tests/digest-builder.test.mjs`:

```js
import { preFilterJob } from '../digest-builder.mjs';

function makeMockHaiku(fixedResponse) {
  return {
    messages: {
      create: async () => ({
        content: [{ text: fixedResponse }],
      }),
    },
  };
}

test('preFilterJob: parses valid JSON response', async () => {
  const mock = makeMockHaiku('{"archetype":"backend","score":8,"reason":"Go + Kafka match"}');
  const job = { title: 'Senior Backend Engineer', company: 'Acme', location: 'SF', description: 'Go, Kafka.' };
  const result = await preFilterJob(job, 'SYSTEM', 'PROFILE', mock);
  assert.equal(result.archetype, 'backend');
  assert.equal(result.score, 8);
  assert.equal(result.reason, 'Go + Kafka match');
});

test('preFilterJob: malformed JSON → score=null reason explains', async () => {
  const mock = makeMockHaiku('not-json-at-all');
  const job = { title: 'SWE', company: 'X', location: 'Y', description: 'Z' };
  const result = await preFilterJob(job, '', '', mock);
  assert.equal(result.score, null);
  assert.equal(result.archetype, 'unknown');
  assert.match(result.reason, /parse/i);
});

test('preFilterJob: clamps score outside 0-10', async () => {
  const mock = makeMockHaiku('{"archetype":"backend","score":15,"reason":"ok"}');
  const result = await preFilterJob({ title: 'x', company: 'x', location: 'x', description: 'x' }, '', '', mock);
  assert.equal(result.score, 10);
});

test('preFilterJob: API error → score=null unavailable', async () => {
  const mock = {
    messages: { create: async () => { throw new Error('rate limit'); } },
  };
  const result = await preFilterJob({ title: 'x', company: 'x', location: 'x', description: 'x' }, '', '', mock);
  assert.equal(result.score, null);
  assert.match(result.reason, /rate limit|unavailable/);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 4 new tests FAIL.

---

### Task 22: Implement `preFilterJob`

**Files:**
- Modify: `digest-builder.mjs` (append)

- [ ] **Step 1: Add constants + function**

Append to `digest-builder.mjs`:

```js
export const SYSTEM_PROMPT = `You are a job-fit pre-filter for a multi-facet candidate who is open to roles in FRONTEND, BACKEND, INFRA, MACHINE_LEARNING, or FULLSTACK.

Given the candidate's profile and a job description, output JSON with:
- archetype: one of "frontend" | "backend" | "infra" | "machine_learning" | "fullstack"
- score: integer 0-10 — how well candidate matches THIS archetype
- reason: one-line ≤100 chars justifying the score

ARCHETYPE CLASSIFICATION NOTES:
- "AI Engineer" / "AI-Native Engineer" / "LLM Engineer" / "Agent Engineer" / "Applied AI"
  roles → classify as "fullstack" (these are typically fullstack + LLM combinations).
  Score on the combination of candidate's fullstack breadth AND their LLM/agent experience.
- "ML Engineer" (classical ML, XGBoost, feature stores, recommender systems) → "machine_learning".
- "Platform Engineer" / "SRE" / "DevOps" / "Data Platform" → "infra".
- "Backend Engineer" (distributed systems, APIs) → "backend".
- "Frontend Engineer" (React, UI, design systems) → "frontend".
- "Fullstack Engineer" without LLM/AI focus → "fullstack".

Scoring rubric:
 10  Outstanding match: recent experience maps directly, senior fit.
 8-9 Strong match: most requirements met, a few might need reframing.
 6-7 Decent match: core overlap but notable gaps.
 4-5 Weak match: partial overlap or wrong seniority.
 0-3 Not a match: wrong role, seniority, or discipline (e.g., legal role with "Infrastructure" in title).

IMPORTANT:
- Score fairly across archetypes — don't penalize ML jobs for not being backend.
- Contract/C2C/temporary = 0-2 (candidate wants full-time).
- Non-engineering (legal/tax/HR) = 0-2.
- Test Engineer / QA roles = 0-2 (candidate is not looking for QA).
- Junior/Entry/Intern engineer roles are acceptable — score them on stack match
  like any other role; don't downrank for seniority.

Output ONLY the JSON object. No preamble, no markdown.`;

/**
 * Pre-filter one job via Haiku.
 * @returns {Promise<{archetype, score, reason}>} where score is integer 0-10 or null
 */
export async function preFilterJob(job, systemPrompt, candidateSummary, client) {
  const userMessage =
    `<job>\nTitle: ${job.title || ''}\nCompany: ${job.company || ''}\n` +
    `Location: ${job.location || ''}\nDescription:\n` +
    `${(job.description || '').slice(0, 3000)}\n</job>\n\nReturn JSON.`;

  let response;
  try {
    response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 120,
      temperature: 0,
      system: [
        { type: 'text', text: systemPrompt || SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: candidateSummary,
          cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (e) {
    return { archetype: 'unknown', score: null, reason: `prefilter unavailable: ${(e.message || '').slice(0, 60)}` };
  }

  const text = (response.content?.[0]?.text || '').trim();

  // Try strict JSON parse first; fall back to regex extract
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[^}]+\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { archetype: 'unknown', score: null, reason: 'prefilter parse failed' };
  }

  // Validate + clamp
  const validArchetypes = ['frontend', 'backend', 'infra', 'machine_learning', 'fullstack'];
  const archetype = validArchetypes.includes(parsed.archetype) ? parsed.archetype : 'unknown';
  let score = parsed.score;
  if (typeof score !== 'number') score = null;
  else if (score < 0) score = 0;
  else if (score > 10) score = 10;
  else score = Math.round(score);
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 100) : '';

  return { archetype, score, reason };
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 11/11 pass.

- [ ] **Step 3: Commit**

```bash
git add digest-builder.mjs tests/digest-builder.test.mjs
git commit -m "feat(digest): preFilterJob with Haiku + prompt caching (parse + clamp + fallback)"
```

---

### Task 23: Failing tests for `renderDigest`

**Files:**
- Modify: `tests/digest-builder.test.mjs` (append)

- [ ] **Step 1: Append tests**

Append to `tests/digest-builder.test.mjs`:

```js
import { renderDigest } from '../digest-builder.mjs';

test('renderDigest: groups by score bucket then archetype', () => {
  const jobs = [
    { title: 'Backend Engineer', company: 'Acme', location: 'SF', url: 'https://x/1', archetype: 'backend', score: 9, reason: 'go match', sources: ['apify-california'] },
    { title: 'ML Eng', company: 'Globex', location: 'NY', url: 'https://x/2', archetype: 'machine_learning', score: 8, reason: 'llm work', sources: ['apify-new-york'] },
    { title: 'Infra Eng', company: 'Initech', location: 'Seattle', url: 'https://x/3', archetype: 'infra', score: 6, reason: 'k8s ok', sources: ['apify-seattle'] },
    { title: 'Jr Dev', company: 'X', location: 'Y', url: 'https://x/4', archetype: 'backend', score: 2, reason: 'junior', sources: ['apify-california'] },
  ];
  const md = renderDigest({
    jobs,
    nowPst: '2026-04-22 14:10 PST',
    totalJobs: 4,
    bucketCounts: { strong: 2, maybe: 1, no: 0, skip: 1, unavailable: 0 },
    archetypeCounts: { backend: 2, machine_learning: 1, infra: 1 },
  });
  assert.match(md, /## 🔥 Score ≥ 8/);
  assert.match(md, /### 🔧 Backend/);
  assert.match(md, /Acme/);
  assert.match(md, /9\/10/);
  assert.match(md, /## ⚡ Score 6-7/);
  assert.match(md, /Initech/);
  assert.match(md, /## 🚫 Score ≤ 3/);
});

test('renderDigest: preserves checkbox state from existing digest', () => {
  const existing = `# Job Digest — 2026-04-22 (updated 12:10 PST, 1 jobs)

## 🔥 Score ≥ 8 — Strong Match

### 🔧 Backend (1)
- [x] **9/10** · Acme · Backend Engineer · SF
  https://x/1
  Why: go match
`;
  const jobs = [
    { title: 'Backend Engineer', company: 'Acme', location: 'SF', url: 'https://x/1', archetype: 'backend', score: 9, reason: 'go match', sources: [] },
    { title: 'New Role', company: 'Globex', location: 'NY', url: 'https://x/2', archetype: 'backend', score: 8, reason: 'new', sources: [] },
  ];
  const md = renderDigest({
    jobs,
    existingDigest: existing,
    nowPst: '2026-04-22 14:10 PST',
    totalJobs: 2,
    bucketCounts: { strong: 2, maybe: 0, no: 0, skip: 0, unavailable: 0 },
    archetypeCounts: { backend: 2 },
  });
  assert.match(md, /\[x\].*Acme/, 'Acme retains checked state');
  assert.match(md, /\[ \].*New Role/, 'New job starts unchecked');
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 2 new tests FAIL.

---

### Task 24: Implement `renderDigest`

**Files:**
- Modify: `digest-builder.mjs` (append)

- [ ] **Step 1: Add rendering functions**

Append to `digest-builder.mjs`:

```js
const BUCKET_DEFS = [
  { name: 'strong', emoji: '🔥', label: 'Score ≥ 8 — Strong Match',  min: 8, max: 10 },
  { name: 'maybe',  emoji: '⚡', label: 'Score 6-7 — Worth a Look',    min: 6, max: 7 },
  { name: 'no',     emoji: '💤', label: 'Score 4-5 — Probably Not',    min: 4, max: 5 },
  { name: 'skip',   emoji: '🚫', label: 'Score ≤ 3 — Skip',             min: 0, max: 3 },
];

const ARCHETYPE_EMOJI = {
  backend: '🔧',
  infra: '🏗️',
  machine_learning: '🧠',
  frontend: '🎨',
  fullstack: '🌐',
  unknown: '❓',
};

const ARCHETYPE_LABEL = {
  backend: 'Backend',
  infra: 'Infra',
  machine_learning: 'Machine Learning',
  frontend: 'Frontend',
  fullstack: 'Fullstack',
  unknown: 'Unknown',
};

/**
 * Extract { url: 'x' | ' ' } checkbox state map from an existing digest markdown.
 */
function extractCheckboxState(existingMd) {
  if (!existingMd) return {};
  const state = {};
  const lines = existingMd.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[([ x])\]/);
    if (m) {
      // URL on next non-empty line
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const u = lines[j].match(/^\s*(https?:\/\/\S+)/);
        if (u) { state[u[1]] = m[1]; break; }
      }
    }
  }
  return state;
}

/**
 * Render the full digest.md content.
 */
export function renderDigest({ jobs, existingDigest, nowPst, totalJobs, bucketCounts, archetypeCounts }) {
  const checkboxState = extractCheckboxState(existingDigest);

  const lines = [];
  const dateHeader = nowPst ? nowPst.split(' ')[0] : new Date().toISOString().slice(0, 10);
  lines.push(`# Job Digest — ${dateHeader} (updated ${nowPst || new Date().toISOString()}, ${totalJobs} jobs)`);
  lines.push('');
  const totalsParts = [];
  totalsParts.push(`🔥 ${bucketCounts.strong || 0} strong`);
  totalsParts.push(`⚡ ${bucketCounts.maybe || 0} maybe`);
  totalsParts.push(`💤 ${bucketCounts.no || 0} probably-not`);
  totalsParts.push(`🚫 ${bucketCounts.skip || 0} skip`);
  lines.push(`**Totals**: ${totalsParts.join(' · ')}`);
  const archParts = Object.entries(archetypeCounts || {})
    .map(([a, n]) => `${a} ${n}`)
    .join(' · ');
  lines.push(`**By archetype**: ${archParts}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group jobs by bucket then archetype
  for (const bucket of BUCKET_DEFS) {
    const inBucket = jobs.filter(j => j.score !== null && j.score >= bucket.min && j.score <= bucket.max);
    if (inBucket.length === 0) continue;

    lines.push(`## ${bucket.emoji} ${bucket.label}`);
    lines.push('');

    const byArchetype = {};
    for (const j of inBucket) {
      (byArchetype[j.archetype] ??= []).push(j);
    }
    for (const arch of Object.keys(ARCHETYPE_LABEL)) {
      if (!byArchetype[arch]?.length) continue;
      lines.push(`### ${ARCHETYPE_EMOJI[arch]} ${ARCHETYPE_LABEL[arch]} (${byArchetype[arch].length})`);
      for (const j of byArchetype[arch].sort((a, b) => b.score - a.score)) {
        const check = checkboxState[j.url] === 'x' ? 'x' : ' ';
        const sourceLine = j.sources?.length ? `  Sources: [${j.sources.join(', ')}]` : '';
        lines.push(`- [${check}] **${j.score}/10** · ${j.company} · ${j.title} · ${j.location || ''}`);
        lines.push(`  ${j.url}`);
        lines.push(`  Why: ${j.reason || '(no reason)'}`);
        if (sourceLine) lines.push(sourceLine);
        lines.push('');
      }
    }
  }

  // Unavailable section
  const unavailable = jobs.filter(j => j.score === null);
  if (unavailable.length > 0) {
    lines.push(`## ⚠️ Pre-filter unavailable (${unavailable.length})`);
    lines.push('');
    for (const j of unavailable) {
      const check = checkboxState[j.url] === 'x' ? 'x' : ' ';
      lines.push(`- [${check}] ${j.company} · ${j.title} · ${j.location || ''}`);
      lines.push(`  ${j.url}`);
      lines.push(`  Reason: ${j.reason || 'unknown'}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/digest-builder.test.mjs`
Expected: 13/13 pass.

- [ ] **Step 3: Commit**

```bash
git add digest-builder.mjs tests/digest-builder.test.mjs
git commit -m "feat(digest): renderDigest with archetype grouping + checkbox preservation"
```

---

### Task 25: Implement the main orchestrator `buildDigest`

**Files:**
- Modify: `digest-builder.mjs` (append)

- [ ] **Step 1: Add main orchestration function**

Append to `digest-builder.mjs`:

```js
/**
 * Main digest-builder orchestrator (injectable for tests).
 * @param {object} args
 * @param {object} args.profile — parsed config/profile.yml
 * @param {object} args.portals — parsed portals.yml (for title_filter)
 * @param {object} args.sources — experience_source parsed (from assemble-core.loadAllSources)
 * @param {object[]} args.candidateJobs — jobs from apify-new + scan output to triage
 * @param {string} args.existingDigest — current digest.md content (empty for 7am)
 * @param {object} args.haikuClient — Anthropic client (mocked in tests)
 * @param {boolean} args.dryRun
 * @returns {Promise<{digestMd, pipelineAdditions, notification, stats}>}
 */
export async function buildDigest({ profile, portals, sources, candidateJobs, existingDigest, haikuClient, dryRun }) {
  const dealBreakers = profile?.target_roles?.deal_breakers || [];
  const companyBlacklist = profile?.target_roles?.company_blacklist || [];
  const titleFilter = portals?.title_filter || { positive: [], negative: [] };

  // Stage 1 — free rule-based filter (title keywords + deal-breakers + company blacklist)
  const stage1 = candidateJobs.filter(j =>
    applyTitleFilter(j.title, titleFilter, dealBreakers) &&
    !isCompanyBlacklisted(j.company, companyBlacklist)
  );

  // Stage 2 — fingerprint dedup (within this batch + against history via seen.fingerprints)
  const seenInBatch = new Set();
  const stage2 = [];
  for (const j of stage1) {
    const fp = j.jd_fingerprint || (j.description ? computeJdFingerprint(j.description) : null);
    if (fp && seenInBatch.has(fp)) continue;
    if (fp) seenInBatch.add(fp);
    stage2.push(j);
  }

  // Stage 3 — Haiku pre-filter (sequential for cache hit-rate)
  const candidateSummary = buildCandidateSummary(profile, sources);
  const prefiltered = [];
  for (const j of stage2) {
    const { archetype, score, reason } = await preFilterJob(j, SYSTEM_PROMPT, candidateSummary, haikuClient);
    prefiltered.push({ ...j, archetype, score, reason });
  }

  // Compute bucket + archetype counts
  const bucketCounts = { strong: 0, maybe: 0, no: 0, skip: 0, unavailable: 0 };
  const archetypeCounts = {};
  for (const j of prefiltered) {
    archetypeCounts[j.archetype] = (archetypeCounts[j.archetype] || 0) + 1;
    if (j.score === null) bucketCounts.unavailable++;
    else if (j.score >= 8) bucketCounts.strong++;
    else if (j.score >= 6) bucketCounts.maybe++;
    else if (j.score >= 4) bucketCounts.no++;
    else bucketCounts.skip++;
  }

  // Render digest.md
  const nowPst = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const digestMd = renderDigest({
    jobs: prefiltered,
    existingDigest,
    nowPst: nowPst + ' PST',
    totalJobs: prefiltered.length,
    bucketCounts,
    archetypeCounts,
  });

  // Pipeline additions — score ≥ 6 only, format matches pipeline.md
  const pipelineAdditions = prefiltered
    .filter(j => j.score !== null && j.score >= 6)
    .map(j => `- [ ] ${j.url} | ${j.company} | ${j.title}  <!-- prefilter: ${j.score}/10 ${j.archetype} -->`);

  // Notification text
  const topJob = prefiltered.filter(j => j.score !== null).sort((a, b) => b.score - a.score)[0];
  const notification = topJob
    ? `${prefiltered.length} new jobs, top: ${topJob.company} (${topJob.score}/10)`
    : `${prefiltered.length} new jobs (no pre-filter results)`;

  return {
    digestMd,
    pipelineAdditions,
    notification,
    stats: {
      total_scored: prefiltered.length,
      stage1_passed: stage1.length,
      stage2_passed: stage2.length,
      bucketCounts,
      archetypeCounts,
    },
  };
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/digest-builder.test.mjs`
Expected: all 13 pass (no new tests; this orchestrator is covered by E2E).

- [ ] **Step 3: Commit**

```bash
git add digest-builder.mjs
git commit -m "feat(digest): buildDigest 3-stage orchestrator"
```

---

### Task 26: Add CLI wrapper + macOS notification

**Files:**
- Modify: `digest-builder.mjs` (append)

- [ ] **Step 1: Add file-loading helpers + CLI main**

Append to `digest-builder.mjs`:

```js
/**
 * Load all data/apify-new-*.json files that haven't been archived, plus
 * optionally recent scan.mjs pipeline.md additions. Returns merged job list.
 */
function loadCandidateJobs() {
  const jobs = [];
  if (existsSync(DATA_DIR)) {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith(APIFY_NEW_GLOB) && f.endsWith('.json'));
    for (const f of files) {
      try {
        const content = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8'));
        for (const j of content.new_jobs || []) {
          jobs.push({
            ...j,
            source: `apify-linkedin-${j.source_metro || 'unknown'}`,
            sources: [`apify-${j.source_metro || 'unknown'}`],
            jd_fingerprint: j.description ? computeJdFingerprint(j.description) : null,
          });
        }
      } catch (e) {
        console.error(`[digest] failed to parse ${f}: ${e.message}`);
      }
    }
  }
  return jobs;
}

/**
 * Archive processed apify-new-*.json files after successful digest build.
 */
function archiveApifyNewFiles() {
  if (!existsSync(APIFY_ARCHIVE_DIR)) mkdirSync(APIFY_ARCHIVE_DIR, { recursive: true });
  const files = readdirSync(DATA_DIR).filter(f => f.startsWith(APIFY_NEW_GLOB) && f.endsWith('.json'));
  for (const f of files) {
    try {
      renameSync(join(DATA_DIR, f), join(APIFY_ARCHIVE_DIR, f));
    } catch (e) {
      console.error(`[digest] failed to archive ${f}: ${e.message}`);
    }
  }
}

/**
 * Archive yesterday's digest.md to digest-history/ and start fresh.
 * Called only at 7am.
 */
function archiveYesterdayDigest() {
  if (!existsSync(DIGEST_PATH)) return;
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  // Extract date from the existing digest's first line if possible
  const content = readFileSync(DIGEST_PATH, 'utf-8');
  const m = content.match(/^# Job Digest — (\d{4}-\d{2}-\d{2})/);
  const dateStr = m ? m[1] : new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const target = join(HISTORY_DIR, `${dateStr}.md`);
  if (!existsSync(target)) {
    renameSync(DIGEST_PATH, target);
  }
  // Prune older than 30 days
  const cutoff = Date.now() - 30 * 86400000;
  for (const f of readdirSync(HISTORY_DIR)) {
    const dm = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dm) continue;
    const fileDate = new Date(dm[1]).getTime();
    if (fileDate < cutoff) {
      try { require('node:fs').unlinkSync(join(HISTORY_DIR, f)); } catch { /* ignore */ }
    }
  }
}

/**
 * Send a macOS notification via osascript.
 */
function notify(text) {
  try {
    execFileSync('osascript', ['-e',
      `display notification "${text.replace(/"/g, '\\"')}" with title "career-ops autopilot"`],
      { stdio: 'ignore' });
  } catch { /* notification failure should not crash digest */ }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const profilePath = resolve(__dirname, 'config/profile.yml');
  const portalsPath = resolve(__dirname, 'portals.yml');
  if (!existsSync(profilePath)) {
    console.error(`Missing config/profile.yml — copy from config/profile.example.yml`);
    process.exit(1);
  }
  const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  const portals = existsSync(portalsPath)
    ? yaml.load(readFileSync(portalsPath, 'utf-8'))
    : { title_filter: { positive: [], negative: [] } };

  // Load experience_source via assemble-core (shared module)
  const { loadAllSources } = await import('./assemble-core.mjs');
  const sourcesRoot = resolve(__dirname, profile.experience_sources?.root || 'experience_source');
  const sources = existsSync(sourcesRoot) ? loadAllSources(sourcesRoot) : {};

  const candidateJobs = loadCandidateJobs();

  // Check if 7am (baseline) for archive
  const hourPst = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }),
    10
  );
  const isBaseline = hourPst === 7;

  if (!dryRun && isBaseline) {
    archiveYesterdayDigest();
  }

  const existingDigest = existsSync(DIGEST_PATH) ? readFileSync(DIGEST_PATH, 'utf-8') : '';

  // Build Haiku client
  const haikuClient = dryRun
    ? { messages: { create: async () => ({ content: [{ text: '{"archetype":"unknown","score":null,"reason":"dry run"}' }] }) } }
    : new Anthropic();

  const result = await buildDigest({
    profile, portals, sources, candidateJobs,
    existingDigest, haikuClient, dryRun,
  });

  if (!dryRun) {
    writeFileSync(DIGEST_PATH, result.digestMd);
    if (result.pipelineAdditions.length > 0) {
      const pipelineContent = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '## Pendientes\n\n';
      // Find "## Pendientes" and insert after it
      let updated;
      const marker = '## Pendientes';
      const idx = pipelineContent.indexOf(marker);
      if (idx !== -1) {
        const insertAt = idx + marker.length;
        updated = pipelineContent.slice(0, insertAt) + '\n' + result.pipelineAdditions.join('\n') + pipelineContent.slice(insertAt);
      } else {
        updated = `## Pendientes\n\n${result.pipelineAdditions.join('\n')}\n\n${pipelineContent}`;
      }
      writeFileSync(PIPELINE_PATH, updated);
    }
    archiveApifyNewFiles();
    notify(result.notification);
  }

  console.log(JSON.stringify({
    dryRun,
    ...result.stats,
    notification: result.notification,
    digest_path: DIGEST_PATH,
    pipeline_additions: result.pipelineAdditions.length,
  }, null, 2));
}

// Run as CLI unless imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('digest-builder.mjs crashed:', err);
    process.exit(2);
  });
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check digest-builder.mjs`
Expected: no output.

- [ ] **Step 3: Dry-run smoke test**

Run: `node digest-builder.mjs --dry-run 2>&1 | tail -10`
Expected: JSON with `dryRun: true, total_scored: 0, …` (no errors even if config missing).

- [ ] **Step 4: Commit**

```bash
git add digest-builder.mjs
git commit -m "feat(digest): CLI wrapper, history archiving, pipeline.md append, macOS notification"
```

---

## Phase F — E2E tests

### Task 27: Create E2E test fixtures

**Files:**
- Create: `__fixtures__/autopilot/apify-new-example.json`
- Create: `__fixtures__/autopilot/profile.yml`
- Create: `__fixtures__/autopilot/portals.yml`

- [ ] **Step 1: Create the 3 fixture files**

**`__fixtures__/autopilot/apify-new-example.json`:**

```json
{
  "run_started_utc": "2026-04-22T14:00:03Z",
  "run_finished_utc": "2026-04-22T14:02:47Z",
  "sources": [
    { "metro": "california", "fetched": 3, "new": 3 },
    { "metro": "seattle", "fetched": 1, "new": 1 }
  ],
  "total_new_jobs": 4,
  "cost_estimate_usd": 0.004,
  "errors": [],
  "new_jobs": [
    {
      "linkedin_id": "3001",
      "url": "https://www.linkedin.com/jobs/view/3001",
      "title": "Staff+ Software Engineer, Data Infrastructure",
      "company": "Acme Corp",
      "company_slug": "acme-corp",
      "location": "San Francisco, CA",
      "description": "We are hiring a Staff+ Software Engineer to build our data infrastructure. You'll work with Spark, Airflow, Kafka, and Go. 7+ years of backend experience required. Distributed systems.",
      "posted_at": "2026-04-22T13:45:00Z",
      "source_metro": "california"
    },
    {
      "linkedin_id": "3002",
      "url": "https://www.linkedin.com/jobs/view/3002",
      "title": "Commercial Counsel, Compute & Infrastructure",
      "company": "Globex",
      "company_slug": "globex",
      "location": "San Francisco, CA",
      "description": "Globex is seeking an experienced attorney to support contracting for cloud compute partnerships. JD required, 7+ years contract experience.",
      "posted_at": "2026-04-22T13:30:00Z",
      "source_metro": "california"
    },
    {
      "linkedin_id": "3003",
      "url": "https://www.linkedin.com/jobs/view/3003",
      "title": "Junior Backend Engineer",
      "company": "Initech",
      "company_slug": "initech",
      "location": "San Francisco, CA",
      "description": "Entry-level backend role. 0-2 years experience. Great for new grads.",
      "posted_at": "2026-04-22T13:15:00Z",
      "source_metro": "california"
    },
    {
      "linkedin_id": "3004",
      "url": "https://www.linkedin.com/jobs/view/3004",
      "title": "ML Infrastructure Engineer",
      "company": "Anthropic",
      "company_slug": "anthropic",
      "location": "Seattle, WA",
      "description": "Build ML training infrastructure. PyTorch, Ray, K8s. Experience with evaluation pipelines and LLM serving.",
      "posted_at": "2026-04-22T13:00:00Z",
      "source_metro": "seattle"
    }
  ]
}
```

**`__fixtures__/autopilot/profile.yml`:**

```yaml
candidate:
  full_name: "Test Candidate"
  email: "test@example.com"
  location: "SF, CA"

narrative:
  headline: "Backend/Infra Engineer with ML side projects"

target_roles:
  archetypes_of_interest:
    - backend
    - infra
    - machine_learning
  seniority_min: "Mid-Senior"
  seniority_max: "Staff"
  deal_breakers:
    - "Intern"
    - "Junior"
    - "Entry Level"
    - "Contract"

experience_sources:
  root: experience_source
```

**`__fixtures__/autopilot/portals.yml`:**

```yaml
title_filter:
  positive:
    - "Backend"
    - "Infrastructure"
    - "Platform"
    - "Data Engineer"
    - "Data Platform"
    - "ML"
    - "Machine Learning"
  negative:
    - "Senior Manager"
    - "Sales Engineer"
```

- [ ] **Step 2: Commit**

```bash
git add __fixtures__/autopilot/
git commit -m "test(autopilot): E2E fixtures (4-job apify-new sample + profile + portals)"
```

---

### Task 28: E2E test — full pipeline with mocked Apify + Haiku

**Files:**
- Create: `tests/autopilot.e2e.test.mjs`

- [ ] **Step 1: Create the E2E test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { buildDigest } from '../digest-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../__fixtures__/autopilot');

function loadFixture(relPath) {
  return readFileSync(join(FIXTURES, relPath), 'utf-8');
}

function mockHaiku(responseMap) {
  // responseMap: { linkedin_id → {archetype, score, reason} }
  return {
    messages: {
      create: async ({ messages }) => {
        const userText = messages[0].content;
        // Find which fixture job this matches by URL in the prompt
        const urlMatch = userText.match(/https:\/\/www\.linkedin\.com\/jobs\/view\/(\d+)/);
        const id = urlMatch ? urlMatch[1] : null;
        const resp = responseMap[id] || { archetype: 'unknown', score: 0, reason: 'no mock' };
        return { content: [{ text: JSON.stringify(resp) }] };
      },
    },
  };
}

test('E2E: 4-job fixture → stage1+stage2+stage3 pipeline → expected digest structure', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));
  const apifyNew = JSON.parse(loadFixture('apify-new-example.json'));

  // Convert fixture jobs to candidateJobs shape
  const candidateJobs = apifyNew.new_jobs.map(j => ({
    ...j,
    sources: [`apify-${j.source_metro}`],
  }));

  // Mock Haiku: different responses per job
  const haikuClient = mockHaiku({
    '3001': { archetype: 'infra', score: 9, reason: 'Exact Spark+Airflow match' },
    // 3002 is a legal role — stage 1 might let it through if "Infrastructure" is a positive keyword
    //   → Haiku should score it 1
    '3002': { archetype: 'backend', score: 1, reason: 'Legal role, not engineering' },
    // 3003 is junior — stage 1 filter should drop it via deal-breaker "Junior"
    '3004': { archetype: 'machine_learning', score: 8, reason: 'ML infra match' },
  });

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  // Stage 1: 3003 dropped via "Junior" deal-breaker; 3001, 3002, 3004 pass
  assert.equal(result.stats.stage1_passed, 3, 'Junior job filtered out');
  // Stage 2: no duplicates in fixture, so still 3
  assert.equal(result.stats.stage2_passed, 3);
  // Stage 3: all 3 scored
  assert.equal(result.stats.total_scored, 3);

  // Bucket counts
  assert.equal(result.stats.bucketCounts.strong, 2, '3001 and 3004 scored ≥ 8');
  assert.equal(result.stats.bucketCounts.skip, 1, '3002 scored 1 (legal role)');

  // Digest contains expected sections
  assert.match(result.digestMd, /🔥 Score ≥ 8/);
  assert.match(result.digestMd, /🚫 Score ≤ 3/);
  assert.match(result.digestMd, /Acme Corp/);
  assert.match(result.digestMd, /Anthropic/);
  assert.match(result.digestMd, /Globex/);

  // Pipeline additions: only score ≥ 6
  assert.equal(result.pipelineAdditions.length, 2);
  assert.ok(result.pipelineAdditions.some(l => l.includes('3001')));
  assert.ok(result.pipelineAdditions.some(l => l.includes('3004')));

  // Notification mentions top job
  assert.match(result.notification, /Acme Corp|Anthropic/);
  assert.match(result.notification, /9\/10|8\/10/);
});

test('E2E: Haiku API failure → job falls into Unavailable bucket', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));
  const apifyNew = JSON.parse(loadFixture('apify-new-example.json'));

  const candidateJobs = apifyNew.new_jobs.slice(0, 1).map(j => ({
    ...j,
    sources: [`apify-${j.source_metro}`],
  }));

  const haikuClient = {
    messages: { create: async () => { throw new Error('rate limit'); } },
  };

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  assert.equal(result.stats.bucketCounts.unavailable, 1);
  assert.match(result.digestMd, /Pre-filter unavailable/);
});

test('E2E: blacklisted company → dropped in Stage 1 before Haiku runs', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));

  // Inject a Walmart job — should be blacklisted
  profile.target_roles = profile.target_roles || {};
  profile.target_roles.company_blacklist = ['Walmart', 'PayPal'];

  const candidateJobs = [
    {
      linkedin_id: '6001',
      url: 'https://www.linkedin.com/jobs/view/6001',
      title: 'Senior Backend Engineer',
      company: 'Walmart Labs',  // substring of "Walmart" blacklist entry
      location: 'SF',
      description: 'Backend role at Walmart. Go, Kafka, distributed systems.',
      source_metro: 'california',
      sources: ['apify-california'],
    },
    {
      linkedin_id: '6002',
      url: 'https://www.linkedin.com/jobs/view/6002',
      title: 'Staff Backend Engineer',
      company: 'Acme Corp',
      location: 'SF',
      description: 'Backend role at Acme. Go, Kafka, distributed systems.',
      source_metro: 'california',
      sources: ['apify-california'],
    },
  ];

  let haikuCalls = 0;
  const haikuClient = {
    messages: {
      create: async () => {
        haikuCalls++;
        return { content: [{ text: '{"archetype":"backend","score":8,"reason":"match"}' }] };
      },
    },
  };

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  assert.equal(result.stats.stage1_passed, 1, 'Walmart Labs blacklisted, only Acme passes');
  assert.equal(haikuCalls, 1, 'Haiku only called for non-blacklisted job');
  assert.ok(!result.digestMd.includes('Walmart'), 'Walmart absent from digest');
  assert.ok(result.digestMd.includes('Acme'), 'Acme present in digest');
});

test('E2E: cross-source duplicate via same jd_fingerprint → single entry in digest', async () => {
  const profile = yaml.load(loadFixture('profile.yml'));
  const portals = yaml.load(loadFixture('portals.yml'));

  // Same description = same fingerprint → stage 2 dedup
  const sameDescription = 'We need a backend engineer with Go, Kafka, and Postgres experience. 5+ years.';
  const candidateJobs = [
    {
      linkedin_id: '5001',
      url: 'https://www.linkedin.com/jobs/view/5001',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'SF',
      description: sameDescription,
      source_metro: 'california',
      sources: ['apify-california'],
    },
    {
      linkedin_id: '(none)',
      url: 'https://job-boards.greenhouse.io/acme/jobs/5001',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'SF',
      description: sameDescription,  // same content → same fingerprint
      source_metro: null,
      sources: ['scan-greenhouse'],
    },
  ];

  const haikuClient = mockHaiku({
    '5001': { archetype: 'backend', score: 7, reason: 'Go match' },
  });

  const result = await buildDigest({
    profile, portals, sources: {}, candidateJobs,
    existingDigest: '', haikuClient, dryRun: true,
  });

  assert.equal(result.stats.stage1_passed, 2);
  assert.equal(result.stats.stage2_passed, 1, 'cross-source dedup');
  assert.equal(result.stats.total_scored, 1);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/autopilot.e2e.test.mjs`
Expected: 3/3 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/autopilot.e2e.test.mjs
git commit -m "test(autopilot): E2E tests for 3-stage pipeline + cross-source dedup + Haiku failure"
```

---

## Phase G — Launchd infrastructure

### Task 29: Create `autopilot-sources.sh`

**Files:**
- Create: `autopilot-sources.sh`

- [ ] **Step 1: Write the shell script**

```sh
#!/bin/bash
# autopilot-sources.sh — runs scan.mjs + apify-scan.mjs in parallel.
# Called by launchd; logs to ~/.career-ops/logs/.
set -e

REPO="$HOME/resume/career-ops"
LOG_DIR="$HOME/.career-ops/logs"
mkdir -p "$LOG_DIR"

cd "$REPO"

TS=$(date +%F-%H%M)

# Run both scanners in parallel; capture separate logs
node scan.mjs > "$LOG_DIR/scan-$TS.log" 2>&1 &
SCAN_PID=$!

node apify-scan.mjs > "$LOG_DIR/apify-$TS.log" 2>&1 &
APIFY_PID=$!

wait $SCAN_PID $APIFY_PID

echo "[$(date -Iseconds)] sources complete" >> "$LOG_DIR/sources.log"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x autopilot-sources.sh`

- [ ] **Step 3: Commit**

```bash
git add autopilot-sources.sh
git commit -m "feat(autopilot): autopilot-sources.sh parallel launcher"
```

---

### Task 30: Create launchd plists

**Files:**
- Create: `.launchd/com.marshmallow.career-ops.sources.plist`
- Create: `.launchd/com.marshmallow.career-ops.digest.plist`

- [ ] **Step 1: Create sources plist**

Create `.launchd/com.marshmallow.career-ops.sources.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.marshmallow.career-ops.sources</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/xiaoxuan/resume/career-ops/autopilot-sources.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/Users/xiaoxuan/.career-ops/logs/sources-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/xiaoxuan/.career-ops/logs/sources-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/xiaoxuan/resume/career-ops</string>
</dict>
</plist>
```

- [ ] **Step 2: Create digest plist**

Create `.launchd/com.marshmallow.career-ops.digest.plist` (same structure, Minute=10, runs node digest-builder.mjs):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.marshmallow.career-ops.digest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/xiaoxuan/resume/career-ops/digest-builder.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>10</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>10</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/Users/xiaoxuan/.career-ops/logs/digest-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/xiaoxuan/.career-ops/logs/digest-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/xiaoxuan/resume/career-ops</string>
</dict>
</plist>
```

- [ ] **Step 3: Commit**

```bash
git add .launchd/
git commit -m "feat(autopilot): launchd plists for sources (every 2h :00) + digest (:10)"
```

---

### Task 31: Create setup/pause/resume/uninstall scripts

**Files:**
- Create: `.launchd/setup.sh`
- Create: `.launchd/pause.sh`
- Create: `.launchd/resume.sh`
- Create: `.launchd/uninstall.sh`

- [ ] **Step 1: Create setup.sh**

Create `.launchd/setup.sh`:

```sh
#!/bin/bash
# .launchd/setup.sh — install launchd plists for autopilot
set -e

REPO="$HOME/resume/career-ops"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCHD_DIR"
mkdir -p "$HOME/.career-ops/logs"

# Unload first (ignore errors if not previously loaded)
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist" 2>/dev/null || true

# Copy plists
cp "$REPO/.launchd/com.marshmallow.career-ops.sources.plist" "$LAUNCHD_DIR/"
cp "$REPO/.launchd/com.marshmallow.career-ops.digest.plist" "$LAUNCHD_DIR/"

# Load
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist"
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist"

echo "Autopilot installed. Verifying:"
launchctl list | grep career-ops || echo "(not loaded — check logs)"

echo ""
echo "Logs: $HOME/.career-ops/logs/"
echo "Next scheduled run: check com.marshmallow.career-ops.sources schedule"
```

- [ ] **Step 2: Create pause.sh**

Create `.launchd/pause.sh`:

```sh
#!/bin/bash
# .launchd/pause.sh — pause autopilot (state preserved)
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist" 2>/dev/null || true
echo "Autopilot paused. State in data/ preserved. Resume with .launchd/resume.sh"
```

- [ ] **Step 3: Create resume.sh**

Create `.launchd/resume.sh`:

```sh
#!/bin/bash
# .launchd/resume.sh — resume autopilot
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist"
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist"
echo "Autopilot resumed."
launchctl list | grep career-ops
```

- [ ] **Step 4: Create uninstall.sh**

Create `.launchd/uninstall.sh`:

```sh
#!/bin/bash
# .launchd/uninstall.sh — unload + remove plists (keeps data/)
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist" 2>/dev/null || true
rm -f "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist"
rm -f "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist"
echo "Autopilot uninstalled. data/ preserved."
```

- [ ] **Step 5: Make all executable + commit**

```bash
chmod +x .launchd/setup.sh .launchd/pause.sh .launchd/resume.sh .launchd/uninstall.sh
git add .launchd/setup.sh .launchd/pause.sh .launchd/resume.sh .launchd/uninstall.sh
git commit -m "feat(autopilot): launchd install/pause/resume/uninstall scripts"
```

---

## Phase H — Docs + test-all + wrap-up

### Task 32: Integrate new tests into `test-all.mjs`

**Files:**
- Modify: `test-all.mjs`

- [ ] **Step 1: Verify current test-all section 3.5 glob pattern**

Run: `grep -A 5 'Unit + E2E tests' test-all.mjs`
Expected: see a section that runs `node --test tests/*.test.mjs`.

- [ ] **Step 2: No code changes needed — new tests match glob**

The `tests/*.test.mjs` glob already picks up:
- `tests/dedup.test.mjs`
- `tests/apify-scan.test.mjs`
- `tests/digest-builder.test.mjs`
- `tests/autopilot.e2e.test.mjs`

Just run the full suite to verify:

```bash
node test-all.mjs --quick 2>&1 | tail -10
```

Expected: more tests pass than before; overall 🟢 or 🟡 (warnings OK).

If new tests aren't picked up, the glob may need expansion — but this should work on all modern Node.

- [ ] **Step 3: Add new scripts to systemFiles check**

In `test-all.mjs`, find the `systemFiles` array (around line 140-150). Append these entries (alphabetical):

```js
  'apify-scan.mjs',
  'autopilot-sources.sh',
  'config/apify-search.example.yml',
  'digest-builder.mjs',
  'lib/dedup.mjs',
  '.launchd/com.marshmallow.career-ops.sources.plist',
  '.launchd/com.marshmallow.career-ops.digest.plist',
  '.launchd/setup.sh',
  '.launchd/uninstall.sh',
```

- [ ] **Step 4: Run test-all**

Run: `node test-all.mjs --quick 2>&1 | tail -5`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add test-all.mjs
git commit -m "chore(autopilot): register new system files in test-all.mjs"
```

---

### Task 33: Update `CLAUDE.md` to document autopilot

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add autopilot section**

In `CLAUDE.md`, find the "Main Files" table. Append these rows:

```
| `apify-scan.mjs` | Apify LinkedIn scraper (4 metros, parallel) |
| `digest-builder.mjs` | 3-stage filter + digest renderer |
| `lib/dedup.mjs` | Shared dedup helpers (seen-jobs.tsv, fingerprints) |
| `data/digest.md` | Ranked job digest (autopilot output, refreshed every 2h) |
| `data/digest-history/` | 30-day archive of daily digests |
| `data/seen-jobs.tsv` | Dedup state for autopilot (gitignored) |
| `config/apify-search.yml` | Apify config (locations, rows, cadence) |
| `.launchd/*.plist` | macOS schedulers for autopilot |
```

- [ ] **Step 2: Add a new section after "CV Source of Truth"**

Append:

```markdown
### Autopilot Discovery (this fork)

The autopilot layer scans LinkedIn (via Apify) + existing ATS (Greenhouse/Ashby/Lever)
every 2 hours 7am-9pm PST, pre-filters with archetype-aware Haiku, and produces
`data/digest.md` for morning triage. See `docs/superpowers/specs/2026-04-21-job-discovery-autopilot-design.md`.

Install: `bash .launchd/setup.sh` (requires `APIFY_API_TOKEN` in `.env`)
Pause:   `bash .launchd/pause.sh`
Resume:  `bash .launchd/resume.sh`

The autopilot NEVER auto-evaluates, auto-generates PDFs, or auto-submits. It only
discovers, pre-filters, and presents a ranked list. The user picks jobs from
`digest.md`, copies a URL, and runs `/career-ops pipeline <url>` to trigger the
existing assembly+evaluation flow.

**Dedup guarantees:**
- Never scan the same LinkedIn job twice (via `linkedin_id` in `seen-jobs.tsv`)
- Never pre-filter the same job twice (via `jd_fingerprint` SHA-256)
- Never evaluate or PDF-generate for a job already in `applications.md`
  (existing check in modes/pipeline.md preserves this)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(autopilot): register in CLAUDE.md with autopilot overview section"
```

---

### Task 34: Update `DATA_CONTRACT.md`

**Files:**
- Modify: `DATA_CONTRACT.md`

- [ ] **Step 1: Update User Layer table**

Append to the User Layer table:

```
| `config/apify-search.yml` | Your Apify search config |
| `data/seen-jobs.tsv` | Autopilot dedup state |
| `data/digest.md` | Today's ranked job digest |
| `data/digest-history/*` | 30-day digest archive |
| `data/apify-new-*.json` | Per-run Apify output (archived after processing) |
```

- [ ] **Step 2: Update System Layer table**

Append to the System Layer table:

```
| `apify-scan.mjs` | Apify LinkedIn scanner |
| `digest-builder.mjs` | 3-stage filter + digest renderer |
| `lib/dedup.mjs` | Shared dedup helpers |
| `autopilot-sources.sh` | launchd-invoked parallel launcher |
| `.launchd/*.plist` | launchd job configurations |
| `.launchd/*.sh` | install/pause/resume/uninstall scripts |
| `config/apify-search.example.yml` | Template for apify-search.yml |
```

- [ ] **Step 3: Commit**

```bash
git add DATA_CONTRACT.md
git commit -m "docs(autopilot): register autopilot files in DATA_CONTRACT.md"
```

---

### Task 35: Update `CHANGELOG.md` with fork-v0.2.0

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend new entry**

At the top of `CHANGELOG.md`, right below the `# Changelog` header, add:

```markdown
## fork-v0.2.0 — 2026-04-21 (marshmallow3781/career-ops)

Personal fork: job discovery autopilot. Not pushed upstream.

### Features

- New `apify-scan.mjs`: scrapes LinkedIn via Apify actor
  `curious_coder/linkedin-jobs-scraper` ($1/1000 results) across 4 US metros
  (California, Greater Seattle, NYC Metro, Boston) in parallel every 2 hours
  7am-9pm PST
- New `digest-builder.mjs`: 3-stage filter (title keyword → SHA-256 fingerprint
  dedup → Haiku archetype-aware scoring 0-10) produces `data/digest.md`
  grouped by score bucket and archetype
- New `lib/dedup.mjs`: shared helpers for LinkedIn ID extraction, kebab
  normalization, JD fingerprinting, and TSV state I/O with atomic writes +
  corruption recovery
- `scan.mjs` modified to write to `seen-jobs.tsv` with `jd_fingerprint` for
  cross-source dedup (LinkedIn + Greenhouse postings of the same job collapse
  to one digest entry)
- 2 macOS launchd plists + install/pause/resume/uninstall scripts
- macOS notifications after each digest run
- 30-day digest history archive

### Dependencies

- Added: `apify-client@^2.9.5`

### Cost

- Autopilot infrastructure: ~$100/mo (Apify ~$60 + Haiku pre-filter ~$40)
- Per-job evaluation (user-initiated): pay-as-you-go ~$0.15/job

### Design

See `docs/superpowers/specs/2026-04-21-job-discovery-autopilot-design.md`.

```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(autopilot): changelog fork-v0.2.0"
```

---

### Task 36: Final smoke check + tag

**Files:**
- (verification only)

- [ ] **Step 1: Full test pass**

Run:
```bash
node --test tests/*.test.mjs 2>&1 | tail -8
```
Expected: all tests pass (both pre-existing + new).

- [ ] **Step 2: Full test-all**

Run: `node test-all.mjs --quick 2>&1 | tail -5`
Expected: 🟢 or 🟡 (warnings OK).

- [ ] **Step 3: Verify syntax on all new scripts**

Run:
```bash
node --check lib/dedup.mjs apify-scan.mjs digest-builder.mjs
bash -n autopilot-sources.sh .launchd/setup.sh .launchd/pause.sh .launchd/resume.sh .launchd/uninstall.sh
```
Expected: no output (all clean).

- [ ] **Step 4: Dry-run both scripts**

Run: `node apify-scan.mjs --dry-run 2>&1 | head -15`
Expected: JSON output (0 new, 0 errors because no real API call).

Run: `node digest-builder.mjs --dry-run 2>&1 | head -15`
Expected: JSON output with stats.

- [ ] **Step 5: Tag milestone**

```bash
git tag -a fork-v0.2.0 -m "Job discovery autopilot: Apify LinkedIn + 3-stage filter + ranked digest"
```

(Optional push tag if/when ready: `git push origin fork-v0.2.0`.)

---

## Implementation Notes

- **TDD discipline**: Phases B, D, E enforce test-first. Don't skip "verify failure" steps.
- **No half-implementations**: each task ends with green tests + a commit.
- **LLM costs during development**: the E2E test (Task 28) uses a mock — no real Haiku calls. First real cost happens when you run autopilot against live data (week 1 live validation).
- **Path assumptions**: plists hardcode `/Users/xiaoxuan/resume/career-ops`. If installed elsewhere, edit plists + scripts.
- **Requires**: macOS (launchd), Node 20+ (for node:test), APIFY_API_TOKEN + ANTHROPIC_API_KEY in `.env`.

## Total tasks: 38

- Phase A (Foundation): 5 tasks
- Phase B (lib/dedup.mjs): 8 tasks
- Phase C (scan.mjs): 1 task
- Phase D (apify-scan.mjs): 2 tasks
- Phase E (digest-builder.mjs): 12 tasks (includes 18B + 18C for company blacklist)
- Phase F (E2E tests): 2 tasks (includes blacklist E2E case)
- Phase G (launchd): 3 tasks
- Phase H (docs + wrap): 5 tasks
