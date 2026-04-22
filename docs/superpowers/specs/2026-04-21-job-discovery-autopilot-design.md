# Job Discovery Autopilot — Design Spec

**Date:** 2026-04-21
**Status:** Draft, pending user review
**Author:** xiaoxuan (with Claude Code brainstorming session)
**Scope:** Personal fork of `santifer/career-ops` at `marshmallow3781/career-ops`. Not intended for upstream PR.
**Related spec:** `2026-04-21-experience-source-assembly-design.md` (CV tailoring, already implemented on `feat/experience-source-assembly`)

---

## 1. Context & Problem

Career-ops already has the "brain" for evaluating + tailoring CVs (the `experience-source-assembly` fork). What's missing is the "autopilot" layer that discovers new jobs automatically and surfaces them ranked by fit.

Today's manual workflow:
1. User periodically remembers to run `npm run scan`
2. Opens `data/pipeline.md` to see what's new
3. Decides what to evaluate, manually runs `/career-ops pipeline <url>`
4. Repeats

The gap: **discovery is manual and bursty; jobs on LinkedIn aren't scanned at all; nothing surfaces prioritized signals.**

## 2. Goals

Build an automated layer on top of career-ops that:
- **Discovers new jobs every 2 hours from 7am-9pm PST** across two sources:
  - Existing `scan.mjs` (Greenhouse/Ashby/Lever APIs for companies in `portals.yml`)
  - New `apify-scan.mjs` (LinkedIn via `curious_coder/linkedin-jobs-scraper`)
- **Pre-filters** with a cheap Haiku call so only likely matches reach the user's attention
- **Produces a ranked digest** grouped by archetype (backend/infra/ml/frontend/fullstack) that the user opens each morning and refreshes throughout the day
- **Deduplicates aggressively**: never see the same job twice, never pre-filter the same job twice, never generate a tailored CV for a job already generated for
- **Preserves human-in-the-loop**: autopilot never auto-evaluates, auto-generates PDFs, or auto-submits applications

## 3. Non-Goals

- Auto-submit applications (career-ops ethics, unchanged)
- Auto-generate tailored CVs without explicit user trigger
- Scrape LinkedIn without Apify (anti-bot is too hard without a specialized scraper)
- Use a relational database (TSV + in-memory `Set` is sufficient at this scale; upgrade path to SQLite if volume grows 10×)
- Cloud scheduling (runs on user's laptop via macOS launchd — matches personal-fork scope)
- Coverage of Workday, SmartRecruiters, Wellfound, or any ATS beyond what `scan.mjs` already handles
- Support for non-US locations in the Apify feed (4 US metros only: CA, Seattle, NY, Boston)

## 4. Key Decisions Summary

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Two sources run in parallel (scan.mjs + apify-scan.mjs), merged at one point | Each fails independently; scan.mjs catches cross-source dupes cheaply before Apify pre-filter runs |
| 2 | Apify actor `BHzefUZlZRKWxkTck` (curious_coder/linkedin-jobs-scraper) | User tested: $0.01 for 10 jobs, $0.10 for 100 jobs — linear $1/1000 pricing |
| 3 | 4 metros targeted separately, parallel calls | Each Apify call returns top-N *within that metro*; merging US-wide would cap coverage by LinkedIn's relevance ranking |
| 4 | Every 2h cadence 7am-9pm PST (8 runs/day) | Balance between freshness and cost; LinkedIn posting cadence doesn't require sub-2h granularity |
| 5 | Baseline 7am run uses r86400 (past 24h); subsequent runs use r7200 (past 2h overlap) | Baseline catches overnight backlog; 2h overlap prevents gaps on late/failed runs |
| 6 | 3-stage pre-filter: free title filter → fingerprint dedup → Haiku archetype-scoring | Keeps LLM cost proportional to genuinely interesting volume |
| 7 | Archetype-aware Haiku prompt with prompt caching (1h TTL) | Candidate is multi-facet (frontend/backend/infra/ml); pre-filter must score per job's archetype, not a fixed candidate role |
| 8 | `data/seen-jobs.tsv` with `jd_fingerprint` (SHA-256 of normalized body) | Catches cross-source duplicates (same LinkedIn + Greenhouse posting) cleanly |
| 9 | Residential proxy | Absorbed in actor's $1/1000 price; lower block rate than datacenter |
| 10 | No database — TSV + in-memory Set | At ~500 new jobs/day, state grows 15k rows/month; TSV load <200ms, O(1) lookups |
| 11 | 2 launchd plists (sources, digest) + shell launcher | Separates concerns cleanly; `:00` sources fire in parallel, `:10` digest-builder runs with 8-min buffer |
| 12 | macOS notifications via `osascript` | Lightweight; sufficient signal without building email/Slack integrations |
| 13 | Digest file-based (`data/digest.md`) updated incrementally | Matches career-ops file-based pattern; user edits checkbox to mark jobs for evaluation |

## 5. Architecture

### 5.1 Component diagram

```
                        ┌────────────────────────────────┐
                        │ macOS launchd (2 jobs)         │
                        │                                │
                        │ sources plist:  :00 at         │
                        │   7, 9, 11, 13, 15, 17, 19, 21 │
                        │   PST → autopilot-sources.sh   │
                        │                                │
                        │ digest plist:   :10 same hours │
                        │   → digest-builder.mjs         │
                        └──────────┬─────────────────────┘
                                   │
         ┌─────────────────────────┼──────────────────────────────┐
         ▼                         ▼                              ▼
┌──────────────────┐  ┌────────────────────────┐  ┌───────────────────────┐
│ scan.mjs         │  │ apify-scan.mjs (new)   │  │ digest-builder.mjs    │
│ (existing,       │  │                        │  │ (new)                 │
│  modified)       │  │ Actor:                 │  │                       │
│                  │  │   BHzefUZlZRKWxkTck    │  │ Stage 1: title filter │
│ Greenhouse /     │  │                        │  │ Stage 2: fingerprint  │
│ Ashby /          │  │ 4 locations parallel:  │  │          dedup        │
│ Lever            │  │   CA, Seattle, NY, BOS │  │ Stage 3: Haiku        │
│                  │  │                        │  │          archetype +  │
│ Writes →         │  │ Baseline (7am only):   │  │          score        │
│  pipeline.md     │  │   r86400, rows varies  │  │                       │
│  seen-jobs.tsv   │  │ Hourly (other runs):   │  │ Writes →              │
│                  │  │   r7200, rows varies   │  │  digest.md            │
│ ~20s / $0        │  │                        │  │  pipeline.md          │
│                  │  │ Writes →               │  │  digest-history/      │
│                  │  │  apify-new-{ts}.json   │  │  macOS notification   │
│                  │  │  seen-jobs.tsv         │  │                       │
│                  │  │                        │  │ ~1-3 min / ~$0.30     │
│                  │  │ ~1-3 min / ~$0.30      │  │                       │
└──────────────────┘  └────────────────────────┘  └───────────────────────┘
                                   │
                                   ▼
                     ┌────────────────────────────┐
                     │ data/seen-jobs.tsv         │
                     │ (single source of truth    │
                     │  for dedup, all sources)   │
                     └────────────────────────────┘
                                   │
                                   ▼
                     ┌────────────────────────────┐
                     │ data/digest.md             │ ← you open in editor
                     │ (ranked, updated every 2h) │
                     └──────────┬─────────────────┘
                                │ you check boxes / grab URLs
                                ▼
                     /career-ops pipeline <url>
                     (existing flow — A-G eval + tailored PDF)
```

### 5.2 Layer separation

| Layer | What lives here | Changes in this spec |
|-------|-----------------|----------------------|
| **Discovery** | `scan.mjs`, `apify-scan.mjs` | apify-scan new; scan.mjs gets fingerprint hook |
| **Dedup state** | `data/seen-jobs.tsv`, `data/apify-new-*.json` | Schema extended from existing `scan-history.tsv` |
| **Triage** | `digest-builder.mjs` | New |
| **Digest output** | `data/digest.md`, `data/digest-history/` | New |
| **Evaluation** | Existing `assemble-cv.mjs` + `validate-cv.mjs` + `modes/*.md` | **UNCHANGED** |
| **Scheduling** | `.launchd/*.plist`, `autopilot-sources.sh` | New |

## 6. Data Model

### 6.1 `data/seen-jobs.tsv` (canonical dedup state)

TSV with header row. All columns string-valued.

```
linkedin_id	url	company_slug	title_normalized	first_seen_utc	last_seen_utc	source	status	jd_fingerprint	prefilter_archetype	prefilter_score	prefilter_reason
```

| Column | Description |
|--------|-------------|
| `linkedin_id` | Stable ID from LinkedIn URL `/jobs/view/{id}/`; `(none)` for non-LinkedIn sources |
| `url` | Canonical URL (first seen) |
| `company_slug` | `lowercase-kebab` of company name; used for cross-source dedup |
| `title_normalized` | `lowercase-kebab` of title; used for cross-source dedup |
| `first_seen_utc` | ISO timestamp, first time this job was scanned |
| `last_seen_utc` | ISO timestamp, most recent scan that matched this entry |
| `source` | One of: `apify-linkedin-{metro}`, `scan-greenhouse`, `scan-ashby`, `scan-lever`, `manual` |
| `status` | One of: `new`, `filtered-title`, `filtered-dup`, `prefilter-rejected`, `prefilter-passed`, `evaluated`, `applied`, `rejected` |
| `jd_fingerprint` | SHA-256 of normalized JD body (lowercase, whitespace-collapsed, punctuation-stripped); catches cross-source dupes |
| `prefilter_archetype` | One of: `frontend`, `backend`, `infra`, `machine_learning`, `fullstack`, `unknown` (Haiku output malformed), or `(none)` if not yet filtered |
| `prefilter_score` | Integer 0-10, or `(none)` if not yet filtered |
| `prefilter_reason` | One-line explanation from Haiku, or `(none)` |

**In-memory representation** at apify-scan.mjs / digest-builder.mjs startup:
- `Set<linkedin_id>` for O(1) fetch-time dedup
- `Map<jd_fingerprint, row>` for cross-source dedup at digest time
- `Map<company_slug + '|' + title_normalized, row>` for title+company dedup (secondary safety net)

Load time: <200ms at 30k rows (one month's data); scales to 1-2s at 300k rows (one year).

### 6.2 `data/apify-new-{UTC_timestamp}.json`

Per-run output from `apify-scan.mjs`, consumed by next `digest-builder.mjs` run and then deleted (or archived to `data/apify-new-archive/`).

```json
{
  "run_started_utc": "2026-04-22T14:00:03Z",
  "run_finished_utc": "2026-04-22T14:02:47Z",
  "sources": [
    { "metro": "california", "fetched": 47, "new": 12 },
    { "metro": "seattle", "fetched": 23, "new": 5 },
    { "metro": "new-york", "fetched": 31, "new": 8 },
    { "metro": "boston", "fetched": 15, "new": 3 }
  ],
  "total_new_jobs": 28,
  "cost_estimate_usd": 0.116,
  "new_jobs": [
    {
      "linkedin_id": "3847123456",
      "url": "https://www.linkedin.com/jobs/view/3847123456/",
      "title": "Staff+ Software Engineer, Data Infrastructure",
      "company": "Anthropic",
      "company_slug": "anthropic",
      "location": "San Francisco, CA",
      "description": "...full JD body up to 4000 chars...",
      "posted_at": "2026-04-22T13:45:00Z",
      "source_metro": "california"
    }
  ]
}
```

### 6.3 `data/digest.md` (overwrites at 7am, appends hourly)

```markdown
# Job Digest — 2026-04-22 (updated 14:10 PST, 47 jobs)

**Totals**: 🔥 12 strong · ⚡ 15 maybe · 💤 10 probably-not · 🚫 10 skip
**By archetype**: backend 18 · infra 12 · ml 8 · frontend 5 · fullstack 4
**Last refresh**: 14:00 PST (next at 15:00 PST)

---

## 🔥 Score ≥ 8 — Strong Match

### 🔧 Backend (5)
- [ ] **9/10** · Anthropic · Staff+ SWE, Data Infrastructure · SF/Seattle
  https://job-boards.greenhouse.io/anthropic/jobs/4517823
  Why: Exact Go/Spark/Airflow stack match; LinkedIn GDPR work maps directly
  Sources: [greenhouse, apify-california]

- [ ] **9/10** · Databricks · Senior Backend Engineer, Jobs Platform · Mountain View
  https://www.linkedin.com/jobs/view/3847123456
  Why: Distributed systems focus; Kafka+Flink experience transfers cleanly
  Sources: [apify-california]

### 🏗️ Infra (4)
- [ ] **9/10** · Anthropic · Infrastructure Engineer, Sandboxing · SF
  ...

### 🧠 Machine Learning (2)
- [ ] **8/10** · Scale AI · ML Infrastructure Engineer · SF
  ...

### 🎨 Frontend (1)
- [ ] **8/10** · Figma · Senior Frontend Engineer, Dev Experience · SF
  ...

## ⚡ Score 6-7 — Worth a Look
### 🔧 Backend (4)
...

## 💤 Score 4-5 — Probably Not
(collapsed by default; grep to see)

## 🚫 Score ≤ 3 — Skip
(collapsed by default)

## ⚠️ Pre-filter unavailable (0)
(no jobs)
```

User workflow:
1. Open `data/digest.md` in their editor (morning or throughout day)
2. Change `- [ ]` to `- [x]` for jobs they want to evaluate (optional — it's just a visual marker)
3. Copy URL from any entry, paste into Claude Code: `/career-ops pipeline <url>`
4. Existing assembly pipeline runs (assemble → validate → oferta → PDF)
5. digest-builder preserves the user's checkbox state when updating the digest next hour

### 6.4 `data/digest-history/YYYY-MM-DD.md` (archive)

At 7am each morning, the previous day's `digest.md` is moved to `digest-history/YYYY-MM-DD.md`. 30-day retention, older files auto-pruned. Useful for retrospective pattern analysis.

### 6.5 Config: `config/apify-search.yml` (new, plus `config/apify-search.example.yml` as template)

The `.example.yml` is committed to the repo. The non-example `.yml` is gitignored (matches `config/profile.yml` pattern) and holds the user's actual config.

```yaml
# Apify LinkedIn scraper configuration
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

### 6.6 Config: `config/profile.yml` (existing, extended)

Add/replace:

```yaml
# Replaces old target_roles.primary (which was too narrow for a multi-facet candidate)
target_roles:
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
  # Companies to exclude from the digest entirely. Matched case-insensitively
  # against the normalized company slug (substring match). Applied in
  # digest-builder Stage 1 alongside title filter — zero LLM cost.
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
```

### 6.7 `.env` additions

```
APIFY_API_TOKEN=apify_api_...
ANTHROPIC_API_KEY=sk-ant-...   # already needed by assemble-cv.mjs
```

### 6.8 `portals.yml` (existing, unchanged)

Reused by `digest-builder.mjs` stage-1 title filter (uses existing `title_filter.positive` and `title_filter.negative`).

## 7. Components

### 7.1 `apify-scan.mjs` (new, ~150 lines)

**CLI:**
```bash
node apify-scan.mjs [--dry-run]
```

**Logic:**
```
1. Load config/apify-search.yml
2. Load config/profile.yml
3. Load data/seen-jobs.tsv → in-memory Sets (linkedin_ids, fingerprints)
4. Determine current PST hour:
     if hour == 7 → use baseline params, rows = location.baseline_rows
     else         → use hourly params,   rows = location.hourly_rows
5. For each location in config.locations:
     dispatch Promise<scanOneLocation(loc)>
6. await Promise.allSettled(promises)
7. For each settled result:
     if fulfilled: collect new jobs (filter against seen-set)
     if rejected: log error, continue
8. Compute jd_fingerprint for each new job
9. Check fingerprint vs existing Map — if match within 30 days, merge (update last_seen_utc)
10. Atomically append new jobs to seen-jobs.tsv (write to .tmp, rename)
11. Write data/apify-new-{UTC_timestamp}.json with full job data
12. Log summary: { fetched, new, fingerprint_dup, id_dup, cost_estimate_usd }
```

**scanOneLocation(loc) signature:**
```js
async function scanOneLocation(location) {
  const input = {
    ...config.default_params,
    location: location.location,
    publishedAt: params.publishedAt,
    rows: isBaselineHour ? location.baseline_rows : location.hourly_rows,
  };
  const run = await client.actor(ACTOR_ID).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return { metro: location.name, items };
}
```

**Atomic write pattern:**
```js
import { writeFile, rename } from 'node:fs/promises';

async function appendSeenJobs(rows) {
  const tsvPath = 'data/seen-jobs.tsv';
  const tmpPath = tsvPath + '.tmp';
  const existing = await readFile(tsvPath, 'utf-8').catch(() => HEADER_LINE);
  const newContent = existing + rows.map(rowToTSV).join('\n') + '\n';
  await writeFile(tmpPath, newContent, 'utf-8');
  await rename(tmpPath, tsvPath);  // atomic
}
```

### 7.2 `digest-builder.mjs` (new, ~250 lines)

**CLI:**
```bash
node digest-builder.mjs [--dry-run]
```

**Logic:**
```
1. Load all data/apify-new-*.json files newer than last digest-builder run
2. Load scan.mjs output (newly added entries in pipeline.md since last run)
3. Merge into unified candidate list with schema:
     { linkedin_id, url, title, company, company_slug, location,
       description, source, source_metro }

4. STAGE 1 — free rule-based filter (from portals.yml + profile.yml):
     For each job:
       title_lc = job.title.toLowerCase()
       has_positive = any(k in title_lc for k in portals.title_filter.positive)
       has_negative = any(k in title_lc for k in portals.title_filter.negative)
       has_dealbreaker = any(k in title_lc for k in profile.target_roles.deal_breakers)
       is_blacklisted = isCompanyBlacklisted(job.company, profile.target_roles.company_blacklist)
       passes = has_positive AND NOT has_negative AND NOT has_dealbreaker AND NOT is_blacklisted
     Tag in seen-jobs.tsv: passes → status='prefilter-passed' (temp), else 'filtered-title' or 'filtered-blacklist'

     Company blacklist match: normalize both candidate company and blacklist entry
     via `normalizeCompany()` (lowercase + kebab-case), then substring match.
     "Walmart" entry matches "walmart", "walmart-labs", "walmart-connect".

5. STAGE 2 — fingerprint dedup:
     For each survivor:
       fp = job.jd_fingerprint
       if fp in memory Map of seen-jobs.tsv (last 30 days):
         tag 'filtered-dup', skip
       else:
         add fp to map, continue
     Also dedup within today's digest-builder run (same fingerprint from CA and NY metros = same job)

6. STAGE 3 — Haiku archetype + score:
     Build SYSTEM_PROMPT + CANDIDATE_SUMMARY once (use prompt caching, 1h TTL)
     For each survivor (sequential to benefit from cache):
       response = await haiku.messages.create({
         system: [SYSTEM_PROMPT, CANDIDATE_SUMMARY] (both cached),
         messages: [{ role: 'user', content: buildJobPrompt(job) }],
         max_tokens: 120,
         temperature: 0,
       })
       parse response → { archetype, score, reason }
       tag in seen-jobs.tsv with prefilter_archetype/score/reason
     On parse failure: { archetype: 'unknown', score: null, reason: 'prefilter parse failed' }
     On API error: retry 1×, then { score: null, reason: 'prefilter unavailable' }

7. Update data/digest.md:
     if hour == 7:
       archive existing digest.md → data/digest-history/YYYY-MM-DD.md (yesterday's date)
       start fresh with today's date header
     else:
       parse existing digest.md, preserve user checkbox state ([x] vs [ ])
     merge new scored jobs, sort by score DESC within each archetype, bucket into:
       🔥 Score ≥ 8
       ⚡ Score 6-7
       💤 Score 4-5
       🚫 Score ≤ 3
       ⚠️ Pre-filter unavailable (score == null)
     write atomically to digest.md

8. Append score ≥ 6 jobs to data/pipeline.md (existing format) — only if not already there
9. macOS notification via osascript:
     "N new jobs since last scan, top: {company} ({score}/10)"
10. Prune data/digest-history/ entries older than 30 days
11. Move processed data/apify-new-*.json files to data/apify-new-archive/ (or delete)
```

**Haiku prompt structure** (see §9 for full detail):
- System prompt (cached, 1h TTL): scoring rubric
- Candidate summary (cached, 1h TTL): multi-facet profile from `experience_source/` + `profile.yml`
- User message (uncached): job title + company + location + JD body (first 3000 chars)
- Output: JSON `{archetype, score, reason}`

### 7.3 `scan.mjs` (existing, modified)

**Changes:**
1. Import `jd_fingerprint` helper from a new `lib/dedup.mjs` module (shared with apify-scan.mjs)
2. For each job returned by Greenhouse/Ashby/Lever API:
   - If the API response includes a full JD body (Greenhouse does via per-job endpoint; Ashby+Lever via `content` field): compute `jd_fingerprint`
   - If not: set `jd_fingerprint = "(none)"` and the fingerprint dedup simply won't match cross-source
3. Write new jobs to `data/seen-jobs.tsv` (in addition to existing `scan-history.tsv` — both for now; scan-history.tsv deprecated in a later cleanup)
4. Write new entries to `data/pipeline.md` (existing behavior)

No CLI-level changes. No prompt changes. Just internal plumbing.

### 7.4 `lib/dedup.mjs` (new, shared ~60 lines)

Exported functions:
- `extractLinkedInId(url)` — parses `/jobs/view/{id}/` → id string, or null
- `normalizeCompany(name)` — lowercase + kebab-case
- `normalizeTitle(title)` — lowercase + kebab-case + strip " | Company" suffixes
- `computeJdFingerprint(text)` — SHA-256 hex of `text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim()`
- `loadSeenJobs(path)` — returns `{ linkedinIds: Set, fingerprints: Map, titles: Map }`
- `appendSeenJobs(path, rows)` — atomic append

### 7.5 `autopilot-sources.sh` (new)

```sh
#!/bin/bash
set -e
cd /Users/xiaoxuan/resume/career-ops
LOG_DIR="$HOME/.career-ops/logs"
mkdir -p "$LOG_DIR"
TS=$(date +%F-%H)

# Run both scanners in parallel; wait for both
node scan.mjs > "$LOG_DIR/scan-$TS.log" 2>&1 &
node apify-scan.mjs > "$LOG_DIR/apify-$TS.log" 2>&1 &
wait

echo "[$(date -Iseconds)] sources done" >> "$LOG_DIR/sources-$TS.log"
```

### 7.6 launchd plists + setup script

```
.launchd/
├── setup.sh
├── uninstall.sh
├── com.marshmallow.career-ops.sources.plist
└── com.marshmallow.career-ops.digest.plist
```

**`com.marshmallow.career-ops.sources.plist`:**
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
    <dict><key>Hour</key><integer>7</integer> <key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>9</integer> <key>Minute</key><integer>0</integer></dict>
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
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
```

**`com.marshmallow.career-ops.digest.plist`:** same structure as sources plist with two differences:
- Every `Minute` key is `10` instead of `0`
- `ProgramArguments` is `["/usr/local/bin/node", "/Users/xiaoxuan/resume/career-ops/digest-builder.mjs"]`

**Timezone note:** launchd uses the system's local timezone. If the user is in PST (expected), these schedules fire at PST times. If the user travels or the system clock changes timezone, runs fire at the new local time — which is usually fine for a personal-use tool, but worth documenting.

**Hardcoded paths:** scripts assume `$HOME/resume/career-ops` as the repo root. If installed elsewhere, the plist `ProgramArguments`, `autopilot-sources.sh`, and `setup.sh` paths need updating. Setup script could templatize this with a `REPO_ROOT` variable; v1 hardcodes to keep installer simple.

**`setup.sh`:**
```sh
#!/bin/bash
set -e
REPO="$HOME/resume/career-ops"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCHD_DIR"
mkdir -p "$HOME/.career-ops/logs"

cp "$REPO/.launchd/com.marshmallow.career-ops.sources.plist" "$LAUNCHD_DIR/"
cp "$REPO/.launchd/com.marshmallow.career-ops.digest.plist" "$LAUNCHD_DIR/"

launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist" 2>/dev/null || true
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.sources.plist"
launchctl load -w "$LAUNCHD_DIR/com.marshmallow.career-ops.digest.plist"

echo "Installed. Next run: $(date -v+2H +'%H:%M') PST"
launchctl list | grep career-ops
```

### 7.7 Unchanged

- `assemble-cv.mjs`, `assemble-core.mjs`, `assemble-llm.mjs`, `validate-cv.mjs`, `validate-core.mjs` — all CV assembly code
- `generate-pdf.mjs`, `generate-latex.mjs`
- All `modes/*.md` files
- `experience_source/**`, `article-digest.md`
- User's manual flow: open `digest.md` → pick jobs → paste URL → `/career-ops pipeline <url>` → existing pipeline

## 8. Data Flow (one full day)

```
06:55 PST
├─ Nothing scheduled (scan.mjs folded into hourly sources runs)

07:00 PST
├─ launchd fires sources plist
├─ autopilot-sources.sh launches both scanners in parallel:
│   │
│   ├─ scan.mjs (zero-token, ~20s)
│   │   ├─ hits ~45 Greenhouse/Ashby/Lever APIs in parallel
│   │   ├─ computes jd_fingerprint for each job
│   │   ├─ appends new rows to seen-jobs.tsv
│   │   └─ appends to pipeline.md
│   │
│   └─ apify-scan.mjs (baseline hour, ~1-3min, ~$1.30)
│       ├─ detects hour==7 → uses baseline params
│       ├─ Promise.allSettled([CA rows=500, SEA rows=300, NY rows=300, BOS rows=300])
│       ├─ up to 1400 rows returned; client-side dedup against seen-set
│       ├─ typical first-of-day: ~1200 truly new jobs enter pipeline
│       ├─ fingerprint-match against last-30d → a few cross-source dupes collapsed
│       ├─ atomically appends new rows to seen-jobs.tsv
│       └─ writes data/apify-new-{ts}.json

07:10 PST
├─ launchd fires digest plist
├─ digest-builder.mjs (~1-3 min, ~$1-2 for Haiku)
│   ├─ archives yesterday's digest.md → digest-history/2026-04-21.md
│   ├─ reads apify-new-*.json + scan pipeline.md additions
│   ├─ STAGE 1 title filter: ~1200 → ~400 survivors (after junior/intern/contract/etc. stripped)
│   ├─ STAGE 2 fingerprint dedup: ~400 → ~380 (20 were cross-source dupes)
│   ├─ STAGE 3 Haiku pre-filter: 380 × $0.003 avg = ~$1.15
│   ├─ writes fresh digest.md, archetype-grouped, score-bucketed
│   ├─ appends score ≥ 6 jobs to pipeline.md (~80 entries)
│   └─ macOS notification: "80 new jobs this morning, top: Anthropic (9/10)"

09:00 PST
├─ launchd fires sources plist
├─ autopilot-sources.sh in parallel:
│   ├─ scan.mjs → ~5 new jobs across all 45 companies
│   └─ apify-scan.mjs (hourly, ~1 min, ~$0.30)
│       ├─ detects hour!=7 → uses hourly params
│       ├─ Promise.allSettled([CA rows=200, SEA rows=100, NY rows=100, BOS rows=100])
│       ├─ up to 500 rows cap; typically returns ~80 (actual new 2h posts)
│       ├─ after dedup: ~20-30 truly new
│       └─ writes apify-new-{ts}.json

09:10 PST
├─ digest-builder.mjs (~30s, ~$0.10)
│   ├─ reads new apify-new-*.json + scan additions since 7:10
│   ├─ STAGE 1: ~25 → ~10 survivors
│   ├─ STAGE 2: ~10 → ~8 after fingerprint dedup
│   ├─ STAGE 3 Haiku: 8 × $0.003 = $0.02 (cache warm from 7am)
│   ├─ appends to today's digest.md (preserves user's checkbox state on existing entries)
│   └─ macOS notification: "3 new jobs since 7am, top: Databricks (8/10)"

11:00, 13:00, 15:00, 17:00, 19:00, 21:00 PST
├─ Repeats same pattern as 09:00 (hourly runs)

21:10 PST (last digest refresh)
├─ Final stats logged

22:00–06:59 PST
├─ No runs (LinkedIn posts less overnight)

(overnight activity collected into tomorrow's 7am baseline)
```

## 9. Haiku Pre-filter in Full Detail

### 9.1 System prompt (cached, 1h TTL, ~350 tokens)

```
You are a job-fit pre-filter for a multi-facet candidate who is open to roles in
FRONTEND, BACKEND, INFRA, MACHINE_LEARNING, or FULLSTACK.

Given the candidate's profile and a job description, output JSON with:
- archetype: one of "frontend" | "backend" | "infra" | "machine_learning" | "fullstack"
  — which facet this job MOST belongs to
- score: integer 0-10 — how well candidate matches THIS archetype
- reason: one-line ≤100 chars justifying the score

Score on candidate's strength in the job's archetype:
 10  Outstanding match: recent experience maps directly, senior fit.
 8-9 Strong match: most requirements met, a few might need reframing.
 6-7 Decent match: core overlap but notable gaps (missing a specific stack
     component, slightly off seniority, different domain).
 4-5 Weak match: partial overlap in that archetype, or wrong seniority.
 0-3 Not a match: candidate has essentially no experience in this archetype,
     or job is in a different discipline entirely (e.g., legal role whose
     title contains "Infrastructure").

IMPORTANT:
- Score fairly across archetypes. Don't penalize ML jobs for not being backend.
- Non-engineering roles (legal/tax/HR) with keyword-matching titles = 0-2.
- Contract/C2C/temporary roles = score 0-2 (candidate wants full-time).
- Junior/Entry/Intern engineer roles are ACCEPTABLE — score them on stack match
  like any other role. Candidate is open to junior roles if the stack aligns.

Output ONLY the JSON object. No preamble, no markdown.
```

### 9.2 Candidate summary (cached, 1h TTL, ~450 tokens)

Auto-generated at `digest-builder.mjs` startup from `config/profile.yml` + `experience_source/**/*.md`:

```
<candidate_profile>
Name: Sherry Liao
Seniority: Mid-Senior (Senior/Staff target; NOT Junior/Intern/Entry)

Open to roles across ALL four facets (equal priority, score by job's archetype):

FRONTEND:
  - TypeScript Pixel SDK at ByteDance (531M+ events, cross-platform)
  - React/Vue admin dashboards at ByteDance + Pax
  - Design systems with 40+ Tailwind components

BACKEND:
  - Go + Spring Boot services at TikTok, Pax, LinkedIn
  - Kafka + Flink status-tracking pipelines (LinkedIn, 2025-present)
  - Distributed systems, gRPC, OpenTelemetry, MySQL, Redis

INFRA:
  - GDPR data deletion workflows across 4 LinkedIn data platforms
  - Airflow, Spark, Hive, OpenHouse, YARN orchestration
  - Validation/auditing/recovery systems for compliance-critical operations
  - Metadata catalog + policy platform

MACHINE_LEARNING:
  - Internal compliance agent with LangChain + LangGraph
  - LLM + DOM parsing for ad signal extraction (ByteDance)
  - Evaluation pipeline for LLM-extracted selectors

FULLSTACK: yes, but only if genuinely balanced frontend+backend. Candidate
  also has pure-backend and pure-frontend depth, so won't accept fullstack
  roles that are secretly 90% frontend or 90% backend.

Skills breadth: Go, Java, Scala, Python, TypeScript, JavaScript, Spring Boot,
  Kafka, Flink, Spark, Airflow, Hive, MySQL, Redis, Elasticsearch, LangChain,
  LangGraph, React, Vue.js, Next.js, Tailwind
</candidate_profile>
```

### 9.3 Per-job user message (uncached, ~1000-3000 tokens)

```
<job>
Title: {job.title}
Company: {job.company}
Location: {job.location}
Description:
{job.description[:3000]}
</job>

Return JSON.
```

### 9.4 Expected output (~40 tokens)

```json
{"archetype":"backend","score":9,"reason":"Exact Go+Kafka+Spark match; LinkedIn GDPR work maps to privacy requirements"}
```

### 9.5 API call specification

```js
const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 120,
  temperature: 0,   // deterministic — same job → same score
  system: [
    { type: 'text', text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: CANDIDATE_SUMMARY,
      cache_control: { type: 'ephemeral', ttl: '1h' } },
  ],
  messages: [{ role: 'user', content: buildJobPrompt(job) }],
});
```

### 9.6 Cost per call

With 1h prompt cache:
- First call each hour: ~$0.005 (cache write + uncached job body)
- Subsequent calls same hour: ~$0.0018 (cache read + uncached job body)
- Average across a 7am batch of 400 jobs: ~$0.003/call × 400 = **$1.20**
- Average across hourly batches of 10 jobs: $0.005 (cold) + 9×$0.0018 = $0.02
- Daily: $1.20 + 7×$0.02 = **~$1.35/day** = **~$40/month**

### 9.7 Error handling

| Failure | Response |
|---------|----------|
| Malformed JSON in response | `JSON.parse` → fall back to regex extract `/\{[^}]+\}/` → if still fails: `{archetype:'unknown', score:null, reason:'parse failed'}` |
| Timeout (10s) | Retry once; still fails → `{score: null, reason: 'prefilter unavailable'}` |
| API error (500, 429) | Exponential backoff 2s/6s/18s; still fails → skip with `score: null` |
| Score outside 0-10 | Clamp to valid range, log warning |
| Job description >3000 chars | Truncate; note in log |

Jobs with `score: null` appear in a separate "⚠️ Pre-filter unavailable" section at the bottom of `digest.md` — never silently dropped.

## 10. Cost Model

### 10.1 Empirical Apify baseline

User tested: 10 jobs → $0.01, 100 jobs → $0.10. Linear at $1/1000 results effective pricing (actor bundles compute + residential proxy). No base subscription at pay-per-use tier.

### 10.2 Daily cost projection

| Run | Rows scraped | Apify cost | Haiku cost |
|-----|--------------|------------|------------|
| 7am baseline (all 4 metros, parallel) | ~1400 | $1.40 | ~$1.20 (400 survivors pre-filter) |
| 9am–9pm × 7 hourly runs | avg ~80 each = ~560 | $0.56 | ~$0.14 (cache warm) |
| scan.mjs hourly | ~5 new/hour × 8 = 40 | $0 | included in above |
| **Daily** | **~2000 rows** | **~$2.00** | **~$1.35** |

### 10.3 Monthly cost projection

| Component | Monthly |
|-----------|---------|
| Apify (~$2/day × 30) | **~$60** |
| Haiku pre-filter (~$1.35/day × 30) | **~$40** |
| scan.mjs | $0 |
| **Autopilot infrastructure total** | **~$100/mo** |
| Per-job evaluation (user-initiated `/career-ops pipeline`) | ~$0.15/job |

If user evaluates 5 jobs/day × 30 days: +$22/mo = **~$122/mo all-in**.

### 10.4 Cost guardrails

Built-in alerts:
- Per-run Apify cost > $3 (baseline) or $1 (hourly) → log warning + macOS notification
- Daily Apify cost tracker: cumulative > $5 → notification
- Hard abort: cumulative > $15/day → halt further runs until user acknowledges

These use Apify's API to query run costs (available via `run.usage` in response).

## 11. Error Handling

| Failure | Response |
|---------|----------|
| Apify rate limit or actor error | Log to `~/.career-ops/logs/apify-{date}.log`; skip this run's affected metros; don't update seen-jobs.tsv for them. Next run retries |
| Apify cost spike (single run > $3) | Log warning, still proceed but macOS notification; investigate next morning |
| One metro fails within a run (Promise.allSettled rejected) | Log, continue with other metros' results |
| Haiku API error | Degrade: emit job in digest with `score: null`, `reason: "prefilter unavailable"` |
| File I/O or lock issue | Retry 3× with exponential backoff (5s/30s/2m), then abort this run |
| Network down | All runs fail gracefully; when back online, next run catches up (smart r7200 window naturally handles gaps) |
| Disk full | launchd logs to syslog; runs skip; macOS notification |
| 3 consecutive full-run failures | macOS notification: "autopilot failing, check ~/.career-ops/logs/" |
| seen-jobs.tsv corruption | `lib/dedup.mjs::loadSeenJobs` validates TSV format (header row + column count per line); if invalid, backs up to `data/seen-jobs.corrupt-{ts}.tsv` and returns empty Set/Map (accepts cost of re-seeing up to 24h of jobs; notification sent) |

## 12. Testing

### 12.1 Unit tests (node --test, ~50 tests)

- `extractLinkedInId` (URL parsing edge cases: trailing slash, query params, missing slash, full domain vs subdomain)
- `normalizeCompany` / `normalizeTitle` (unicode, apostrophes, trademarks)
- `computeJdFingerprint` (stable across whitespace/case/punctuation; different for different content)
- `loadSeenJobs` → `appendSeenJobs` → re-load round-trip
- Title filter apply (positive + negative + deal-breakers)
- digest.md generation for every bucket boundary (score=7.5 rounds to 8, score=3.5 to 4)
- digest.md merging with existing checkbox state preservation
- Cost estimator for Apify calls

### 12.2 E2E tests (mocked Apify + mocked Anthropic, ~5 tests)

- Fixture 4 apify-new.json files (one per metro) + fixture seen-jobs.tsv (30 existing) → expected digest.md
- Cross-source duplicate (same job in apify-new AND scan output with same jd_fingerprint) → one entry in digest
- All metros fail → empty digest, notification says "scan failed, no updates"
- Haiku returns malformed JSON for 1 job → that job appears in "⚠️ Pre-filter unavailable" section
- 7am baseline archives yesterday's digest correctly

### 12.3 Integration test (manual, weekly)

```bash
npm run autopilot:dry-run   # no state writes, reports what would happen
```

### 12.4 Live validation (week 1)

- Daily check: does `data/digest.md` produce ≥1 score-≥8 job?
- Compare Apify bill vs projection
- Eyeball 10 random Haiku scores — do they align with user's intuition?

## 13. Setup / Install

### 13.1 First-time install

```bash
cd /Users/xiaoxuan/resume/career-ops

# 1. Add Apify client dep
npm install apify-client

# 2. Env vars
cp .env.example .env
# Edit .env: set APIFY_API_TOKEN (from https://console.apify.com/settings/integrations)

# 3. Config files
# (apify-search.example.yml is committed to repo; copy to personal config which is gitignored)
cp config/apify-search.example.yml config/apify-search.yml
# Adjust locations / rows / titles if needed

# Verify your profile.yml has the new target_roles.archetypes_of_interest block
# (see §6.6 of spec for the required shape)

# 4. launchd install
bash .launchd/setup.sh

# 5. Verify
launchctl list | grep career-ops
# Should show: com.marshmallow.career-ops.sources / .digest

# 6. Optional: run once manually
node apify-scan.mjs --dry-run  # see what it would fetch
node digest-builder.mjs --dry-run
```

### 13.2 Pause / resume

```bash
bash .launchd/pause.sh   # launchctl unload; state preserved
bash .launchd/resume.sh  # launchctl load
```

### 13.3 Uninstall

```bash
bash .launchd/uninstall.sh  # unload + remove plists; keeps data/
```

## 14. Removed / Deprecated

None — this is purely additive on top of the existing career-ops + experience-source-assembly fork. `data/scan-history.tsv` continues to exist alongside `data/seen-jobs.tsv` during migration (both are written to); a follow-up cleanup can drop `scan-history.tsv` once all tooling reads from `seen-jobs.tsv`.

## 15. Open Questions for Implementation

1. **Exact Apify CU or proxy overhead at 2000-row scale** — user's tests (10, 100 jobs) show linear $1/1000. Assumption: scales linearly to 2000. First real baseline run (7am of day 1) will confirm or reveal surprise.

2. **Does actor accept `geoId` directly?** — spec uses `location` string; geoIds are stored for documentation but not passed. If actor supports geoId and it's more reliable, swap during implementation.

3. **`workType` / `contractType` / `experienceLevel` — do they filter effectively, or should we rely on title + Haiku?** — spec sets all to null and lets Haiku handle it. If testing reveals junk gets through at high volume, tighten these. Low risk; easy to change later.

4. **Haiku model version drift** — spec pins `claude-haiku-4-5-20251001`. Upgrade path: change the string in `digest-builder.mjs`, re-run a few scores to verify rubric stability.

5. **When `scan.mjs` finds a job its per-job endpoint doesn't return JD body** — fingerprint falls back to `(none)`. Cross-source dedup in that case is only by company+title. Acceptable for v1.

6. **Haiku rate limit** — at sequential cadence (~50 RPM during the 7am batch), we're well within Anthropic Haiku's rate limits on any paid tier. Sequential also maximizes prompt-cache hit rate. No throttle needed for v1. If Anthropic tightens limits or we scale to 1000+ calls per batch, add `p-limit`-based concurrency (2-3 parallel) — but this would cost cache efficiency.

## 16. Success Criteria

- Daily digest.md produced with ≥1 score-≥8 job on ≥5 of 7 days in week 1
- ≥90% of user's "would have applied" picks score ≥6 in pre-filter (calibrated against their manual evaluation)
- Apify cost stays under $150/month in first billing cycle
- Zero duplicate evaluations (seen-jobs.tsv enforces this; a `/career-ops pipeline` on a URL already in applications.md should short-circuit)
- Zero duplicate tailored PDFs for the same job
- First run after reboot recovers state cleanly (seen-jobs.tsv on disk survives power cycle)
- Haiku pre-filter latency p95 < 2s per call (to not block hourly 9:10 digest completion)

## 17. Acceptance Criteria for This Spec

The autopilot subsystem is considered "design-complete and ready for implementation" when:
1. User has reviewed this spec and approved or requested changes (then incorporated)
2. Implementation plan (generated via `superpowers:writing-plans`) covers each component in §7 with concrete tasks

---

**Next step:** invoke `superpowers:writing-plans` to convert this spec into a detailed step-by-step implementation plan.
