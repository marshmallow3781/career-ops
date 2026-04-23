# scan.mjs Location Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side `location_filter` to `scan.mjs` (Greenhouse/Ashby/Lever scanner) so international postings drop out before dedup/write; update the tracked `portals.yml` template accordingly and remove the broken Netlify entry.

**Architecture:** New `buildLocationFilter(cfg)` pure helper + one filter check in the fetch loop + one counter in the summary. No Mongo involvement. Same shape as the existing `buildTitleFilter` and the `filterByPostedAt` time-window helper added earlier (commit `e22764a`).

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, no new deps.

**Spec reference:** `docs/superpowers/specs/2026-04-23-scan-location-filter-design.md` (commit `da502b5`).

---

## File Structure

### Files modified
- `scan.mjs` — new `buildLocationFilter` helper, wired into `main()`, new counter in summary output.
- `templates/portals.example.yml` — add `location_filter:` block, remove Netlify entry.

### Files created
- `tests/scan.mjs` — new unit-test file for `buildLocationFilter` (9 cases).

### Not in scope
- `portals.yml` in the user's repo is gitignored. The user updates their live file manually after this plan lands by copying the `location_filter:` block from the example template and removing their Netlify entry. This plan does not commit or try to edit the gitignored file.

---

## Task 1: `buildLocationFilter` + unit tests

**Files:**
- Create: `tests/scan.mjs`
- Modify: `scan.mjs` — add `buildLocationFilter` helper near `buildTitleFilter` + export for tests

### TDD

- [ ] **Step 1: Create failing test file**

Create `/Users/xiaoxuan/resume/career-ops/tests/scan.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationFilter } from '../scan.mjs';

test('buildLocationFilter: empty config → permissive (everything passes)', () => {
  const f = buildLocationFilter(undefined);
  assert.equal(f('San Francisco, CA'), true);
  assert.equal(f('London, UK'), true);
  assert.equal(f(null), true);
});

test('buildLocationFilter: empty allow list → permissive', () => {
  const f = buildLocationFilter({ allow: [], deny: ['Remote - EU'] });
  assert.equal(f('London, UK'), true);
  // deny is ignored when allow is empty — matches "no-op when not configured"
});

test('buildLocationFilter: allow match passes', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: [] });
  assert.equal(f('San Francisco, CA'), true);
});

test('buildLocationFilter: deny wins over allow', () => {
  const f = buildLocationFilter({ allow: ['Remote'], deny: ['Remote - EU'] });
  assert.equal(f('Remote - EU'), false);
  assert.equal(f('Remote'), true);  // bare Remote still passes
});

test('buildLocationFilter: case-insensitive', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: [] });
  assert.equal(f('san francisco, ca'), true);
  assert.equal(f('SAN FRANCISCO, CA'), true);
});

test('buildLocationFilter: multi-location pipe-separated string', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: ['London'] });
  assert.equal(f('San Francisco, CA | Paris, France'), true);   // allow match, no deny
  assert.equal(f('San Francisco, CA | London, UK'), false);     // deny wins
});

test('buildLocationFilter: DC carve-out (Washington allow + Washington, DC deny)', () => {
  const f = buildLocationFilter({ allow: ['Washington'], deny: ['Washington, DC'] });
  assert.equal(f('Seattle, Washington'), true);
  assert.equal(f('Washington, DC'), false);
});

test('buildLocationFilter: missing location → drop (fail closed)', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: [] });
  assert.equal(f(null), false);
  assert.equal(f(undefined), false);
  assert.equal(f(''), false);
});

test('buildLocationFilter: no allow match → drop', () => {
  const f = buildLocationFilter({ allow: [', CA', ', WA'], deny: [] });
  assert.equal(f('Austin, TX'), false);
  assert.equal(f('New York City, NY'), false);
});
```

- [ ] **Step 2: Run tests, confirm FAIL**

```bash
cd /Users/xiaoxuan/resume/career-ops && node --test tests/scan.mjs
```

Expected: fails with `SyntaxError: The requested module '../scan.mjs' does not provide an export named 'buildLocationFilter'`.

- [ ] **Step 3: Add `buildLocationFilter` to scan.mjs**

Open `/Users/xiaoxuan/resume/career-ops/scan.mjs`. Find the existing `buildTitleFilter` function (around line 130-140). Immediately after `buildTitleFilter`, add:

```js
/**
 * Build a predicate that tests whether a job's location string passes the
 * allow/deny substring rules. Case-insensitive.
 *
 * Semantics (per spec §5):
 * - Missing allow list → permissive (everything passes; graceful degradation
 *   when portals.yml omits location_filter).
 * - Missing or empty location → fail closed (can't verify US-ok without a
 *   string).
 * - Pass iff (any allow substring matches) AND (no deny substring matches).
 * - Deny wins: `"Remote - EU"` with allow=[`"Remote"`] deny=[`"Remote - EU"`]
 *   → false.
 * - Multi-location pipe-separated strings (e.g. `"SF, CA | London, UK"`):
 *   the substring check runs against the whole string, so any allow match
 *   anywhere in the string passes — unless a deny substring is present.
 */
export function buildLocationFilter(cfg) {
  const allow = (cfg?.allow || []).map(s => s.toLowerCase());
  const deny  = (cfg?.deny  || []).map(s => s.toLowerCase());
  if (allow.length === 0) return () => true;
  return (location) => {
    if (!location || typeof location !== 'string') return false;
    const lc = location.toLowerCase();
    if (deny.some(d => lc.includes(d))) return false;
    return allow.some(a => lc.includes(a));
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd /Users/xiaoxuan/resume/career-ops && node --test tests/scan.mjs
```

Expected: `# pass 9  # fail 0`

- [ ] **Step 5: Commit**

```bash
cd /Users/xiaoxuan/resume/career-ops
git add scan.mjs tests/scan.mjs
git commit -m "feat(scan): buildLocationFilter helper with allow/deny substring rules"
```

---

## Task 2: Wire location filter into `main()`

**Files:**
- Modify: `scan.mjs` — instantiate the filter, apply in the fetch loop, add counter + summary row.

### Changes

- [ ] **Step 1: Build the location filter in `main()`**

Open `/Users/xiaoxuan/resume/career-ops/scan.mjs`. Find the block in `main()` where `titleFilter` is built (grep for `const titleFilter = buildTitleFilter`). Immediately after that line, add:

```js
  const locationFilter = buildLocationFilter(config.location_filter);
```

- [ ] **Step 2: Add `totalLocationFiltered` counter**

Find the block where counters are initialized (grep for `let totalFiltered = 0`). Add a new counter right after `totalStale`:

```js
  let totalStale = 0;
  let totalLocationFiltered = 0;   // NEW
```

- [ ] **Step 3: Insert filter check in the fetch loop**

Find the per-job processing loop inside the `tasks.map(company => async () => { ... })`. After the `if (!titleFilter(job.title)) { totalFiltered++; continue; }` block and before the dedup/seen-set logic, insert:

```js
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!locationFilter(job.location)) {         // NEW
          totalLocationFiltered++;                    // NEW
          continue;                                   // NEW
        }
```

(Location filter comes before the seen-URL and company-role dedup checks, so dropped jobs don't waste dedup-set memory. The `filterByPostedAt` time-window filter added in commit `e22764a` runs at the top of the task fn, before this loop — don't re-order.)

- [ ] **Step 4: Add summary row**

Find the summary-block `console.log(...)` calls (grep for `Filtered by title:`). Insert a new line right before the `Filtered by title:` row:

```js
  console.log(`Outside location:      ${totalLocationFiltered} skipped (no allow match OR deny match)`);
  console.log(`Outside time window:   ${totalStale} skipped (posted_at older than ${sinceHours}h)`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
```

- [ ] **Step 5: Run all tests to catch regressions**

```bash
cd /Users/xiaoxuan/resume/career-ops && node --test tests/scan.mjs tests/*.test.mjs
```

Expected: all tests pass (including the 9 new scan.mjs tests + any existing `tests/*.test.mjs`).

- [ ] **Step 6: Commit**

```bash
cd /Users/xiaoxuan/resume/career-ops
git add scan.mjs
git commit -m "feat(scan): wire location filter into main() + summary counter"
```

---

## Task 3: Update `templates/portals.example.yml`

**Files:**
- Modify: `templates/portals.example.yml` — add `location_filter:` block, remove Netlify entry.

### Changes

- [ ] **Step 1: Read the current template**

```bash
cd /Users/xiaoxuan/resume/career-ops && grep -n "title_filter\|location_filter\|Netlify\|tracked_companies" templates/portals.example.yml | head -20
```

This tells you where `title_filter` ends (so you know where to insert `location_filter`) and where the Netlify entry is (so you know what to delete).

- [ ] **Step 2: Add the `location_filter` block**

After the `title_filter:` block ends in `templates/portals.example.yml` (after the closing of its `negative:` list) and before `tracked_companies:`, insert:

```yaml
location_filter:
  # Bay Area + rest of California (via state match) + Washington State
  # (via state match + Seattle-metro cities). Drops international offices.
  # Substring match, case-insensitive. Deny wins over allow.
  # Empty list = no filter.
  allow:
    # California (all cities in any format)
    - "California"
    - ", CA"
    # Washington State (all cities in any format)
    - "Washington"
    - ", WA"
    # Remote variants — deny-list carves out non-US below
    - "Remote"
    - "US Remote"
    - "Remote - US"
    - "Remote (United States)"
    - "Remote, United States"
  deny:
    # DC is "Washington" without being in Washington State — carve out.
    - "Washington, DC"
    - "Washington D.C."
    - "Washington DC"
    # Non-US remotes (deny wins over "Remote" allow-match).
    - "Remote - EU"
    - "Remote - EMEA"
    - "Remote - Europe"
    - "Remote - Canada"
    - "Remote - India"
    - "Remote - UK"
    - "Remote - Ireland"
    - "Remote, Canada"
    - "Remote, UK"
    - "Remote, India"
    - "Remote, Germany"
    - "Remote, Brazil"
```

- [ ] **Step 3: Remove the Netlify entry**

Still in `templates/portals.example.yml`, find the Netlify block and delete it. The exact text varies slightly (look for `name: Netlify`), but the typical shape is:

```yaml
  - name: Netlify
    careers_url: https://jobs.lever.co/netlify
    enabled: true
```

Delete those three lines. If there's a preceding comment like `# Lever-hosted (if any known ones)` that only applies to Netlify, delete that too.

- [ ] **Step 4: Verify YAML still parses**

```bash
cd /Users/xiaoxuan/resume/career-ops && node -e "const y=require('js-yaml'); const fs=require('fs'); const d=y.load(fs.readFileSync('templates/portals.example.yml','utf-8')); console.log('title_filter allow:', (d.title_filter?.positive||[]).length, 'location_filter allow:', (d.location_filter?.allow||[]).length, 'tracked_companies:', (d.tracked_companies||[]).length, 'Netlify present?:', (d.tracked_companies||[]).some(c => c.name === 'Netlify'))"
```

Expected output:
```
title_filter allow: <N>  location_filter allow: 9  tracked_companies: <M>  Netlify present?: false
```

(The exact N and M depend on the current template state; what matters is: `location_filter allow: 9` and `Netlify present?: false`.)

- [ ] **Step 5: Commit**

```bash
cd /Users/xiaoxuan/resume/career-ops
git add templates/portals.example.yml
git commit -m "feat(portals): add location_filter block + remove Netlify (broken Lever endpoint)"
```

---

## Task 4: Live verification

**Files:**
- No edits. Runtime validation only.

The user's live `portals.yml` is gitignored. Before this verification runs, **the user must manually copy the new `location_filter:` block from `templates/portals.example.yml` into their live `portals.yml` AND remove the Netlify entry from their live file.** Post a note to the user to do that first.

Once the user confirms their live `portals.yml` has the block + no Netlify, run:

- [ ] **Step 1: 24-hour dry-run**

```bash
cd /Users/xiaoxuan/resume/career-ops && node scan.mjs --dry-run --since-hours=24 2>&1 | head -30
```

Expected stdout shape:

```
Scanning 4 companies via API (0 skipped — no API detected)
Time window: last 24h (auto: ...)
(dry run — no files will be written)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Portal Scan — 2026-04-23
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Companies scanned:     4
Total jobs found:      <~500+ — Anthropic dominates>
Outside location:      <most — international postings>
Outside time window:   <varies>
Filtered by title:     <varies>
Duplicates:            <varies>
New offers added:      <~5>
```

Two things to verify:
1. The `Companies scanned: 4` line (not 5) confirms Netlify was removed.
2. The `Outside location: N skipped` line appears and N > 0 (proves the filter is wired in).

- [ ] **Step 2: 720-hour (30-day) dry-run for maximum signal**

```bash
cd /Users/xiaoxuan/resume/career-ops && node scan.mjs --dry-run --since-hours=720 2>&1 | head -10
```

Expected: `Outside location: N skipped` where N is a large fraction of `Total jobs found` (international offices dominate Anthropic's 448 open roles). Anthropic alone should drop ~60-80% on location.

- [ ] **Step 3: Inspect a few survivors**

Still in the output, the `New offers:` section should show only California / Washington / US-Remote postings. Verify no London/Dublin/Tokyo/Bangalore/etc. in the survivor list.

No commit for this task — it's verification only.

---

## Self-review checklist (implementer runs this at the end)

1. **All tests pass:** `cd /Users/xiaoxuan/resume/career-ops && node --test` → green (except the pre-existing Go dashboard failure in test-all.mjs, which is unrelated).
2. **No placeholder code:** `grep -n "TODO\|FIXME\|XXX" scan.mjs tests/scan.mjs` returns nothing new.
3. **Netlify gone:** `grep -n Netlify templates/portals.example.yml` returns nothing.
4. **Live dry-run produces the expected shape** per Task 4.

---

## Out of scope (do NOT implement in this plan)

- Migrating `scan.mjs` to Mongo (future).
- Location filtering for `apify-scan.mjs` (already scoped via `geoId`).
- Replacing Netlify with a non-Lever ATS slug (requires probing where Netlify now posts).
- Per-company location overrides.
- Editing the user's gitignored `portals.yml` directly — only the tracked template is touched by this plan.
