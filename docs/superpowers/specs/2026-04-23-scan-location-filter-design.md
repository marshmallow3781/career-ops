# Location Filter for scan.mjs + Netlify Cleanup — Design

**Date:** 2026-04-23
**Status:** Design approved, ready for implementation plan

---

## 1. Problem

`scan.mjs` (Greenhouse/Ashby/Lever scanner) fetches **every open role** a company has posted worldwide. `apify-scan.mjs` scopes by `geoId` at the Apify actor level (Bay Area + Seattle only), but `scan.mjs` has no location filter at all.

Observed noise on a recent dry-run: Anthropic's 448 open roles included postings from London, Dublin, Tokyo, Bangalore, Munich, Paris, Seoul, Singapore, São Paulo, etc. Your `profile.yml` says `location.country: "United States"` and `location.city: "Newark, CA"` — those international postings are unapplicable noise.

Separately, the Netlify entry in `portals.yml` returns HTTP 404 on its Lever endpoint. They've either moved off Lever or the slug changed. Low-value to debug since Netlify isn't a priority target.

## 2. Goal

Add a `location_filter` to `portals.yml` that parallels the existing `title_filter`, applied client-side in `scan.mjs` after title filtering. Default to California + Washington state (covers Bay Area, LA, San Diego, Seattle, Redmond, etc.) + US-remote variants, with Washington DC and non-US remotes explicitly carved out.

Also remove the broken Netlify entry from `portals.yml`.

Success criteria:
- `node scan.mjs --dry-run --since-hours=720` on the current 5 companies drops all international postings (London/Dublin/Tokyo/etc.) and keeps all California + Washington State + US-remote postings.
- Jobs with a missing `location` field are dropped (can't verify US-ok).
- Multi-location postings (`"San Francisco, CA | London, UK"`) pass if any allowed substring is present AND no denied substring is present.
- Netlify entry is gone from `portals.yml`.

## 3. Architecture

Single-file change to `scan.mjs` plus two config edits (`portals.yml`). No Mongo involvement — `scan.mjs` still writes to `data/pipeline.md` + `data/seen-jobs.tsv` as it does today. (A future plan would migrate `scan.mjs` to Mongo, but that's out of scope here.)

```
    ┌─────────────────────────┐
    │ portals.yml             │
    │   title_filter  (exist) │
    │   location_filter (NEW) │
    └───────────┬─────────────┘
                │
                ↓
    ┌─────────────────────────────────────────────────────────┐
    │ scan.mjs                                                │
    │                                                         │
    │   fetchJson → parseGreenhouse/Ashby/Lever               │
    │     → titleFilter (existing)                            │
    │     → locationFilter (NEW)                              │
    │     → filterByPostedAt (existing, from time-window fix) │
    │     → dedup (existing)                                  │
    │     → writeToPipeline / seen-jobs.tsv (existing)        │
    └─────────────────────────────────────────────────────────┘
```

Order is intentional: title filter cuts ~70% cheap, location filter drops most remaining ~50% cheap, time-window drops another ~95% cheap — only then do we do expensive dedup set lookups.

## 4. Configuration

### 4.1 `portals.yml` addition

Append `location_filter:` block adjacent to `title_filter:`:

```yaml
location_filter:
  # Bay Area + rest of California (via state match) + Washington State (via
  # state match + explicit Seattle-metro city names). Drops international
  # offices. Comma-space prefix for state abbreviations disambiguates
  # (", CA" vs "Canada"; ", WA" is unambiguous). Empty list = no filtering.
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

`portals.yml` is the user layer (gitignored). `templates/portals.example.yml` is the tracked template — same block needs to land there for new users.

### 4.2 Netlify removal

Delete the Netlify block from both `portals.yml` and `templates/portals.example.yml`:

```yaml
  # REMOVE — their Lever endpoint returns 404; they likely moved ATS.
  - name: Netlify
    careers_url: https://jobs.lever.co/netlify
    enabled: true
```

## 5. Matching semantics

### 5.1 Allow-then-deny

A location string passes if:
1. At least one `allow` entry is a case-insensitive substring of the location, AND
2. No `deny` entry is a case-insensitive substring of the location.

Deny wins: `"Remote - EU"` contains both `"Remote"` (allow) and `"Remote - EU"` (deny) → dropped.

### 5.2 Empty or missing location

`""`, `null`, or `undefined` → dropped. Can't verify US-ok without a string; failing closed is safer than failing open.

### 5.3 Multi-location postings

Greenhouse postings like `"San Francisco, CA | New York City, NY | Seattle, WA"` are one string with pipe separators. The rule applies to the whole string: if any allow substring is present anywhere in the string AND no deny substring is present, it passes. So:

- `"San Francisco, CA | London, UK"` → pass (`", CA"` allow, no deny hits)
- `"Washington, DC | New York City, NY"` → drop (`"Washington, DC"` deny wins despite `"New York"` not being in allow anyway)
- `"Bangalore, India | Berlin, Germany"` → drop (no allow match)

### 5.4 Missing config

If `portals.yml` omits `location_filter:` entirely, OR has empty `allow: []`, the filter is a no-op (all jobs pass). Matches how `title_filter` handles absence gracefully.

## 6. Integration in scan.mjs

### 6.1 New helper

Add `buildLocationFilter(cfg.location_filter)` near `buildTitleFilter`:

```js
function buildLocationFilter(cfg) {
  const allow = (cfg?.allow || []).map(s => s.toLowerCase());
  const deny  = (cfg?.deny  || []).map(s => s.toLowerCase());
  // If no allow entries, filter is a no-op (all locations pass).
  if (allow.length === 0) return () => true;
  return (location) => {
    if (!location || typeof location !== 'string') return false;
    const lc = location.toLowerCase();
    if (deny.some(d => lc.includes(d))) return false;
    return allow.some(a => lc.includes(a));
  };
}
```

### 6.2 Integration in the fetch loop

After `titleFilter(job.title)` check, add `locationFilter(job.location)` check:

```js
for (const job of jobs) {
  if (!titleFilter(job.title)) { totalFiltered++; continue; }
  if (!locationFilter(job.location)) { totalLocationFiltered++; continue; }
  // ... time-window filter (existing) ...
  // ... dedup (existing) ...
}
```

### 6.3 Summary output

Add a row to the summary block:

```
Companies scanned:     5
Total jobs found:      629
Outside location:      480 skipped (no allow match OR deny match)
Outside time window:   80 skipped
Filtered by title:     60 removed
Duplicates:            4 skipped
New offers added:      5
```

Counter name: `totalLocationFiltered`. Initialized to 0, incremented in the fetch loop's `continue` branch.

## 7. Testing

New test file `tests/scan.mjs` (does not currently exist). Covers `buildLocationFilter`:

- Empty config → permissive (everything passes)
- Allow-match straightforward: `"San Francisco, CA"` with `", CA"` → pass
- Deny-wins: `"Remote - EU"` with allow `["Remote"]` deny `["Remote - EU"]` → drop
- Case-insensitive: `"san francisco, ca"` with `", CA"` → pass
- Multi-location pipe: `"San Francisco, CA | London, UK"` → pass
- DC carve-out: `"Washington, DC"` with allow `["Washington"]` deny `["Washington, DC"]` → drop
- Missing location: `null` / `""` / `undefined` → drop
- Whole-string allow: `"Seattle, Washington"` with `"Washington"` → pass
- No allow match: `"Austin, TX"` → drop

Live `--dry-run` verification against the current 5 portals (Anthropic being the biggest volume) — expected drop rate ~85% of international postings.

## 8. Rollout

Single commit is fine since the change is self-contained:

1. Update `scan.mjs` (new helper + integration + counter).
2. Update `portals.yml` (add `location_filter`, remove Netlify entry).
3. Update `templates/portals.example.yml` (add `location_filter` template, remove Netlify entry).
4. Add `tests/scan.mjs` (unit tests for buildLocationFilter).
5. Live dry-run, verify output.

## 9. Out of scope

- Migrating `scan.mjs` to write to Mongo (future work).
- Location filtering for `apify-scan.mjs` (already scoped via geoId, different concern).
- Replacing the removed Netlify entry with a non-Lever ATS slug (requires probing where Netlify now posts).
- Fuzzy matching / stemming / Levenshtein — substring is good enough and explicit.
- Per-company location overrides (e.g. "Stripe Dublin is fine for Sherry" as a one-off). Add later if needed.
