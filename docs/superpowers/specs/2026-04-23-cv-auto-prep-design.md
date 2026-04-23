# CV Auto-Prep — Design Spec

**Date:** 2026-04-23
**Status:** Draft
**Type:** New feature. Connects the existing discovery half (ingest → score) to the existing commitment half (CV → eval → tracker) as a single automated flow.

## 1. Problem

Today the pipeline splits into two halves with a manual gate between them:

- **Discovery half (automated)** — `apify-scan` + `scan.mjs` + `test-stage2.mjs` run every 2h via launchd, producing a ranked backlog of scored jobs.
- **Commitment half (manual)** — user picks a JD, runs `assemble-cv`, `validate-cv`, `generate-pdf`, writes an A-G evaluation, inserts a tracker row. Each of these is a separate CLI invocation.

The manual gate is intentional (see `CLAUDE.md`: "The autopilot never auto-evaluates, auto-generates PDFs, or auto-submits"). But because **picker mode** (commit `a51bfc7`) made CV+PDF near-free (~200ms, zero LLM), and because the downstream evaluation blocks that matter most (A, B, E, F, H) can be grounded in JD + candidate summary without web research, the cost math has changed. The user has decided to move the human gate from "pick a JD to evaluate" all the way to "click Apply on the company portal."

We need **`auto-prep.mjs`** — a single-process orchestrator that, for every scored job above a configurable threshold, produces:

1. Materialized JD
2. Tailored CV + PDF (assembler path)
3. Original CV + PDF (picker path)
4. 6-block evaluation report (A+B+E+F+H via one LLM call, G via Playwright)
5. Story Bank accumulation (append STAR+R candidates from Block F)
6. `Evaluated`-status tracker row

## 2. Goals and non-goals

**Goals**
- All six artifacts per job, generated in a single Node.js process.
- In-process composition — `auto-prep.mjs` imports functions, never shells out to child processes.
- Idempotent — re-runs never duplicate applications or reports.
- Graceful degradation — any single-job failure logs and continues with the next job.
- A top-level `run-pipeline.mjs` orchestrates the full flow (ingest → score → auto-prep) so launchd only invokes one command.

**Non-goals**
- No web research for the evaluation (Blocks C/D removed by design — level-strategy and comp-research need Glassdoor/Levels.fyi WebSearch).
- No `claude -p` batch worker path — not needed once C/D are out.
- No auto-submit. Status lands at `Evaluated`; human still clicks Apply.
- No `batch/` directory revival.
- No changes to existing ingestion or scoring behavior.

## 3. User invocation

```bash
# Single step
node auto-prep.mjs                       # uses profile.yml cv.auto_prep.min_score
node auto-prep.mjs --min-score=7         # override for this run

# Full pipeline (launchd entry point)
node run-pipeline.mjs                    # ingest → score → auto-prep end-to-end
```

## 4. Evaluation report structure (6 blocks)

Generated per job at `reports/<company_slug>/<job_id>_report.md`:

| Block | Name | Generator | Inputs |
|---|---|---|---|
| **A** | Resumen del Rol (Role Summary) | LLM | JD text |
| **B** | Match con CV | LLM + `.cv-tailored-meta.json` tier breakdown | JD + candidate summary |
| **E** | Plan de Personalización (Cover-letter strategy) | LLM | JD + candidate summary |
| **F** | Plan de Entrevistas (STAR+R stories, system-design predictions) | LLM | JD + candidate summary + existing `interview-prep/story-bank.md` for de-duplication |
| **G** | Posting Legitimacy | Playwright (no LLM) | JD URL |
| **H** | Draft Application Answers | LLM | JD + candidate summary |

A/B/E/F/H come from **one LLM call** returning structured JSON. G is a parallel Playwright flow.

**Dropped by design** (previously in canonical `oferta` mode):
- ~~C. Nivel y Estrategia~~ — user skips level strategy
- ~~D. Comp y Demanda~~ — user skips comp research (requires WebSearch)

## 5. Config (added to `config/profile.yml`)

```yaml
cv:
  auto_prep:
    min_score: 8          # default 8; 7 widens, 9 tightens. No max_per_run cap.
```

Live `config/profile.yml` is gitignored; the example block lands in `config/profile.example.yml`. Users copy manually.

## 6. Selection rules

An eligible job satisfies ALL of:

1. `first_seen_at` within last 24 hours (bound to avoid reprocessing ancient entries)
2. `stage === 'scored'`
3. `prefilter_score >= config.cv.auto_prep.min_score`
4. `application_id` is null (dedup X: never create a duplicate application row for a job already applied)
5. `cv.picker.archetype_map[prefilter_archetype]` resolves to a file **that exists on disk** in `resumes_dir` (dedup Y: no placeholder PDFs; when user adds a missing archetype PDF later, those jobs become eligible on the next run)

## 7. Per-job flow

```
for each eligible job (in prefilter_score DESC order):
  try:
    1. materializeJd(job) → jds/<slug>.md
    2. runAssemblerMode({jdPath, archetype, outputPaths}) → cvs/<slug>/<job_id>_cv.md + meta
    3. renderPdf({htmlPath, pdfPath}) → cvs/<slug>/<job_id>_cv_tailored.pdf
    4. runPickerMode({jdPath, archetype, outputPaths}) → cvs/<slug>/<job_id>_cv_picker.md + meta
    5. copy resumes/<mapped> → cvs/<slug>/<job_id>_cv_picker.pdf
    6. blocks = await generateEvalBlocks({jd, candidateSummary, tierBreakdown, existingStoryBank})
    7. legitimacy = await verifyLegitimacy(job.url)
    8. reportBody = renderReport(blocks, legitimacy, job)
    9. {num} = await persistReport({job_id, company, company_slug, url, score, body: reportBody, legitimacy})
   10. await appendStoryBank(blocks.block_f_stories)       // side-effect: updates interview-prep/story-bank.md
   11. await upsertApplication({
         num, job_id, company, role, url,
         status: 'Evaluated',
         score: Number((job.prefilter_score / 2).toFixed(1)),   // 0-10 prefilter → 0-5 tracker convention
         pdf_generated: true,
         report_id: String(num),
         notes: 'auto-prep (LLM A+B+E+F+H, Playwright G)',
       })
  catch (err):
    console.error(`[auto-prep] job=${job.linkedin_id} failed: ${err.message}`)
    continue
```

All slugs use existing `buildCvPaths()` from `assemble-cv.mjs`.

## 8. Single LLM prompt for Blocks A+B+E+F+H

Shape:

```
SYSTEM:
  You are writing a job-match evaluation. Return ONLY JSON matching this schema:
  { block_a: string, block_b_rows: [{req, evidence}], block_e: string,
    block_f_stories: [{scenario, star_prompt}], block_h_answers: [{prompt, answer}] }

  Ground every claim in either the JD text or the candidate_summary.
  Never invent metrics or technologies the candidate didn't cite.
  Block B: 3-5 rows mapping JD requirements to specific candidate evidence.
  Block F: 3-5 STAR+R story prompts with 1-sentence scenario each.
  Block H: 2-3 draft answers for common application questions.

USER:
  <job>...JD...</job>
  <candidate_summary>...</candidate_summary>
  <tier_breakdown>...</tier_breakdown>
  <existing_story_themes>...</existing_story_themes>
```

Expected output: ~2000 tokens. One call per job. Model = `LLM_MODEL` from env (configured by `initLlm()`).

## 9. Story Bank accumulation

After Block F is generated:

1. Parse `block_f_stories` → array of `{scenario, star_prompt}`
2. Load `interview-prep/story-bank.md` if present
3. For each candidate story, compute a stable hash from `(scenario normalized)`; if not already in the bank, append as a new entry with headers like:
   ```markdown
   ## [Auto-generated · 2026-04-23 · Mercor]
   **Scenario:** <scenario>
   **STAR prompt:** <prompt>
   ```
4. Write the updated file.

Deduplication threshold: exact normalized-scenario match. (More sophisticated semantic dedup = future improvement.)

## 10. Playwright Legitimacy Check (Block G)

`lib/legitimacy.mjs` exports:

```js
export async function verifyLegitimacy(jobUrl, { timeout = 15000 } = {})
// Returns: { tier: 'confirmed' | 'likely' | 'suspicious' | 'unverified', signals: string[] }
```

Implementation:
1. `chromium.launch()` headless
2. `page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout })`
3. Check for positive signals (any two → 'confirmed'):
   - job title in `<h1>` or page title
   - job description section with > 500 chars
   - Apply button or Apply form present
4. Check for negative signals (any → 'suspicious'):
   - "This job is no longer accepting applications"
   - "Job not found" / 404
   - Only footer/navbar visible
5. No strong signals either way → 'likely'
6. Any exception (timeout, network) → 'unverified' with reason

No LLM used.

## 11. In-process architecture (required)

`auto-prep.mjs` imports — does NOT shell out:

```js
import { runApifyScan } from './apify-scan.mjs';
import { runDigestStage2AndScoring } from './digest-builder.mjs';
import { runPickerMode, runAssemblerMode } from './assemble-cv.mjs';   // NEW exports
import { renderPdf } from './generate-pdf.mjs';                         // NEW export
import { persistReport } from './lib/reports.mjs';
import { upsertApplication, findJobByLinkedinId, getDb, closeDb } from './lib/db.mjs';
import { generateEvalBlocks, appendStoryBank, renderReport } from './lib/auto-prep.mjs';  // NEW module
import { verifyLegitimacy } from './lib/legitimacy.mjs';                // NEW module
```

Everything runs in one Node.js process with a single `closeDb()` at the end.

## 12. File structure

### New files
- `auto-prep.mjs` — orchestrator CLI (~150 lines)
- `lib/auto-prep.mjs` — pure helpers: `generateEvalBlocks`, `appendStoryBank`, `renderReport` (~100 lines)
- `lib/legitimacy.mjs` — Playwright check (~60 lines)
- `run-pipeline.mjs` — top-level orchestrator for launchd (~40 lines)
- `tests/auto-prep.test.mjs` — unit + integration (~8 tests)
- `tests/legitimacy.test.mjs` — 3 tests on fixture HTML

### Modified files
- `assemble-cv.mjs` — split `main()` so `runPickerMode` and `runAssemblerMode` are importable; both accept an `outputPaths` argument (via `buildCvPaths()`) instead of hardcoded `OUT_TAILORED`/`OUT_META`. CLI continues to work unchanged.
- `generate-pdf.mjs` — `export async function renderPdf({ htmlPath, pdfPath, format })`. CLI continues to work unchanged.
- `config/profile.example.yml` — add `cv.auto_prep.min_score` block.
- `.launchd/setup.sh` — change schedule target from separate `apify-scan` + `digest-builder` jobs to single `run-pipeline.mjs`.

### NOT modified
- `apify-scan.mjs`, `scan.mjs`, `digest-builder.mjs`, `test-stage2.mjs` — already compose cleanly.
- `validate-cv.mjs` — auto-prep skips validation for picker output (already wired) and trusts the assembler's existing validation gate.
- `lib/db.mjs`, `lib/reports.mjs`, `lib/llm.mjs`, `lib/picker.mjs`, `lib/dedup.mjs` — all already exported.
- Downstream modes (`modes/oferta.md`, `modes/pipeline.md`, etc.) — they still read from the same tracker + reports paths.

## 13. Testing plan

### `tests/auto-prep.test.mjs`

1. `generateEvalBlocks`: mock LLM returns valid JSON → parses into correct shape.
2. `generateEvalBlocks`: mock LLM returns malformed JSON → returns empty stub, doesn't throw.
3. `appendStoryBank`: new story → written to file.
4. `appendStoryBank`: duplicate scenario hash → skipped.
5. `renderReport`: all 6 blocks + legitimacy combine into expected markdown structure.
6. Selection rule: job with `application_id` already set → excluded.
7. Selection rule: archetype mapped to missing file → excluded.
8. End-to-end (mocked LLM, mocked Playwright, real Mongo via `mongodb-memory-server`): one job → all 6 artifacts land.

### `tests/legitimacy.test.mjs`

1. Fixture HTML with title + description + apply button → `confirmed`.
2. Fixture HTML with only nav + footer → `suspicious`.
3. Playwright throws → `unverified` with reason string.

### Existing test suite
177 tests continue to pass. Tests for modified `assemble-cv.mjs` and `generate-pdf.mjs` verify CLI behavior unchanged.

## 14. Failure handling

| Failure | Behavior |
|---|---|
| LLM call fails (network, 5xx) | Log error for this job, skip the job, continue. Next auto-prep run retries. |
| Playwright fails | Block G = `unverified`, report still written with lower-confidence G. |
| `runAssemblerMode` throws (e.g., `pickBullets` MiniMax fragility) | Log error, skip job. Picker PDF NOT generated either (both-or-nothing per spec §1 goal). |
| `renderPdf` fails | Log error, skip job (tracker row not created — avoids orphan rows). |
| `persistReport` fails mid-run | Skip the tracker upsert for this job; report file may exist locally. Next run will regenerate. |
| `upsertApplication` fails | Report persisted but application row missing. Next run sees `application_id: null` and retries; the existing report file on disk won't double-write because `persistReport` is keyed on job_id. |

Single-job failures never abort the whole run.

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM hallucinations in A/B/E/F/H despite grounding constraints | Prompt explicitly rejects invention. Periodic human audit of recent rows. User can `--refresh` the whole thing with a stronger prompt later. |
| First-run cost explosion (no cap, 100+ eligible jobs) | User opted in knowing this. Progress log per job means user can Ctrl-C; next run picks up at the first non-applied job. |
| Status=Evaluated overstates what auto-prep produced vs. manual oferta | Notes field explicitly reads `auto-prep (LLM A+B+E+F+H, Playwright G)` so the user can filter on review. |
| Picker and assembler output clobber each other's `cv.tailored.md` at repo root | Both `runPickerMode` and `runAssemblerMode` take `outputPaths` — auto-prep passes per-job paths. Repo-root `cv.tailored.md` is only touched by the manual CLI path. |
| `pickBullets` MiniMax fragility | Single-job failures are caught; auto-prep continues. Known out-of-scope per prior audit. |
| Story bank grows unboundedly | Deduplication by normalized-scenario hash limits it. If needed later, add a size cap + LRU eviction. |

## 16. Rollout

1. Land the code in one plan, one push.
2. First run will process the backlog of existing score≥8 jobs (currently ~108). Monitor console output, Ctrl-C if needed.
3. After backlog is cleared, steady-state runs (every 2h) process only that window's new ingests — typically 5-15 jobs, ~5-10 minutes of LLM work per run.
4. If quality is low, tune the prompt in `lib/auto-prep.mjs` and add an `--refresh-evals` flag to re-generate reports (future work).

## 17. Integration with existing system

- Downstream modes (`modes/oferta.md`, `pipeline.md`, `contacto.md`, etc.) continue to read from `cv.tailored.md` — picker mode's extract is the default on a per-job basis; assembler's structured output lives at the per-job path when the user manually wants to run a downstream mode against it.
- `data/applications.md` rendering via `merge-tracker.mjs` works unchanged; new rows appear with `Evaluated` status, working `[num](reports/<slug>/<job_id>_report.md)` links, ✅ PDF column.
- Interview Story Bank becomes a live asset — the `interview-prep/story-bank.md` file grows with every auto-prep run and is ready for any behavioral-interview mode to use.
