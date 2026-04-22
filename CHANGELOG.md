# Changelog

## fork-v0.2.0 — 2026-04-21 (marshmallow3781/career-ops)

Personal fork: job discovery autopilot. Not pushed upstream.

### Features

- New `apify-scan.mjs`: scrapes LinkedIn via Apify actor
  `curious_coder/linkedin-jobs-scraper` ($1/1000 results) across 4 US metros
  (California, Greater Seattle, NYC Metro, Boston) in parallel via
  `Promise.allSettled` every 2 hours 7am-9pm PST
- New `digest-builder.mjs`: 3-stage filter (title/deal-breaker/blacklist
  → SHA-256 fingerprint dedup → Haiku archetype-aware scoring 0-10)
  produces `data/digest.md` grouped by score bucket and archetype
- New `lib/dedup.mjs`: shared helpers for LinkedIn ID extraction,
  kebab normalization, JD fingerprinting, and TSV state I/O with atomic
  writes + corruption recovery
- `scan.mjs` modified to write to `seen-jobs.tsv` with `jd_fingerprint`
  for cross-source dedup (LinkedIn + Greenhouse postings of the same
  job collapse to one digest entry)
- Company blacklist (11 entries default) applied in Stage 1 — blacklisted
  jobs never hit Haiku, never appear in digest
- 2 macOS launchd plists + install/pause/resume/uninstall scripts
- macOS notifications after each digest run
- 30-day digest history archive

### Dependencies

- Added: `apify-client@^2.9.5`

### Cost (estimated)

- Autopilot infrastructure: ~$90/mo (Apify ~$60 at $1/1000 rate +
  Haiku pre-filter ~$30 with 1h prompt caching)
- Per-job evaluation (user-initiated): pay-as-you-go ~$0.15/job

### Tests

- 95/95 tests passing (new: ~50 unit + 4 E2E across
  `tests/dedup.test.mjs`, `tests/apify-scan.test.mjs`,
  `tests/digest-builder.test.mjs`, `tests/autopilot.e2e.test.mjs`)

### Design

See `docs/superpowers/specs/2026-04-21-job-discovery-autopilot-design.md`.

## fork-v0.1.0 — 2026-04-21 (marshmallow3781/career-ops)

Personal fork: experience-source assembly. Not pushed upstream.

### BREAKING

- Removed `cv.md` and `cv-sync-check.mjs` — CV content now lives in
  per-company × per-facet files at `experience_source/{company}/{facet}.md`
- All JD-driven modes (`oferta`, `pdf`, `latex`, `apply`, `contacto`,
  `deep`, `followup`) now read `cv.tailored.md` instead of `cv.md`
- `auto-pipeline.md` adds Paso 0.5 (assemble) and Paso 0.6 (validate)
  before evaluation; PDF generation is gated by validator pass

### Features

- New `assemble-cv.mjs` CLI: deterministic candidate-pool selection +
  LLM-driven bullet picking + retry loop on validation failure
- New `validate-cv.mjs` with three structural checks: company coverage,
  bullet provenance (fuzzy-match against source files), chronological order
- Hardcoded tier system: full / light / stub based on candidate pool size,
  with per-company `tier_floor` override in `config/profile.yml`
- Article-digest entries auto-merged into Projects pool, archetype-filtered
- LaTeX path also consumes `cv.tailored.md`
- 43 unit + E2E tests (`tests/*.test.mjs`), integrated into `test-all.mjs`

### Dependencies

- Added: `@anthropic-ai/sdk@^0.32.1`

## [1.5.0](https://github.com/santifer/career-ops/compare/v1.4.0...v1.5.0) (2026-04-14)


### Features

* add --min-score flag to batch runner ([#249](https://github.com/santifer/career-ops/issues/249)) ([cb0c7f7](https://github.com/santifer/career-ops/commit/cb0c7f7d7d3b9f3f1c3dc75ccac0a08d2737c01e))
* add {{PHONE}} placeholder to CV template ([#287](https://github.com/santifer/career-ops/issues/287)) ([e71595f](https://github.com/santifer/career-ops/commit/e71595f8ba134971ecf1cc3c3420d9caf21eed43))
* **dashboard:** add manual refresh shortcut ([#246](https://github.com/santifer/career-ops/issues/246)) ([4b5093a](https://github.com/santifer/career-ops/commit/4b5093a8ef1733c449ec0821f722f996625fcb84))


### Bug Fixes

* add stopword filtering and overlap ratio to roleMatch ([#248](https://github.com/santifer/career-ops/issues/248)) ([4da772d](https://github.com/santifer/career-ops/commit/4da772d3a4996bc9ecbe2d384d1e9d2ed75b9819))
* **dashboard:** show dates in pipeline list ([#298](https://github.com/santifer/career-ops/issues/298)) ([e5e2a6c](https://github.com/santifer/career-ops/commit/e5e2a6cffe9a5b9f3cec862df25410d02ecc9aa4))
* ensure data/ and output/ dirs exist before writing in scripts ([#261](https://github.com/santifer/career-ops/issues/261)) ([4b834f6](https://github.com/santifer/career-ops/commit/4b834f6f7f8f1b647a6bf76e43b017dcbe9cd52f))
* remove wellfound, lever and remotefront from portals.example.yml ([#286](https://github.com/santifer/career-ops/issues/286)) ([ecd013c](https://github.com/santifer/career-ops/commit/ecd013cc6f59e3a1a8ef77d34e7abc15e8075ed3))

## [1.4.0](https://github.com/santifer/career-ops/compare/v1.3.0...v1.4.0) (2026-04-13)


### Features

* add GitHub Actions CI + auto-labeler + welcome bot + /run skill ([2ddf22a](https://github.com/santifer/career-ops/commit/2ddf22a6a2731b38bcaed5786c4855c4ab9fe722))
* **dashboard:** add Catppuccin Latte light theme with auto-detection ([ff686c8](https://github.com/santifer/career-ops/commit/ff686c8af97a7bf93565fe8eeac677f998cc9ece))
* **dashboard:** add progress analytics screen ([623c837](https://github.com/santifer/career-ops/commit/623c837bf3155fd5b7413554240071d40585dd7e))
* **dashboard:** add vim motions to pipeline screen ([#262](https://github.com/santifer/career-ops/issues/262)) ([d149e54](https://github.com/santifer/career-ops/commit/d149e541402db0c88161a71c73899cd1836a1b2d))
* **dashboard:** aligned tables and markdown syntax rendering in viewer ([dbd1d3f](https://github.com/santifer/career-ops/commit/dbd1d3f7177358d0384d6e661d1b0dfc1f60bd4e))


### Bug Fixes

* **ci:** use pull_request_target for labeler on fork PRs ([#260](https://github.com/santifer/career-ops/issues/260)) ([2ecf572](https://github.com/santifer/career-ops/commit/2ecf57206c2eb6e35e2a843d6b8365f7a04c53d6))
* correct _shared.md → _profile.md reference in CUSTOMIZATION.md (closes [#137](https://github.com/santifer/career-ops/issues/137)) ([a91e264](https://github.com/santifer/career-ops/commit/a91e264b6ea047a76d8c033aa564fe01b8f9c1d9))
* replace grep -P with POSIX-compatible grep in batch-runner.sh ([637b39e](https://github.com/santifer/career-ops/commit/637b39e383d1174c8287f42e9534e9e3cdfabb19))
* test-all.mjs scans only git-tracked files, avoids false positives ([47c9f98](https://github.com/santifer/career-ops/commit/47c9f984d8ddc70974f15c99b081667b73f1bb9a))
* use execFileSync to prevent shell injection in test-all.mjs ([c99d5a6](https://github.com/santifer/career-ops/commit/c99d5a6526f923b56c3790b79b0349f402fa00e2))
