# Auto-Apply Agent — Design Spec

**Date:** 2026-04-24
**Status:** Draft
**Type:** New feature. Adds a 5th pipeline stage that autonomously submits applications via a Playwright-driven browser agent using MiniMax for vision + text.

> **⚠️ This spec explicitly overrides** `CLAUDE.md` §Ethical-Use: *"The autopilot never auto-evaluates, auto-generates PDFs, or auto-submits"* and *"NEVER submit an application without the user reviewing it first."* The user has chosen full auto-submit for this personal fork. The risk of bot-flagged submissions, misfilled forms, or TOS violation is accepted. All new code paths include header comments pointing to this override so future readers understand the deliberate deviation.

## 1. Problem

Today the pipeline ends at `Evaluated` status. The human still opens every company's apply portal, fills the same 20 form fields (work authorization, salary expectations, education, EEO, etc.), uploads the resume + cover letter, and clicks Submit. ApplyPilot proved this is automatable: a Claude-Code + Playwright-MCP agent that "applied to 1,000 jobs in 2 days." We want career-ops' equivalent, but:

- Using career-ops' existing LLM factory (`initLlm()`, MiniMax-first, no Claude CLI dep).
- Vision via MiniMax `image-01` instead of GPT-4V / Claude vision.
- Prompts ported from ApplyPilot to inherit their prompt-engineering investment.
- Human-in-the-loop replaced with `--dry-run` (default) as a safety rail.

## 2. Goals and non-goals

**Goals**
- `node apply-bot.mjs` autonomously navigates application forms and submits (or previews in dry-run).
- Playwright-direct control; no `claude -p` subprocess dependency.
- MiniMax-only LLM surface — vision via `image-01`, text via `LLM_MODEL`.
- Per-job trace (screenshots + action log + DOM snapshot) for audit / debugging.
- CAPSOLVER integration for hCaptcha / reCAPTCHA / Turnstile / FunCaptcha.
- Multi-worker parallelism (default 2 Chrome instances).
- Single LLM call in `auto-prep` expands to produce the cover letter artifact needed here.

**Non-goals**
- LinkedIn Easy Apply navigation (requires LinkedIn auth cookies).
- Workday portal custom extractors (future; use only if the agent's generic form handler struggles).
- Multi-step application flows (HackerRank screens, take-home tests) → marked `Skipped`.
- Resume reformatting per-JD. The picker PDF ships as-is.
- Email / calendar integration.

## 3. User invocation

```bash
# Dry-run: fill every form, snapshot, but do NOT submit (default)
node apply-bot.mjs

# Single job for debugging
node apply-bot.mjs --job-id=4395215171

# Real submissions, 2 workers (the --submit flag unlocks Submit click)
node apply-bot.mjs --submit --workers=2

# Retry jobs that hit Failed status last run
node apply-bot.mjs --retry-failed

# End-to-end from ingest → apply (5-stage pipeline)
node run-pipeline.mjs --auto-apply --submit
```

Flag semantics:
- `--submit` → agent clicks the real Submit button. Without it, status transitions to `DryRun`.
- `--workers=N` → N concurrent Chrome instances (default 2, max 4).
- `--job-id=ID` → process only that LinkedIn id / URL.
- `--retry-failed` → re-process jobs with `status=Failed` from prior runs.

## 4. Selection rules

A job is eligible for auto-apply iff all hold:
1. `first_seen_at` within 7 days (avoid ancient stale jobs).
2. `stage === 'scored'` AND `prefilter_score >= config.application_form_defaults.auto_apply.min_score` (default 9).
3. No application row exists in the `applications` collection for this `job_id` (same dedup X rule as auto-prep; queries the applications collection directly).
4. `application_form_defaults.auto_apply.enabled !== false` in profile.yml (kill switch).

Companies can be blacklisted per-job by the existing `target_roles.company_blacklist` at ingest time — no additional auto-apply blacklist introduced (user opted out of per-company cap).

## 5. Config additions to `config/profile.yml`

```yaml
application_form_defaults:
  personal:
    full_name: "…"
    preferred_name: "…"
    email: "…"
    phone: "…"
    address: "…"
    city: "…"
    province_state: "CA"
    country: "United States"
    postal_code: "…"
    linkedin_url: "…"
    github_url: "…"
    portfolio_url: "…"
    website_url: ""
  work_authorization:
    legally_authorized_to_work: "Yes"
    require_sponsorship: "No"
    work_permit_type: ""
  availability:
    earliest_start_date: "Immediately"
    available_for_full_time: "Yes"
    available_for_contract: "No"
  compensation:
    salary_expectation: "200000"
    salary_currency: "USD"
    salary_range_min: "180000"
    salary_range_max: "240000"
  experience:
    years_of_experience_total: "5"
    education_level: "Bachelor's Degree"
    current_job_title: "Staff Software Engineer"
    current_company: "…"
    target_role: "Senior Backend Engineer"
  eeo_voluntary:
    gender: "Decline to self-identify"
    race_ethnicity: "Decline to self-identify"
    veteran_status: "I am not a protected veteran"
    disability_status: "I do not wish to answer"
  auto_apply:
    enabled: true
    min_score: 9
    workers: 2
    capsolver_enabled: true
    capsolver_budget_usd: 5.0
    max_steps_per_job: 25
```

The live `config/profile.yml` is gitignored; the example lives in `config/profile.example.yml`. `.env.example` gains `CAPSOLVER_API_KEY=`.

## 6. Cover letter generation (upstream dependency)

auto-prep's `generateEvalBlocks` LLM call expands from 5 blocks (A+B+E+F+H) to 6 (A+B+E+F+H+CoverLetter). The new `block_cover_letter` field is 250–350 words, first-person, grounded in the JD + candidate_summary. Shipped artifacts:

- `cvs/<company_slug>/<title_slug>/<job_id>_cover_letter.md` (body)
- `cvs/<company_slug>/<title_slug>/<job_id>_cover_letter.pdf` (rendered via existing `renderPdf()` + a new lightweight template `templates/cover-letter-template.html`)

apply-bot reads these paths from Mongo (`cv_artifact_ids` on the application / from `cvs/*.meta.json`) and uses whichever fits the form's field type (text box vs file upload).

## 7. Per-job flow (apply-bot main loop)

```
for each eligible job (parallel across N workers):
  # Pre-flight
  spawn Playwright chromium with dedicated user-data-dir per worker
  ensure resumes/<mapped>.pdf + cover_letter.pdf exist for this job
  mkdir -p screenshots/<job_id>/

  # Agent loop (max max_steps_per_job iterations)
  for step in 1..25:
    page.screenshot() → screenshots/<job_id>/step_<n>.png
    a11yTree = await page.accessibility.snapshot()

    # Vision-only disambiguation: use MiniMax image-01 on the screenshot
    # to identify what kind of page we're on; a11y tree is authoritative
    # for field targets.
    pageType = await classifyPage({ screenshot, a11yTree, llmClient })
    # pageType ∈ { 'redirect', 'apply_form', 'already_applied', 'dead_end', 'captcha', 'confirmation' }

    action = await planNextAction({
      pageType, a11yTree, profile, screenshot, stepHistory,
      jobContext: { title, company, jd_text },
      files: { resume_pdf, cover_letter_pdf, cover_letter_text },
      llmClient,
    })

    if action.type === 'done_success' break
    if action.type === 'done_failed'  break
    if action.type === 'click'        await page.click(action.selector)
    if action.type === 'fill'         await page.fill(action.selector, action.value)
    if action.type === 'upload'       await page.setInputFiles(action.selector, action.path)
    if action.type === 'select'       await page.selectOption(action.selector, action.value)
    if action.type === 'solve_captcha':
      if config.capsolver_enabled:
        token = await capsolver.solve(action.captchaType, action.siteKey, page.url)
        await page.evaluate((t) => { /* inject token */ }, token)
      else:
        action = { type: 'done_failed', reason: 'captcha_no_solver' }

    if action.type === 'submit_final':
      if args.submit:  await page.click(action.selector) → verify confirmation → done_success
      else:             # dry-run: log, skip the click
                        log('[apply-bot] DRY-RUN would click:', action.selector)
                        action = { type: 'done_success', mode: 'dry_run' }

  # Settlement
  persist application row: status ∈ { 'Applied', 'DryRun', 'Failed', 'Skipped' }
  persist trace: screenshots/<job_id>/ + actions.jsonl + final_dom.html
  close Chrome
```

## 8. Page-type classification (first agent decision)

One MiniMax image-01 call per step. Input: screenshot + condensed a11y tree. Output: JSON tag:

```json
{
  "page_type": "apply_form" | "redirect" | "already_applied" | "captcha" | "dead_end" | "confirmation",
  "confidence": 0.0-1.0,
  "evidence": "Text snippet or element that informed the classification"
}
```

- `apply_form` → extract field list, proceed to plan-and-fill.
- `redirect` → find the primary "Apply" button in a11y tree, click it.
- `already_applied` → mark `Skipped (already_applied)` and exit.
- `captcha` → plan_next_action returns a `solve_captcha` step.
- `dead_end` → "job not found" / 404 / LinkedIn auth wall → mark `Skipped (dead_end)`.
- `confirmation` → we just submitted; verify text and exit success.

## 9. Field-filling strategy

The agent composes a complete fill plan in ONE LLM call per form, then executes the actions sequentially (rather than one LLM call per field). Prompt input:

- A11y tree's interactive elements (inputs, selects, file inputs) flattened to JSON: `[{role, name, type, required, accessibleName, selector}]`.
- The user's `application_form_defaults` block.
- The JD summary (so it can answer "why this role?" questions).
- The cover letter text (for any "Why are you interested?" style text box).

LLM returns an ordered action list. apply-bot executes each, screenshots every 3-5 actions, and refreshes the a11y tree before the final Submit click to catch dynamically-added fields.

## 10. File structure

### New files
- `apply-bot.mjs` (~180 lines) — CLI orchestrator. Parses args, queries eligible jobs, dispatches to worker pool, collects stats.
- `lib/apply-agent.mjs` (~300 lines) — single-job loop: spawn browser → classify → plan → execute → settle.
- `lib/apply-prompt.mjs` (~180 lines) — prompts ported from ApplyPilot's `src/applypilot/apply/prompt.py`. One function per prompt (classifyPage, planNextAction).
- `lib/capsolver.mjs` (~80 lines) — HTTP wrapper around capsolver.com API. Supports hCaptcha / reCAPTCHA v2+v3 / Turnstile / FunCaptcha. Budget tracking.
- `templates/cover-letter-template.html` (~40 lines) — minimal styled template for cover-letter PDF rendering.
- `tests/apply-agent.test.mjs` (~250 lines) — 6–8 tests with mocked vision, mocked Playwright routes, mongodb-memory-server.
- `tests/capsolver.test.mjs` (~60 lines) — 2 tests stubbing HTTP, verifying token injection for hCaptcha + reCAPTCHA.
- `tests/fixtures/apply/*.html` — 4 fixture pages (redirect, apply_form, dead_end, confirmation) for agent tests.

### Modified files
- `lib/auto-prep.mjs` — extend `generateEvalBlocks` to produce `block_cover_letter` as a 6th field. Add a helper `writeCoverLetterArtifacts({blocks, paths})` that writes `cover_letter.md` + calls `renderPdf` for the PDF.
- `auto-prep.mjs` — invoke the new helper after the eval blocks land.
- `run-pipeline.mjs` — add `--auto-apply` flag; 5th stage invokes `runApplyBot({ submit })`.
- `config/profile.example.yml` — add `application_form_defaults` block per §5.
- `.env.example` — add `CAPSOLVER_API_KEY=`.
- `lib/db.mjs` — add `DryRun`, `Failed`, `Skipped` to the canonical states list (existing states include Evaluated, Applied, etc.).

### Unchanged
- Existing picker / assembler / auto-prep / scanner / scorer code paths.
- downstream modes (`oferta`, `pipeline`, etc.) read the same `cv.tailored.md` / picker PDF.

## 11. Status vocabulary (additions)

| Status | Meaning |
|---|---|
| `DryRun` | apply-bot ran in dry-run mode, form was filled but `--submit` was not set |
| `Applied` | apply-bot (or human) submitted successfully |
| `Failed` | apply-bot hit a blocker (CAPTCHA with no solver, agent step cap reached, unexpected exception). Retry eligible. |
| `Skipped` | Job URL unreachable, 404, "No longer accepting", or dead_end page classification |

Existing states (`Evaluated`, `Applied`, etc.) unchanged.

## 12. CAPSOLVER integration

`lib/capsolver.mjs` exports:
- `async solveCaptcha({ type, siteKey, pageUrl, apiKey })` → returns token string.
- `async getBalance(apiKey)` → returns USD balance.

Supported `type`: `'HCaptchaTaskProxyless'`, `'RecaptchaV2TaskProxyless'`, `'RecaptchaV3TaskProxyless'`, `'TurnstileTaskProxyless'`, `'FunCaptchaTaskProxyless'`.

Budget check: before each solve, call `getBalance` if this run's tally has crossed `capsolver_budget_usd - 1.0`. If over budget, short-circuit to `Failed (capsolver_budget_exhausted)`.

## 13. Per-job trace artifacts

For audit and debugging, each job writes:

- `screenshots/<job_id>/step_001.png`, `step_002.png`, … (every step)
- `screenshots/<job_id>/actions.jsonl` — one line per action with timestamp, type, selector, value/redacted
- `screenshots/<job_id>/final_dom.html` — page's HTML at exit (for failed jobs esp.)
- `screenshots/<job_id>/meta.json` — `{ job_id, company, role, url, mode, outcome, elapsed_ms, step_count, captchas_solved }`

`.gitignore` excludes `screenshots/`. `screenshots/` path is configurable via `application_form_defaults.auto_apply.trace_dir`.

## 14. Failure handling

| Failure mode | Behavior |
|---|---|
| Agent step cap reached (max_steps_per_job) | Mark `Failed (step_cap)`, retry eligible |
| Playwright timeout / nav error | Mark `Failed (nav_error)`, retry eligible |
| Chrome crash mid-job | Kill worker, restart Chrome, skip this job |
| LLM call fails | Retry once; on second failure mark `Failed (llm_error)` |
| CAPTCHA hit, CAPSOLVER disabled | Mark `Failed (captcha_no_solver)`, retry eligible (with solver later) |
| CAPSOLVER budget exhausted | Mark `Failed (capsolver_budget)`, retry next run if budget refilled |
| `already_applied` page detected | Mark `Skipped (already_applied)` — not retried |
| `dead_end` page (404, no-longer-accepting) | Mark `Skipped (dead_end)` — not retried |
| Single job exception | try/catch around each job; continue batch |

Retry eligibility: `--retry-failed` re-processes any job in `Failed` status. `Skipped` jobs are never retried automatically.

## 15. Testing plan

### `tests/apply-agent.test.mjs`
1. Plain Greenhouse form fills + reaches Submit (dry-run) → status=DryRun.
2. Form with file upload → verify `setInputFiles` called with correct PDF path.
3. CAPTCHA detected, `capsolver_enabled=false` → status=Failed(captcha_no_solver).
4. Dead-end page → status=Skipped(dead_end).
5. Redirect → click Apply → reach form → fill → Submit (dry-run).
6. Step cap reached (loop with no progress) → status=Failed(step_cap).
7. Already-applied page → status=Skipped(already_applied).
8. Real Submit click in non-dry-run → verify `page.click(submitSelector)` invoked.

### `tests/capsolver.test.mjs`
1. hCaptcha solve — stub HTTP, verify request shape + returns token.
2. reCAPTCHA v2 solve — stub HTTP, verify request shape + returns token.

### Integration
- Existing 187 tests + new apply-agent tests + capsolver tests = 196+ tests green.
- mongodb-memory-server for apply-bot e2e.

## 16. Ethical / TOS risks and mitigations

| Risk | Mitigation |
|---|---|
| Company identifies bot-submitted application, blacklists candidate | DR1 default lets user audit per-application behavior before flipping `--submit`. User owns the risk per explicit override of `CLAUDE.md`. |
| LinkedIn detects Playwright browsing and bans account | Agent doesn't log into LinkedIn; it only follows the public "Apply" button redirect. Any LinkedIn Easy-Apply dead-end → `Skipped`. |
| Misfilled form sends wrong salary / wrong availability | Profile-driven; the profile IS the truth. If the profile is wrong, the forms are wrong. User verifies profile before enabling `--submit`. |
| Over-application to one company → brand damage | Dedup X (per job_id) prevents duplicate per job. User declined per-company cap. Suggest manually maintaining a "never auto-apply" list in `company_blacklist` (already supported at ingest time). |
| CAPSOLVER cost blowout | Per-run budget cap (`capsolver_budget_usd` in profile). Stops cold when exceeded. |
| Bot-detection heuristics (mouse movements, typing speed) | Out of scope for v1; Playwright defaults. Add `playwright-stealth` plugin later if bans observed. |

## 17. Rollout

1. Land the code in one plan. All new paths default to `--dry-run`.
2. Run 3-5 dry-run invocations, audit screenshots + actions.jsonl manually.
3. For one specific job you WANT to apply to: `node apply-bot.mjs --submit --job-id=<id>`. Verify outcome on the company's site.
4. After 2-3 successful single-job submits, flip launchd's `run-pipeline.mjs --auto-apply --submit`.
5. Monitor `status=Failed` count daily. Investigate common blockers.

## 18. Integration with existing system

- `auto-prep` becomes a hard upstream dependency: jobs must have `status=Evaluated` (written by auto-prep). `apply-bot` does NOT re-classify or re-score.
- `merge-tracker.mjs` rendering of `data/applications.md` works unchanged; new statuses (DryRun/Failed/Skipped) appear in the Status column.
- `lib/reports.mjs` not modified; apply outcomes are stored on the application doc + in `screenshots/<job_id>/` (separate from `reports/`).
- `run-pipeline.mjs --auto-apply` runs the 5-stage pipeline end-to-end from cron — ingest → score → auto-prep → cover-letter rendering → auto-apply.
