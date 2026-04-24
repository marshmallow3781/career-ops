# Auto-Apply Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apply-bot.mjs` — autonomous browser agent that submits job applications via Playwright + MiniMax (image-01 vision + M2.7 text). Ports ApplyPilot's prompt engineering; ships with dry-run default + CAPSOLVER + multi-worker parallelism.

**Architecture:** Playwright-direct (no Claude Code CLI dep). Single LLM factory via `initLlm()`. Agent loop: screenshot → MiniMax image-01 classify → accessibility tree plan → execute. Mongo is the queue (jobs with `prefilter_score >= 9` and no application row). Per-job try/catch never aborts batch.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, Playwright (already installed), `mongodb-memory-server` for integration tests, MiniMax via Anthropic-SDK-compatible route (existing `initLlm()`).

**Spec reference:** `docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md` (commit `d64cfe8`).

> **⚠️ This feature explicitly overrides CLAUDE.md's "never auto-submit" rule.** All new source files must include a header comment referencing the spec's §1 override paragraph so future readers understand the deliberate deviation.

---

## File Structure

### Created
- `lib/capsolver.mjs` — HTTP wrapper for capsolver.com API.
- `lib/apply-prompt.mjs` — prompts ported from ApplyPilot (`classifyPagePrompt`, `planActionPrompt`).
- `lib/apply-agent.mjs` — single-job agent loop.
- `apply-bot.mjs` — CLI orchestrator + `runApplyBot` export.
- `templates/cover-letter-template.html` — minimal template for cover-letter PDF.
- `tests/capsolver.test.mjs`, `tests/apply-prompt.test.mjs`, `tests/apply-agent.test.mjs`, `tests/apply-bot.test.mjs`.
- `tests/fixtures/apply/{redirect,apply_form,dead_end,confirmation}.html`.

### Modified
- `lib/auto-prep.mjs` — extend `generateEvalBlocks` to produce `block_cover_letter`; add `writeCoverLetterArtifacts()`.
- `auto-prep.mjs` — invoke `writeCoverLetterArtifacts()` post-eval.
- `run-pipeline.mjs` — `--auto-apply` + `--submit` flags; 5th stage invocation.
- `config/profile.example.yml` — `application_form_defaults` block.
- `.env.example` — `CAPSOLVER_API_KEY=`.
- `lib/db.mjs` — add `DryRun`/`Failed`/`Skipped` to canonical states (if states list exists).

---

## Task 1: `lib/capsolver.mjs` + 2 tests

**Files:**
- Create: `lib/capsolver.mjs`
- Create: `tests/capsolver.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/capsolver.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveCaptcha, getBalance } from '../lib/capsolver.mjs';

// Mock fetch for deterministic tests
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    const next = responses.shift();
    return {
      ok: true,
      async json() { return next; },
    };
  };
  return calls;
}

test('solveCaptcha: hCaptcha happy path', async () => {
  const calls = mockFetch([
    { errorId: 0, taskId: 'task-123' },
    { errorId: 0, status: 'processing' },
    { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'TOKEN_XYZ' } },
  ]);
  const token = await solveCaptcha({
    type: 'HCaptchaTaskProxyless',
    siteKey: 'SITE_KEY',
    pageUrl: 'https://example.com/apply',
    apiKey: 'test-key',
    pollMs: 10,
  });
  assert.equal(token, 'TOKEN_XYZ');
  assert.equal(calls[0].url, 'https://api.capsolver.com/createTask');
  assert.equal(calls[0].body.task.type, 'HCaptchaTaskProxyless');
  assert.equal(calls[0].body.task.websiteKey, 'SITE_KEY');
});

test('solveCaptcha: throws on errorId', async () => {
  mockFetch([
    { errorId: 1, errorDescription: 'invalid key' },
  ]);
  await assert.rejects(
    () => solveCaptcha({ type: 'HCaptchaTaskProxyless', siteKey: 'x', pageUrl: 'y', apiKey: 'bad' }),
    /invalid key/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/xiaoxuan/resume/career-ops && node --test tests/capsolver.test.mjs
```

Expected: 2 failures with `Cannot find package '../lib/capsolver.mjs'`.

- [ ] **Step 3: Implement `lib/capsolver.mjs`**

```js
/**
 * lib/capsolver.mjs — capsolver.com API wrapper for CAPTCHA solving.
 *
 * Used by the auto-apply agent. Personal fork override of CLAUDE.md's
 * "never auto-submit" rule; see docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 *
 * Supported types: HCaptchaTaskProxyless, RecaptchaV2TaskProxyless,
 * RecaptchaV3TaskProxyless, TurnstileTaskProxyless, FunCaptchaTaskProxyless.
 */

const API_BASE = 'https://api.capsolver.com';

/**
 * Solve a CAPTCHA challenge. Creates a task, polls until ready, returns token.
 *
 * @param {object} p
 * @param {string} p.type - CapSolver task type
 * @param {string} p.siteKey - website captcha sitekey
 * @param {string} p.pageUrl - the page URL containing the captcha
 * @param {string} p.apiKey - capsolver API key
 * @param {number} [p.pollMs=5000] - polling interval
 * @param {number} [p.maxWaitMs=120000] - give up after this long
 * @returns {Promise<string>} the captcha solution token
 */
export async function solveCaptcha({ type, siteKey, pageUrl, apiKey, pollMs = 5000, maxWaitMs = 120000 }) {
  if (!apiKey) throw new Error('capsolver: missing apiKey');

  const createRes = await fetch(`${API_BASE}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type, websiteURL: pageUrl, websiteKey: siteKey },
    }),
  });
  const createJson = await createRes.json();
  if (createJson.errorId) {
    throw new Error(`capsolver createTask: ${createJson.errorDescription || 'unknown error'}`);
  }
  const taskId = createJson.taskId;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const json = await res.json();
    if (json.errorId) throw new Error(`capsolver getTaskResult: ${json.errorDescription || 'unknown'}`);
    if (json.status === 'ready') {
      const sol = json.solution || {};
      return sol.gRecaptchaResponse || sol.token || sol.text || JSON.stringify(sol);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`capsolver: timed out after ${maxWaitMs}ms`);
}

/**
 * Query the account balance in USD. Returns a number.
 */
export async function getBalance(apiKey) {
  if (!apiKey) throw new Error('capsolver: missing apiKey');
  const res = await fetch(`${API_BASE}/getBalance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey }),
  });
  const json = await res.json();
  if (json.errorId) throw new Error(`capsolver getBalance: ${json.errorDescription || 'unknown'}`);
  return Number(json.balance || 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/capsolver.test.mjs
```

Expected: `pass 2 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/capsolver.mjs tests/capsolver.test.mjs
git commit -m "feat(apply): add lib/capsolver.mjs CAPSOLVER HTTP wrapper"
```

---

## Task 2: Extend `generateEvalBlocks` with `block_cover_letter`

**Files:**
- Modify: `lib/auto-prep.mjs`
- Modify: `tests/auto-prep.test.mjs` (append 1 test)

- [ ] **Step 1: Write the failing test**

Append to `tests/auto-prep.test.mjs`:

```js
test('generateEvalBlocks: includes block_cover_letter in LLM output', async () => {
  const cl = '250 words of cover letter body referencing the role and company...';
  const responseJson = JSON.stringify({
    block_a: 'role summary',
    block_b_rows: [{ req: 'Go', evidence: 'LinkedIn' }],
    block_e: 'personalization plan',
    block_f_stories: [{ scenario: 'x', star_prompt: 'y' }],
    block_h_answers: [{ prompt: 'why acme?', answer: 'a' }],
    block_cover_letter: cl,
  });
  const client = mockLlmClient(responseJson);
  const result = await generateEvalBlocks({
    jdText: 'JD', candidateSummary: 'summary', tierBreakdown: null, existingStoryThemes: [],
    llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
  });
  assert.equal(result.block_cover_letter, cl);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: previous tests pass, 1 new fails because `result.block_cover_letter` is undefined (current code doesn't read that field).

- [ ] **Step 3: Extend `generateEvalBlocks` in `lib/auto-prep.mjs`**

Locate the SYSTEM_PROMPT constant and the return statement at the bottom of `generateEvalBlocks`. Replace the schema line in SYSTEM_PROMPT and add `block_cover_letter` to both emptyBlocks and the return.

Replace the schema block in SYSTEM_PROMPT from:

```js
const SYSTEM_PROMPT = `You are writing a job-match evaluation for the candidate.
Return ONLY JSON matching this schema:
{
  "block_a": string,                              // Role Summary: 2-3 sentences on what the role is
  "block_b_rows": [{"req": string, "evidence": string}, ...],  // 3-5 JD requirements mapped to candidate evidence
  "block_e": string,                              // Personalization plan: how to customize the application
  "block_f_stories": [{"scenario": string, "star_prompt": string}, ...],  // 3-5 STAR+R interview stories
  "block_h_answers": [{"prompt": string, "answer": string}, ...]          // 2-3 draft application answers
}
```

to:

```js
const SYSTEM_PROMPT = `You are writing a job-match evaluation for the candidate.
Return ONLY JSON matching this schema:
{
  "block_a": string,                              // Role Summary: 2-3 sentences on what the role is
  "block_b_rows": [{"req": string, "evidence": string}, ...],  // 3-5 JD requirements mapped to candidate evidence
  "block_e": string,                              // Personalization plan: how to customize the application
  "block_f_stories": [{"scenario": string, "star_prompt": string}, ...],  // 3-5 STAR+R interview stories
  "block_h_answers": [{"prompt": string, "answer": string}, ...],         // 2-3 draft application answers
  "block_cover_letter": string                    // 250-350 word cover letter, first-person, grounded in JD + candidate_summary
}
```

And in the return at the bottom of `generateEvalBlocks`, add the cover letter:

```js
  return {
    block_a: String(parsed.block_a || ''),
    block_b_rows: Array.isArray(parsed.block_b_rows) ? parsed.block_b_rows : [],
    block_e: String(parsed.block_e || ''),
    block_f_stories: Array.isArray(parsed.block_f_stories) ? parsed.block_f_stories : [],
    block_h_answers: Array.isArray(parsed.block_h_answers) ? parsed.block_h_answers : [],
    block_cover_letter: String(parsed.block_cover_letter || ''),
  };
```

And in `emptyBlocks()`:

```js
function emptyBlocks(extra = {}) {
  return {
    block_a: '',
    block_b_rows: [],
    block_e: '',
    block_f_stories: [],
    block_h_answers: [],
    block_cover_letter: '',
    ...extra,
  };
}
```

Bump `max_tokens` from `3000` to `4000` in both provider branches (anthropic and openai-compat) to accommodate the additional 250-350 words.

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: all prior tests still pass, new test passes. Total: previous count + 1.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-prep.mjs tests/auto-prep.test.mjs
git commit -m "feat(auto-prep): add block_cover_letter to generateEvalBlocks output"
```

---

## Task 3: Cover letter template + `writeCoverLetterArtifacts` + 1 test

**Files:**
- Create: `templates/cover-letter-template.html`
- Modify: `lib/auto-prep.mjs` (add `writeCoverLetterArtifacts` export)
- Modify: `auto-prep.mjs` (invoke the helper)
- Modify: `tests/auto-prep.test.mjs` (append 1 test)

- [ ] **Step 1: Create `templates/cover-letter-template.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  @page { size: letter; margin: 0.75in; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #222; font-size: 11pt; line-height: 1.5;
  }
  header { margin-bottom: 1.5em; }
  h1 { font-size: 14pt; margin: 0 0 0.25em; }
  .contact { font-size: 10pt; color: #555; }
  .date-company { margin: 1.5em 0; }
  .date-company div { margin: 0.2em 0; }
  .body { white-space: pre-wrap; }
  .body p { margin: 0.8em 0; }
  footer { margin-top: 2em; }
</style>
</head>
<body>
  <header>
    <h1>{{NAME}}</h1>
    <div class="contact">{{EMAIL}} · {{PHONE}} · {{LOCATION}}</div>
  </header>
  <div class="date-company">
    <div>{{DATE}}</div>
    <div>{{COMPANY}}</div>
    <div>Re: {{ROLE}}</div>
  </div>
  <div class="body"><!-- CV_CONTENT --></div>
  <footer>Sincerely,<br>{{NAME}}</footer>
</body>
</html>
```

- [ ] **Step 2: Write the failing test**

Append to `tests/auto-prep.test.mjs`:

```js
import { writeCoverLetterArtifacts } from '../lib/auto-prep.mjs';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('writeCoverLetterArtifacts: writes .md with cover letter body', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cl-'));
  const mdPath = join(tmp, 'cover_letter.md');
  const body = 'Dear Hiring Team,\n\nI am excited to apply...';
  const profile = {
    candidate: { full_name: 'Test User', email: 't@x.com', phone: '555' },
    location: { city: 'SF' },
  };
  const job = { company: 'Acme', title: 'Engineer' };
  await writeCoverLetterArtifacts({
    coverLetterMarkdown: body,
    profile, job,
    mdPath, pdfPath: null,  // skip PDF for this unit test
  });
  assert.ok(existsSync(mdPath));
  const written = readFileSync(mdPath, 'utf-8');
  assert.ok(written.includes('I am excited to apply'));
  rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: new test fails with `writeCoverLetterArtifacts is not a function`.

- [ ] **Step 4: Implement `writeCoverLetterArtifacts` in `lib/auto-prep.mjs`**

Append to `lib/auto-prep.mjs`:

```js
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Write the cover letter to disk as .md (always) and optionally render PDF.
 *
 * Personal fork override of CLAUDE.md's "never auto-submit" rule — this
 * artifact feeds the auto-apply agent. See spec §1.
 *
 * @param {object} p
 * @param {string} p.coverLetterMarkdown - LLM-generated body (from block_cover_letter)
 * @param {object} p.profile - loaded profile.yml object
 * @param {object} p.job - the Mongo jobs document
 * @param {string} p.mdPath - absolute path for the .md output
 * @param {string|null} p.pdfPath - absolute path for the PDF output; null to skip
 */
export async function writeCoverLetterArtifacts({ coverLetterMarkdown, profile, job, mdPath, pdfPath }) {
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, coverLetterMarkdown);

  if (!pdfPath) return;

  // Render PDF via the existing renderPdf factory + cover-letter template.
  const { renderPdf } = await import('../generate-pdf.mjs');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(__dirname, '..', 'templates', 'cover-letter-template.html');
  const template = readFileSync(templatePath, 'utf-8');

  const cand = profile?.candidate || {};
  const loc = profile?.location || {};
  const bodyHtml = coverLetterMarkdown
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');

  const html = template
    .replace(/\{\{NAME\}\}/g, cand.full_name || 'Candidate')
    .replace(/\{\{EMAIL\}\}/g, cand.email || '')
    .replace(/\{\{PHONE\}\}/g, cand.phone || '')
    .replace(/\{\{LOCATION\}\}/g, loc.city || '')
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{\{COMPANY\}\}/g, job.company || '')
    .replace(/\{\{ROLE\}\}/g, job.title || '')
    .replace('<!-- CV_CONTENT -->', bodyHtml);

  const tmpHtmlPath = mdPath.replace(/\.md$/, '.html');
  writeFileSync(tmpHtmlPath, html);
  await renderPdf({ htmlPath: tmpHtmlPath, pdfPath, format: 'letter' });
}
```

- [ ] **Step 5: Invoke the helper from `auto-prep.mjs`**

Locate the per-job loop in `auto-prep.mjs` where `blocks = await generateEvalBlocks(...)` happens. Add after the `appendStoryBank` call (or wherever the eval blocks are persisted):

```js
      // Cover letter artifacts — both .md and .pdf for the auto-apply agent.
      const coverMdPath  = resolve(__dirname, `cvs/${company_slug}/${title_slug}/${job_id}_cover_letter.md`);
      const coverPdfPath = resolve(__dirname, `cvs/${company_slug}/${title_slug}/${job_id}_cover_letter.pdf`);
      try {
        await writeCoverLetterArtifacts({
          coverLetterMarkdown: blocks.block_cover_letter || '',
          profile, job,
          mdPath: coverMdPath,
          pdfPath: coverPdfPath,
        });
      } catch (err) {
        console.error(`[auto-prep] cover-letter PDF failed for ${job.company}: ${err.message}`);
        // .md may still have been written; continue with the job
      }
```

Also add the import at the top of `auto-prep.mjs`:

```js
import { generateEvalBlocks, appendStoryBank, renderReport, writeCoverLetterArtifacts } from './lib/auto-prep.mjs';
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: all previous tests + 1 new = all green.

- [ ] **Step 7: Commit**

```bash
git add lib/auto-prep.mjs auto-prep.mjs templates/cover-letter-template.html tests/auto-prep.test.mjs
git commit -m "feat(auto-prep): write cover-letter artifacts (.md + .pdf) per job"
```

---

## Task 4: `lib/apply-prompt.mjs` + 3 tests

**Files:**
- Create: `lib/apply-prompt.mjs`
- Create: `tests/apply-prompt.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/apply-prompt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPagePrompt, planActionPrompt, parseClassifyResponse, parsePlanResponse } from '../lib/apply-prompt.mjs';

test('classifyPagePrompt: includes a11y tree + instructs JSON output', () => {
  const prompt = classifyPagePrompt({
    a11yTree: { role: 'main', children: [{ role: 'button', name: 'Apply' }] },
    url: 'https://linkedin.com/jobs/view/123',
  });
  assert.ok(prompt.includes('"role": "button"'));
  assert.ok(prompt.includes('page_type'));
  assert.ok(prompt.match(/apply_form|redirect|already_applied|captcha|dead_end|confirmation/));
});

test('parseClassifyResponse: extracts JSON from LLM text', () => {
  const r = parseClassifyResponse('Here is my analysis:\n{"page_type":"apply_form","confidence":0.9,"evidence":"form with name input"}');
  assert.equal(r.page_type, 'apply_form');
  assert.equal(r.confidence, 0.9);
});

test('parsePlanResponse: returns actions array with known types', () => {
  const r = parsePlanResponse(JSON.stringify({
    actions: [
      { type: 'fill', selector: '#email', value: 'x@y.com' },
      { type: 'upload', selector: '#resume', value: '/tmp/r.pdf' },
      { type: 'click', selector: 'button.submit' },
    ],
  }));
  assert.equal(r.actions.length, 3);
  assert.equal(r.actions[0].type, 'fill');
  assert.equal(r.actions[1].type, 'upload');
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
node --test tests/apply-prompt.test.mjs
```

Expected: 3 failures.

- [ ] **Step 3: Implement `lib/apply-prompt.mjs`**

```js
/**
 * lib/apply-prompt.mjs — prompts for the auto-apply agent.
 *
 * Ports ApplyPilot's (ApplyPilot/src/applypilot/apply/prompt.py) prompt
 * engineering but uses our own schema. Two prompt functions:
 *   - classifyPagePrompt — asks the LLM to label the current page type
 *   - planActionPrompt   — asks the LLM to propose the next action(s)
 *
 * Personal fork override of CLAUDE.md's "never auto-submit" rule; see
 * docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 */

const PAGE_TYPES = ['apply_form', 'redirect', 'already_applied', 'captcha', 'dead_end', 'confirmation'];

/**
 * Build the prompt for page-type classification.
 *
 * @param {object} p
 * @param {object} p.a11yTree - Playwright page.accessibility.snapshot() output
 * @param {string} p.url - current URL
 * @returns {string} the full user-message prompt
 */
export function classifyPagePrompt({ a11yTree, url }) {
  return `You are classifying the current browser page for a job application agent.

Current URL: ${url}

Accessibility tree (JSON):
${JSON.stringify(a11yTree, null, 2).slice(0, 6000)}

Classify the page. Return ONLY JSON matching this schema:
{
  "page_type": one of ${JSON.stringify(PAGE_TYPES)},
  "confidence": number 0.0-1.0,
  "evidence": "short phrase describing the decisive signal"
}

Definitions:
- apply_form: a form with input fields we should fill (name, email, resume upload, cover letter, etc.)
- redirect: a job-detail page with an "Apply" button we should click to go to the real form
- already_applied: a page stating the user has already submitted an application
- captcha: a CAPTCHA challenge we need to solve before proceeding
- dead_end: 404, "No longer accepting applications", "job not found", or auth wall
- confirmation: a post-submission success page confirming the application was received`;
}

/**
 * Build the prompt for planning the next batch of actions.
 *
 * @param {object} p
 * @param {string} p.pageType - from prior classify step
 * @param {object} p.a11yTree - Playwright accessibility tree
 * @param {string} p.url - current URL
 * @param {object} p.profile - application_form_defaults block
 * @param {object} p.job - { company, title, jd_text }
 * @param {object} p.files - { resume_pdf, cover_letter_pdf, cover_letter_text }
 * @param {Array} p.stepHistory - previous steps (prevents loops)
 * @returns {string} the full user-message prompt
 */
export function planActionPrompt({ pageType, a11yTree, url, profile, job, files, stepHistory }) {
  const profileStr = JSON.stringify(profile, null, 2);
  const jobStr = JSON.stringify({ company: job.company, title: job.title }, null, 2);
  const filesStr = JSON.stringify(files, null, 2);
  const historyStr = stepHistory?.length
    ? stepHistory.slice(-5).map((s, i) => `Step ${stepHistory.length - 5 + i + 1}: ${s.type} ${s.selector || ''}`).join('\n')
    : '(none)';

  return `You are driving a Playwright browser to fill a job application form.

Page type: ${pageType}
Current URL: ${url}
Recent actions:
${historyStr}

Accessibility tree (JSON):
${JSON.stringify(a11yTree, null, 2).slice(0, 10000)}

Applicant profile (use these values verbatim where they match form fields):
${profileStr}

Target job:
${jobStr}

Local files available:
${filesStr}

Return ONLY JSON matching this schema:
{
  "actions": [
    { "type": "fill" | "click" | "upload" | "select" | "solve_captcha" | "submit_final" | "done_success" | "done_failed",
      "selector": string,      // CSS selector or a11y accessibleName
      "value": string,         // for fill/select/upload; path for upload
      "reason": string         // short explanation for the action
    },
    ...
  ]
}

Rules:
- Plan the complete form fill in one batch — 5-20 actions is typical.
- Use file paths from <files> for upload actions.
- For EEO questions, use the "Decline" / "Prefer not to answer" values from profile when present.
- The FINAL action of a successful fill MUST be { "type": "submit_final", "selector": "<the Submit button>", ... }.
- If the page is already_applied or dead_end, return { "actions": [{ "type": "done_failed", "reason": "<why>" }] }.
- If the page is confirmation (post-submit), return { "actions": [{ "type": "done_success", "reason": "confirmed" }] }.
- Never invent profile values. If a required field has no value in profile, return done_failed.
- Never re-submit if a recent action was submit_final.`;
}

/**
 * Extract the classify JSON from an LLM text response (handles prose prefix).
 */
export function parseClassifyResponse(text) {
  return _extractJson(text) || { page_type: 'dead_end', confidence: 0, evidence: 'parse_failed' };
}

/**
 * Extract the plan JSON from an LLM text response.
 */
export function parsePlanResponse(text) {
  const parsed = _extractJson(text);
  if (!parsed || !Array.isArray(parsed.actions)) {
    return { actions: [{ type: 'done_failed', reason: 'parse_failed' }] };
  }
  return parsed;
}

// Same brace-counting extractor as digest-builder.mjs (pattern locked by
// the earlier brace-counter hardening commit 9d5c248).
function _extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end === -1) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/apply-prompt.test.mjs
```

Expected: `pass 3 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/apply-prompt.mjs tests/apply-prompt.test.mjs
git commit -m "feat(apply): add lib/apply-prompt.mjs (classify + plan prompts)"
```

---

## Task 5: `lib/apply-agent.mjs` + 4 tests + fixtures

**Files:**
- Create: `lib/apply-agent.mjs`
- Create: `tests/apply-agent.test.mjs`
- Create: `tests/fixtures/apply/apply_form.html`, `redirect.html`, `dead_end.html`, `confirmation.html`

- [ ] **Step 1: Create fixture HTML files**

`tests/fixtures/apply/apply_form.html`:

```html
<!DOCTYPE html>
<html><body>
<h1>Apply: Senior Backend Engineer at Acme</h1>
<form id="apply">
  <label>Full Name <input id="name" name="name" required></label>
  <label>Email <input id="email" name="email" type="email" required></label>
  <label>Resume <input id="resume" name="resume" type="file" required></label>
  <label>Cover Letter <textarea id="cover" name="cover"></textarea></label>
  <button id="submit" type="submit">Submit Application</button>
</form>
</body></html>
```

`tests/fixtures/apply/redirect.html`:

```html
<!DOCTYPE html>
<html><body>
<h1>Senior Backend Engineer — Acme Corp</h1>
<p>We are hiring a senior backend engineer. Please click Apply to continue.</p>
<a id="apply-link" href="./apply_form.html" role="button">Apply Now</a>
</body></html>
```

`tests/fixtures/apply/dead_end.html`:

```html
<!DOCTYPE html>
<html><head><title>Job Not Found</title></head>
<body><p>This job is no longer accepting applications.</p></body></html>
```

`tests/fixtures/apply/confirmation.html`:

```html
<!DOCTYPE html>
<html><body>
<h1>Thank you!</h1>
<p>Your application has been received. We'll review it and get back to you.</p>
</body></html>
```

- [ ] **Step 2: Write failing tests**

Create `tests/apply-agent.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runApplyAgent } from '../lib/apply-agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, 'fixtures/apply');

function mockLlmClient(sequence) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const text = sequence[i++] || sequence[sequence.length - 1];
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

const profile = {
  personal: { full_name: 'Test User', email: 't@x.com', phone: '555', address: '1 Main', city: 'SF', province_state: 'CA', country: 'US', postal_code: '94102' },
  work_authorization: { legally_authorized_to_work: 'Yes', require_sponsorship: 'No' },
  availability: { earliest_start_date: 'Immediately' },
  compensation: { salary_expectation: '200000', salary_currency: 'USD' },
  experience: { years_of_experience_total: '5', education_level: "Bachelor's Degree" },
  eeo_voluntary: { gender: 'Decline', race_ethnicity: 'Decline', veteran_status: 'Not a protected veteran', disability_status: 'Prefer not' },
};

const job = { company: 'Acme', title: 'Senior Backend Engineer', url: `file://${FIX}/apply_form.html` };
const files = { resume_pdf: '/tmp/resume.pdf', cover_letter_pdf: '/tmp/cl.pdf', cover_letter_text: 'Dear...' };

test('runApplyAgent: apply_form + dry-run → DryRun status', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'apply_form', confidence: 0.95, evidence: 'form present' }),
    JSON.stringify({
      actions: [
        { type: 'fill', selector: 'input[name="name"]', value: 'Test User' },
        { type: 'fill', selector: 'input[name="email"]', value: 't@x.com' },
        { type: 'fill', selector: 'textarea[name="cover"]', value: 'Dear...' },
        { type: 'submit_final', selector: 'button[type="submit"]', reason: 'ready to submit' },
      ],
    }),
    JSON.stringify({ page_type: 'confirmation', confidence: 0.9, evidence: 'thank you' }),
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const result = await runApplyAgent({
      job, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 10, traceDir: null,
    });
    assert.equal(result.status, 'DryRun');
    assert.ok(result.stepCount >= 1);
  } finally {
    await browser.close();
  }
});

test('runApplyAgent: dead_end page → Skipped status', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'dead_end', confidence: 0.95, evidence: 'no longer accepting' }),
  ]);
  const browser = await chromium.launch({ headless: true });
  const deadJob = { ...job, url: `file://${FIX}/dead_end.html` };
  try {
    const result = await runApplyAgent({
      job: deadJob, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 10, traceDir: null,
    });
    assert.equal(result.status, 'Skipped');
    assert.match(result.reason || '', /dead_end/);
  } finally {
    await browser.close();
  }
});

test('runApplyAgent: redirect → follow to form → fill → DryRun', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'redirect', confidence: 0.9, evidence: 'apply button' }),
    JSON.stringify({ actions: [{ type: 'click', selector: 'a#apply-link', reason: 'follow redirect' }] }),
    JSON.stringify({ page_type: 'apply_form', confidence: 0.9, evidence: 'form' }),
    JSON.stringify({
      actions: [
        { type: 'fill', selector: 'input[name="name"]', value: 'Test User' },
        { type: 'submit_final', selector: 'button[type="submit"]', reason: 'ready' },
      ],
    }),
    JSON.stringify({ page_type: 'confirmation', confidence: 0.9, evidence: 'thank you' }),
  ]);
  const browser = await chromium.launch({ headless: true });
  const redirJob = { ...job, url: `file://${FIX}/redirect.html` };
  try {
    const result = await runApplyAgent({
      job: redirJob, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 10, traceDir: null,
    });
    assert.equal(result.status, 'DryRun');
  } finally {
    await browser.close();
  }
});

test('runApplyAgent: step cap reached → Failed status', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'apply_form', confidence: 0.9, evidence: 'form' }),
    JSON.stringify({ actions: [{ type: 'fill', selector: 'input[name="name"]', value: 'x' }] }),
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const result = await runApplyAgent({
      job, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 2, traceDir: null,  // cap at 2
    });
    assert.equal(result.status, 'Failed');
    assert.match(result.reason || '', /step_cap/);
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 3: Run to verify tests fail**

```bash
node --test tests/apply-agent.test.mjs
```

Expected: 4 failures with `Cannot find package '../lib/apply-agent.mjs'`.

- [ ] **Step 4: Implement `lib/apply-agent.mjs`**

```js
/**
 * lib/apply-agent.mjs — single-job auto-apply agent loop.
 *
 * Drives a Playwright Chromium instance to fill and (optionally) submit a
 * job application form. Uses MiniMax image-01 for vision + M2.7 for text
 * via the existing initLlm() factory. Ports ApplyPilot's agent loop
 * pattern but runs in-process.
 *
 * Personal fork override of CLAUDE.md's "never auto-submit" rule; see
 * docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyPagePrompt, planActionPrompt,
  parseClassifyResponse, parsePlanResponse,
} from './apply-prompt.mjs';

const DEFAULT_MAX_STEPS = 25;

/**
 * Run the apply agent for a single job.
 *
 * @param {object} p
 * @param {object} p.job - Mongo jobs doc (company, title, url, etc.)
 * @param {object} p.profile - application_form_defaults block from profile.yml
 * @param {object} p.files - { resume_pdf, cover_letter_pdf, cover_letter_text } absolute paths
 * @param {object} p.llmClient - initLlm() client
 * @param {object} p.llmConfig - initLlm() config
 * @param {object} p.browser - Playwright browser instance
 * @param {boolean} p.submit - if true, click real Submit; else stop at submit_final action
 * @param {number} [p.maxSteps=25]
 * @param {string|null} [p.traceDir] - directory for screenshots/actions/dom; null to skip
 * @param {Function} [p.capsolve] - async fn({type,siteKey,pageUrl}) → token; null to mark Failed on captcha
 * @returns {Promise<{status: 'Applied'|'DryRun'|'Failed'|'Skipped', reason?: string, stepCount: number}>}
 */
export async function runApplyAgent({
  job, profile, files, llmClient, llmConfig, browser,
  submit = false, maxSteps = DEFAULT_MAX_STEPS, traceDir = null,
  capsolve = null,
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const stepHistory = [];
  let result = { status: 'Failed', reason: 'loop_exit_without_outcome', stepCount: 0 };

  if (traceDir) mkdirSync(traceDir, { recursive: true });
  const actionsLogPath = traceDir ? join(traceDir, 'actions.jsonl') : null;

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    result = { status: 'Skipped', reason: `nav_error: ${e.message.slice(0, 80)}`, stepCount: 0 };
    await context.close();
    return result;
  }

  for (let step = 1; step <= maxSteps; step++) {
    result.stepCount = step;

    if (traceDir) {
      try { await page.screenshot({ path: join(traceDir, `step_${String(step).padStart(3, '0')}.png`) }); }
      catch { /* ignore */ }
    }

    const a11yTree = await page.accessibility.snapshot().catch(() => ({ role: 'page', children: [] }));
    const url = page.url();

    // Classify page
    const classifyText = await _llmCall(llmClient, llmConfig, classifyPagePrompt({ a11yTree, url }));
    const classify = parseClassifyResponse(classifyText);

    if (classify.page_type === 'already_applied') {
      result = { status: 'Skipped', reason: 'already_applied', stepCount: step };
      break;
    }
    if (classify.page_type === 'dead_end') {
      result = { status: 'Skipped', reason: `dead_end: ${classify.evidence || 'no-signal'}`, stepCount: step };
      break;
    }
    if (classify.page_type === 'confirmation') {
      result = { status: submit ? 'Applied' : 'DryRun', reason: 'confirmation_page', stepCount: step };
      break;
    }
    if (classify.page_type === 'captcha') {
      if (!capsolve) {
        result = { status: 'Failed', reason: 'captcha_no_solver', stepCount: step };
        break;
      }
      try {
        const siteKey = _extractCaptchaSiteKey(a11yTree);
        const token = await capsolve({ type: 'HCaptchaTaskProxyless', siteKey, pageUrl: url });
        await page.evaluate((t) => {
          const el = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]');
          if (el) el.value = t;
        }, token);
        stepHistory.push({ type: 'solve_captcha', selector: null });
        continue;
      } catch (e) {
        result = { status: 'Failed', reason: `captcha_solve: ${e.message.slice(0, 80)}`, stepCount: step };
        break;
      }
    }

    // Plan next actions
    const planText = await _llmCall(llmClient, llmConfig, planActionPrompt({
      pageType: classify.page_type, a11yTree, url, profile, job, files, stepHistory,
    }));
    const plan = parsePlanResponse(planText);

    let breakLoop = false;
    for (const action of plan.actions) {
      if (actionsLogPath) appendFileSync(actionsLogPath, JSON.stringify({ t: Date.now(), step, ...action }) + '\n');
      stepHistory.push({ type: action.type, selector: action.selector });

      if (action.type === 'done_success') { result = { status: submit ? 'Applied' : 'DryRun', reason: action.reason || 'done', stepCount: step }; breakLoop = true; break; }
      if (action.type === 'done_failed')  { result = { status: 'Failed', reason: action.reason || 'agent_decided_failed', stepCount: step }; breakLoop = true; break; }

      try {
        if (action.type === 'click')  await page.click(action.selector, { timeout: 5000 });
        else if (action.type === 'fill')   await page.fill(action.selector, String(action.value ?? ''), { timeout: 5000 });
        else if (action.type === 'upload') await page.setInputFiles(action.selector, action.value);
        else if (action.type === 'select') await page.selectOption(action.selector, String(action.value ?? ''));
        else if (action.type === 'submit_final') {
          if (submit) {
            await page.click(action.selector, { timeout: 5000 });
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            // loop re-classifies on next iteration; we expect confirmation
          } else {
            result = { status: 'DryRun', reason: 'submit_final_skipped', stepCount: step };
            breakLoop = true; break;
          }
        }
      } catch (err) {
        result = { status: 'Failed', reason: `action_error: ${action.type} ${err.message.slice(0, 60)}`, stepCount: step };
        breakLoop = true; break;
      }
    }

    if (breakLoop) break;

    if (step === maxSteps) {
      result = { status: 'Failed', reason: 'step_cap', stepCount: step };
    }
  }

  // Dump final DOM for trace
  if (traceDir) {
    try {
      const dom = await page.content();
      writeFileSync(join(traceDir, 'final_dom.html'), dom);
      writeFileSync(join(traceDir, 'meta.json'), JSON.stringify({
        job_id: job.linkedin_id || job.url, company: job.company, title: job.title,
        mode: submit ? 'submit' : 'dry_run', outcome: result.status,
        stepCount: result.stepCount, reason: result.reason || null,
        ended_at: new Date().toISOString(),
      }, null, 2));
    } catch { /* ignore */ }
  }

  await context.close();
  return result;
}

async function _llmCall(client, config, userMessage) {
  // Uses the anthropic code path (works with MiniMax via ANTHROPIC_BASE_URL).
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 2500,
    temperature: 0,
    messages: [{ role: 'user', content: userMessage }],
  });
  return (response.content || [])
    .filter(b => typeof b?.text === 'string')
    .map(b => b.text).join('\n').trim();
}

function _extractCaptchaSiteKey(a11yTree) {
  // Walk the a11y tree for a node mentioning a sitekey attribute.
  const stack = [a11yTree];
  while (stack.length) {
    const n = stack.pop();
    if (n?.value && typeof n.value === 'string' && n.value.length > 16) return n.value;
    if (n?.children) stack.push(...n.children);
  }
  return '';
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test tests/apply-agent.test.mjs
```

Expected: `pass 4 fail 0`. Playwright launch takes ~3-5s per test.

- [ ] **Step 6: Commit**

```bash
git add lib/apply-agent.mjs tests/apply-agent.test.mjs tests/fixtures/apply/
git commit -m "feat(apply): add lib/apply-agent.mjs single-job Playwright loop"
```

---

## Task 6: `apply-bot.mjs` orchestrator + 2 e2e tests

**Files:**
- Create: `apply-bot.mjs`
- Create: `tests/apply-bot.test.mjs`

- [ ] **Step 1: Write failing e2e tests**

Create `tests/apply-bot.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetDbForTesting, connectWithClient } from '../lib/db.mjs';
import { runApplyBot } from '../apply-bot.mjs';

test('runApplyBot: skips jobs already in applications collection', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-apply-bot-dedup');
  const db = client.db('test-apply-bot-dedup');

  try {
    await db.collection('jobs').insertOne({
      linkedin_id: 'j-applied',
      stage: 'scored',
      prefilter_score: 9,
      company: 'A', title: 'Backend',
      first_seen_at: new Date(),
      url: 'file:///dev/null',
    });
    await db.collection('applications').insertOne({
      num: 1, job_id: 'j-applied', status: 'Applied',
    });

    const result = await runApplyBot({
      minScore: 9, submit: false, workers: 1,
      mockAgent: async () => ({ status: 'DryRun', stepCount: 1 }),
    });
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_already_applied, 1);
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});

test('runApplyBot: one eligible job → mockAgent called → applications row created', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-apply-bot-happy');
  const db = client.db('test-apply-bot-happy');

  try {
    await db.collection('jobs').insertOne({
      linkedin_id: 'j-new',
      stage: 'scored',
      prefilter_score: 10,
      company: 'Z', title: 'Backend',
      first_seen_at: new Date(),
      url: 'file:///dev/null',
      prefilter_archetype: 'backend',
    });

    const calls = [];
    const result = await runApplyBot({
      minScore: 9, submit: false, workers: 1,
      mockAgent: async (args) => {
        calls.push(args.job.linkedin_id);
        return { status: 'DryRun', stepCount: 3, reason: 'mock' };
      },
    });
    assert.equal(result.processed, 1);
    assert.equal(calls[0], 'j-new');
    const app = await db.collection('applications').findOne({ job_id: 'j-new' });
    assert.equal(app.status, 'DryRun');
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
node --test tests/apply-bot.test.mjs
```

Expected: 2 failures with `Cannot find package '../apply-bot.mjs'`.

- [ ] **Step 3: Implement `apply-bot.mjs`**

```js
#!/usr/bin/env node
/**
 * apply-bot.mjs — autonomous application submission orchestrator.
 *
 * Personal fork override of CLAUDE.md's "never auto-submit" rule; see
 * docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 *
 * Usage:
 *   node apply-bot.mjs                             # dry-run (default)
 *   node apply-bot.mjs --submit                    # real submit
 *   node apply-bot.mjs --workers=2                 # N parallel Chrome
 *   node apply-bot.mjs --job-id=4395215171         # single job
 *   node apply-bot.mjs --retry-failed              # re-run Failed jobs
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

import { getDb, closeDb, upsertApplication, getNextApplicationNum } from './lib/db.mjs';
import { runApplyAgent } from './lib/apply-agent.mjs';
import { solveCaptcha } from './lib/capsolver.mjs';
import { initLlm } from './lib/llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const TRACE_ROOT = resolve(__dirname, 'screenshots');

function parseArgs(argv) {
  const out = { minScore: null, submit: false, workers: null, jobId: null, retryFailed: false };
  for (const a of argv) {
    if (a === '--submit') out.submit = true;
    else if (a === '--retry-failed') out.retryFailed = true;
    else if (a.startsWith('--min-score=')) out.minScore = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--workers=')) out.workers = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--job-id=')) out.jobId = a.split('=')[1];
  }
  return out;
}

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (err) { results[idx] = { __error: err.message }; }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Core orchestration. Exported for tests.
 */
export async function runApplyBot({
  minScore: explicitMinScore = null, submit = false, workers: explicitWorkers = null,
  jobId = null, retryFailed = false,
  mockAgent = null,  // test hook
} = {}) {
  const profile = existsSync(PROFILE_PATH) ? yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) : {};
  const formDefaults = profile?.application_form_defaults || {};
  const autoApply = formDefaults.auto_apply || {};
  const minScore = explicitMinScore ?? autoApply.min_score ?? 9;
  const workers = explicitWorkers ?? autoApply.workers ?? 2;

  const db = await getDb();
  const appliedJobIds = new Set(
    (await db.collection('applications').find({}, { projection: { job_id: 1, _id: 0 } }).toArray()).map(a => a.job_id)
  );

  let candidates;
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  if (jobId) {
    candidates = await db.collection('jobs').find({ linkedin_id: jobId }).toArray();
  } else if (retryFailed) {
    const failedIds = (await db.collection('applications').find({ status: 'Failed' }, { projection: { job_id: 1 } }).toArray()).map(a => a.job_id);
    candidates = await db.collection('jobs').find({ linkedin_id: { $in: failedIds } }).toArray();
  } else {
    candidates = await db.collection('jobs').find({
      first_seen_at: { $gte: cutoff },
      stage: 'scored',
      prefilter_score: { $gte: minScore },
    }).sort({ prefilter_score: -1 }).toArray();
  }

  const eligible = [];
  const stats = { processed: 0, skipped_already_applied: 0, errors: 0, applied: 0, dry_run: 0, failed: 0, skipped: 0 };
  for (const j of candidates) {
    const jobKey = j.linkedin_id || j.url || '';
    if (!retryFailed && appliedJobIds.has(jobKey)) { stats.skipped_already_applied++; continue; }
    eligible.push(j);
  }
  console.error(`[apply-bot] ${eligible.length} eligible jobs (${stats.skipped_already_applied} skipped_already_applied), submit=${submit}, workers=${workers}`);

  // LLM client (vision + text both go through this path)
  const { client: llmClient, config: llmConfig } = initLlm();

  // CAPSOLVER — optional
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const capsolveFn = capsolverKey && autoApply.capsolver_enabled
    ? (p) => solveCaptcha({ ...p, apiKey: capsolverKey })
    : null;

  // Browser lifecycle — one browser per worker, reused across jobs
  const browsers = mockAgent ? [] : await Promise.all(Array.from({ length: workers }, () => chromium.launch({ headless: true })));

  try {
    await mapConcurrent(eligible, workers, async (job, idx) => {
      const workerIdx = idx % workers;
      const browser = browsers[workerIdx];
      const jobKey = job.linkedin_id || job.url || `job-${idx}`;

      const resumePdf = _resolveResumePdf(profile, job);
      const coverLetterMdPath = resolve(__dirname, `cvs/${job.company_slug || 'unknown'}/${(job.title_normalized || 'role').slice(0, 60)}/${jobKey}_cover_letter.md`);
      const coverLetterPdfPath = coverLetterMdPath.replace(/\.md$/, '.pdf');
      const coverLetterText = existsSync(coverLetterMdPath) ? readFileSync(coverLetterMdPath, 'utf-8') : '';

      const files = {
        resume_pdf: resumePdf,
        cover_letter_pdf: existsSync(coverLetterPdfPath) ? coverLetterPdfPath : null,
        cover_letter_text: coverLetterText,
      };

      const traceDir = resolve(TRACE_ROOT, String(jobKey));

      try {
        const agentResult = mockAgent
          ? await mockAgent({ job, profile: formDefaults, files, submit })
          : await runApplyAgent({
              job, profile: formDefaults, files, llmClient, llmConfig, browser,
              submit, maxSteps: autoApply.max_steps_per_job || 25, traceDir,
              capsolve: capsolveFn,
            });

        if (agentResult.status === 'Applied') stats.applied++;
        else if (agentResult.status === 'DryRun') stats.dry_run++;
        else if (agentResult.status === 'Failed') stats.failed++;
        else if (agentResult.status === 'Skipped') stats.skipped++;
        stats.processed++;

        const num = await getNextApplicationNum();
        await upsertApplication({
          num,
          job_id: jobKey,
          company: job.company,
          role: job.title,
          url: job.url || '',
          status: agentResult.status,
          date: new Date().toISOString().slice(0, 10),
          score: typeof job.prefilter_score === 'number' ? Number((job.prefilter_score / 2).toFixed(1)) : null,
          notes: `apply-bot ${submit ? 'submit' : 'dry-run'} (${agentResult.reason || 'ok'})`,
          pdf_generated: true,
          report_id: null,
          cv_artifact_ids: [],
        });

        console.error(`[apply-bot] ${agentResult.status === 'Applied' || agentResult.status === 'DryRun' ? '✓' : '✗'} ${job.company}: ${job.title} — ${agentResult.status} (${agentResult.reason || 'ok'})`);
      } catch (err) {
        stats.errors++;
        console.error(`[apply-bot] ✗ ${job.company}: ${job.title} — ${err.message.slice(0, 120)}`);
      }
    });
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
  }

  console.error(`[apply-bot] done  processed=${stats.processed}  applied=${stats.applied}  dry_run=${stats.dry_run}  failed=${stats.failed}  skipped=${stats.skipped}  errors=${stats.errors}  skipped_already_applied=${stats.skipped_already_applied}`);
  return stats;
}

function _resolveResumePdf(profile, job) {
  const pickerCfg = profile?.cv?.picker || {};
  const resumesDir = pickerCfg.resumes_dir
    ? (pickerCfg.resumes_dir.startsWith('/') ? pickerCfg.resumes_dir : resolve(__dirname, pickerCfg.resumes_dir))
    : resolve(__dirname, 'resumes');
  const fname = pickerCfg.archetype_map?.[job.prefilter_archetype];
  return fname ? resolve(resumesDir, fname) : resolve(resumesDir, 'backend_ai_2.0.pdf');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await runApplyBot(args);
  } finally {
    await closeDb().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async err => {
    console.error('apply-bot.mjs crashed:', err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/apply-bot.test.mjs
```

Expected: `pass 2 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apply-bot.mjs tests/apply-bot.test.mjs
git commit -m "feat(apply): add apply-bot.mjs orchestrator + 2 e2e tests"
```

---

## Task 7: Wire `--auto-apply` + `--submit` into `run-pipeline.mjs`

**Files:**
- Modify: `run-pipeline.mjs`

- [ ] **Step 1: Update parseArgs**

In `run-pipeline.mjs`, locate `parseArgs` and replace with:

```js
function parseArgs(argv) {
  const out = { locations: null, hours: null, skipApify: false, skipScan: false, includeAssembler: false, autoApply: false, submit: false };
  for (const a of argv) {
    if (a === '--skip-apify') out.skipApify = true;
    else if (a === '--skip-scan') out.skipScan = true;
    else if (a === '--include-assembler') out.includeAssembler = true;
    else if (a === '--auto-apply') out.autoApply = true;
    else if (a === '--submit') out.submit = true;
    else if (a.startsWith('--location=')) out.locations = [a.split('=')[1]];
    else if (a.startsWith('--locations=')) out.locations = a.split('=')[1].split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--hours=')) out.hours = parseInt(a.split('=')[1], 10);
  }
  return out;
}
```

- [ ] **Step 2: Add stage 5 function + import**

Add import at the top of run-pipeline.mjs, alongside existing imports:

```js
import { runApplyBot } from './apply-bot.mjs';
```

Add a new stage function above `main()`:

```js
async function stage5ApplyBot({ submit }) {
  console.error(`[pipeline] auto-apply starting… submit=${submit}`);
  try {
    return await runApplyBot({ submit });
  } catch (e) {
    console.error(`[pipeline] auto-apply failed: ${e.message}`);
  }
}
```

- [ ] **Step 3: Wire into main()**

Locate the `main()` function and add the 5th-stage conditional after `stage4AutoPrep`:

```js
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  try {
    if (!args.skipApify) await stage1Apify({ locations: args.locations, hours: args.hours });
    if (!args.skipScan)  await stage2Scan({ hours: args.hours });
    await stage3Score({ hours: args.hours });
    await stage4AutoPrep({ hours: args.hours, includeAssembler: args.includeAssembler });
    if (args.autoApply) await stage5ApplyBot({ submit: args.submit });
  } catch (err) {
    console.error('[pipeline] fatal:', err.message);
  } finally {
    await closeDb().catch(() => {});
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[pipeline] total elapsed: ${elapsed}s`);
}
```

- [ ] **Step 4: Syntax + regression check**

```bash
node --check run-pipeline.mjs && echo "syntax OK"
node --test tests/*.test.mjs 2>&1 | tail -6
```

Expected: syntax OK. Full suite still green (~200 pass / 1 skip / 0 fail including the new apply tests).

- [ ] **Step 5: Commit**

```bash
git add run-pipeline.mjs
git commit -m "feat(pipeline): add --auto-apply + --submit flags to run-pipeline.mjs"
```

---

## Task 8: Config + .env.example + db.mjs canonical states

**Files:**
- Modify: `config/profile.example.yml`
- Modify: `.env.example`
- Modify: `lib/db.mjs` (only if a canonical-states list exists)

- [ ] **Step 1: Append `application_form_defaults` to `config/profile.example.yml`**

Locate the end of the existing `cv:` block (it already has `picker:` and `auto_prep:` subkeys from prior commits). Add, at the bottom of the file:

```yaml

# Auto-apply agent (apply-bot.mjs).
# Ships dry-run by default; pass --submit to unlock real submissions.
# OVERRIDE of CLAUDE.md "never auto-submit" rule — deliberate choice.
application_form_defaults:
  personal:
    full_name: "Your Name"
    preferred_name: ""
    email: "you@example.com"
    phone: "+1-555-0100"
    address: ""
    city: "San Francisco"
    province_state: "CA"
    country: "United States"
    postal_code: ""
    linkedin_url: ""
    github_url: ""
    portfolio_url: ""
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
    current_job_title: ""
    current_company: ""
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

Verify it parses:

```bash
node -e "const y=require('js-yaml');const p=y.load(require('fs').readFileSync('config/profile.example.yml','utf-8'));console.log(JSON.stringify(p.application_form_defaults?.auto_apply || {missing:true}, null, 2))"
```

Expected output: `{ "enabled": true, "min_score": 9, "workers": 2, ... }`.

- [ ] **Step 2: Update `.env.example`**

Locate `.env.example` (create if missing). Append:

```
# Auto-apply CAPSOLVER integration (optional). Without this, CAPTCHA-gated
# application forms get marked Failed. Free tier $0.50, pay-as-you-go.
# See https://capsolver.com/
CAPSOLVER_API_KEY=
```

- [ ] **Step 3: Add canonical states to `templates/states.yml` if it exists**

```bash
cat templates/states.yml 2>/dev/null | head -10
```

If the file exists, append (avoiding duplicates):

```yaml
  - DryRun
  - Failed
  - Skipped
```

If the file does NOT exist, skip this step — there's no canonical states registry and the code accepts arbitrary strings.

- [ ] **Step 4: Commit**

```bash
git add config/profile.example.yml .env.example
# include templates/states.yml only if it was modified
git commit -m "config: add application_form_defaults + CAPSOLVER_API_KEY"
```

---

## Task 9: Live dry-run verification (no commit)

**Files:** None modified.

- [ ] **Step 1: Populate live profile**

Open `config/profile.yml` and copy the `application_form_defaults` block from the example, filling in real values for your:
- `personal.*` (name, email, phone, city, LinkedIn, GitHub)
- `work_authorization.*`
- `availability.*`
- `compensation.*`
- `experience.*`
- EEO (defaults are fine)
- `auto_apply.*` — verify `enabled: true`, `min_score: 9`

- [ ] **Step 2: Confirm cover letters have been generated**

Run auto-prep to ensure cover letter artifacts exist for jobs scored ≥9:

```bash
node auto-prep.mjs 2>&1 | tail -5
ls cvs/ | head -5
find cvs -name '*_cover_letter.*' 2>/dev/null | head -5
```

Expected: at least one `_cover_letter.md` and `_cover_letter.pdf` pair.

- [ ] **Step 3: Dry-run for a single job**

Pick a recent job_id with `prefilter_score >= 9` that has no application yet:

```bash
node -e "import('dotenv/config');import('./lib/db.mjs').then(async ({getDb,closeDb})=>{const db=await getDb();const top=await db.collection('jobs').findOne({stage:'scored',prefilter_score:{\$gte:9}});console.log(top?.linkedin_id, top?.company, top?.url); await closeDb();})"
```

Then:

```bash
node apply-bot.mjs --job-id=<ID_FROM_ABOVE> 2>&1 | tail -20
```

Expected stderr: `[apply-bot] 1 eligible jobs …`, step-by-step classify/plan calls, and a final `[apply-bot] ✓ COMPANY: TITLE — DryRun (...)`.

- [ ] **Step 4: Inspect the trace**

```bash
ls screenshots/<ID>/ 2>&1 | head
cat screenshots/<ID>/meta.json 2>&1
cat screenshots/<ID>/actions.jsonl 2>&1 | head -10
```

Expected: `step_001.png`, `step_002.png`, …, `actions.jsonl`, `final_dom.html`, `meta.json` with outcome = `DryRun`.

- [ ] **Step 5: Verify applications.md**

```bash
node merge-tracker.mjs 2>&1 | tail -2
tail -3 data/applications.md
```

Expected: a new row with status `DryRun`, notes containing `apply-bot dry-run`.

- [ ] **Step 6: Spot-check screenshot**

Open `screenshots/<ID>/step_001.png`, verify the agent actually loaded the target URL and (in later steps) reached the apply form. If the screenshot shows a LinkedIn auth wall instead of the target company's portal, the URL is LinkedIn-gated and the agent correctly marked it `Skipped`.

- [ ] **Step 7: (Optional) Real submit for ONE test job**

Only after you've audited the dry-run trace end-to-end:

```bash
node apply-bot.mjs --job-id=<ID> --submit 2>&1 | tail -20
```

Expected: agent performs the same actions but actually clicks Submit. Verify on the company's portal that the application appears in your email.

No commit for this task — it's verification only.

---

## Self-review checklist

| Spec section | Task covering it |
|---|---|
| §3 user invocation (flags + CLI) | Task 6 + Task 7 |
| §4 selection rules | Task 6 |
| §5 config additions | Task 8 |
| §6 cover letter generation | Tasks 2 + 3 |
| §7 per-job flow | Task 5 + Task 6 |
| §8 page-type classification | Task 4 (prompts) + Task 5 (dispatch) |
| §9 field-filling strategy | Task 4 + Task 5 |
| §10 file structure | All tasks |
| §11 status vocabulary | Task 5 + Task 8 |
| §12 CAPSOLVER integration | Task 1 + Task 5 (wiring) + Task 6 (wiring) |
| §13 per-job trace artifacts | Task 5 |
| §14 failure handling | Task 5 (agent try/catch) + Task 6 (bot try/catch) |
| §15 testing plan | Tasks 1, 2, 3, 4, 5, 6 add ~11 tests total |
| §16 ethics override | Header comments in all new files (Task 1, 3, 4, 5, 6) |
| §17 rollout | Task 9 |
| §18 integration with existing system | Task 3 (auto-prep) + Task 7 (run-pipeline) |
