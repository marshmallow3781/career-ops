# CV Auto-Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `auto-prep.mjs` — the orchestrator that, for every scored job above threshold, produces tailored PDF + picker PDF + 6-block evaluation report + story-bank append + `Evaluated` tracker row. All in-process; single `closeDb()` at end.

**Architecture:** `auto-prep.mjs` imports `runApifyScan`, `runDigestStage2AndScoring`, `runPickerMode`, `runAssemblerMode`, `renderPdf`, `persistReport`, `upsertApplication`, `generateEvalBlocks`, `verifyLegitimacy`, `appendStoryBank`. No subprocess shell-outs between stages. Three existing scripts (`assemble-cv.mjs`, `generate-pdf.mjs`, `scan.mjs`) get surgical refactors to expose their core flows as importable functions while keeping their CLIs intact.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, Playwright (already installed), `mongodb-memory-server` for integration tests, existing `initLlm()` factory for LLM calls.

**Spec reference:** `docs/superpowers/specs/2026-04-23-cv-auto-prep-design.md` (commit `14950ce`).

---

## File Structure

### Files created
- `lib/legitimacy.mjs` — `verifyLegitimacy(jobUrl)` Playwright check for Block G.
- `lib/auto-prep.mjs` — pure helpers: `generateEvalBlocks`, `appendStoryBank`, `renderReport`.
- `auto-prep.mjs` — main orchestrator CLI.
- `run-pipeline.mjs` — top-level orchestrator for launchd (ingest → score → auto-prep).
- `tests/legitimacy.test.mjs` — 3 tests for `verifyLegitimacy`.
- `tests/auto-prep.test.mjs` — 7 tests for lib helpers + e2e orchestration.

### Files modified
- `assemble-cv.mjs` — export `runPickerMode` and `runAssemblerMode`; both accept `{ jdPath, archetypeOverride, outputPaths }`. `main()` becomes CLI adapter. Existing CLI behavior unchanged.
- `generate-pdf.mjs` — export `renderPdf({ htmlPath, pdfPath, format })`. `main()` becomes CLI wrapper.
- `scan.mjs` — export `runScan()` wrapping the existing `main()` orchestration (config load + scanJobsToMongo + reporting). `main()` becomes a thin `await runScan(); process.exit(...)` wrapper.
- `config/profile.example.yml` — append `cv.auto_prep.min_score: 8` block.
- `.launchd/setup.sh` — change schedule target to `node run-pipeline.mjs`.

### Files NOT modified
- `apify-scan.mjs`, `digest-builder.mjs` — already expose `runApifyScan` / `runDigestStage2AndScoring`.
- `lib/db.mjs`, `lib/reports.mjs`, `lib/llm.mjs`, `lib/picker.mjs` — all helpers already exported.

---

## Task 1: `lib/legitimacy.mjs` + 3 tests

**Files:**
- Create: `lib/legitimacy.mjs`
- Create: `tests/legitimacy.test.mjs`
- Create: `tests/fixtures/legitimacy/confirmed.html`
- Create: `tests/fixtures/legitimacy/suspicious.html`

- [ ] **Step 1: Create fixture HTML files**

Create `tests/fixtures/legitimacy/confirmed.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Senior Backend Engineer - Acme Corp | LinkedIn</title></head>
<body>
  <nav>nav bar</nav>
  <main>
    <h1>Senior Backend Engineer</h1>
    <section class="job-description">
      <p>We are looking for an experienced backend engineer to join our platform team.
      You will work on distributed systems, scale to millions of users, and build
      services that process billions of events per day. Required: 5+ years Go/Java,
      deep distributed systems experience, Kafka/Kubernetes familiarity. The role is
      hybrid with 2 days in office. Great health benefits, equity, and collaborative
      culture. Join a team building the next generation of cloud infrastructure.</p>
    </section>
    <button class="apply-button">Apply Now</button>
  </main>
  <footer>footer</footer>
</body>
</html>
```

Create `tests/fixtures/legitimacy/suspicious.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Job Not Found</title></head>
<body>
  <nav>nav bar</nav>
  <main>
    <p>This job is no longer accepting applications.</p>
  </main>
  <footer>footer</footer>
</body>
</html>
```

Verify:

```bash
ls tests/fixtures/legitimacy/
```

Expected: `confirmed.html` and `suspicious.html`.

- [ ] **Step 2: Write failing tests**

Create `tests/legitimacy.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLegitimacy } from '../lib/legitimacy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, 'fixtures/legitimacy');

test('verifyLegitimacy: confirmed when title + description + apply button present', async () => {
  const url = `file://${FIX}/confirmed.html`;
  const result = await verifyLegitimacy(url);
  assert.equal(result.tier, 'confirmed');
  assert.ok(Array.isArray(result.signals));
  assert.ok(result.signals.length >= 2, `expected ≥2 positive signals, got: ${result.signals.join(', ')}`);
});

test('verifyLegitimacy: suspicious when page has expired language only', async () => {
  const url = `file://${FIX}/suspicious.html`;
  const result = await verifyLegitimacy(url);
  assert.equal(result.tier, 'suspicious');
});

test('verifyLegitimacy: unverified on throw (unreachable URL)', async () => {
  const result = await verifyLegitimacy('http://127.0.0.1:1/does-not-exist', { timeout: 2000 });
  assert.equal(result.tier, 'unverified');
  assert.ok(result.reason, 'should include a reason string');
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
node --test tests/legitimacy.test.mjs
```

Expected: 3 failures with `Cannot find package '../lib/legitimacy.mjs'`.

- [ ] **Step 4: Implement `lib/legitimacy.mjs`**

```js
/**
 * lib/legitimacy.mjs — Playwright headless check for Block G (Posting Legitimacy).
 *
 * No LLM. Pure DOM inspection against positive/negative signal heuristics.
 */
import { chromium } from 'playwright';

const POSITIVE_SIGNALS = {
  has_h1: (text) => text.match(/<h1[^>]*>[^<]{5,200}<\/h1>/i) !== null,
  has_long_description: (text) => {
    const m = text.match(/<(?:section|div)[^>]*(?:description|job-description)[^>]*>([\s\S]{500,})<\/(?:section|div)>/i);
    return m !== null || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length > 800;
  },
  has_apply_button: (text) => /\bapply\s*(now|today|here)?\b/i.test(text) && /<(button|a)[^>]*>[^<]*apply/i.test(text),
};

const NEGATIVE_SIGNALS = {
  no_longer_accepting: /no\s+longer\s+accepting\s+applications?/i,
  job_not_found: /job\s+not\s+found|404|page\s+not\s+found/i,
};

/**
 * @param {string} jobUrl
 * @param {object} [opts]
 * @param {number} [opts.timeout=15000] page.goto timeout ms
 * @returns {Promise<{tier: 'confirmed'|'likely'|'suspicious'|'unverified', signals: string[], reason?: string}>}
 */
export async function verifyLegitimacy(jobUrl, { timeout = 15000 } = {}) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout });
    const html = await page.content();

    const hits = [];
    for (const [name, check] of Object.entries(POSITIVE_SIGNALS)) {
      if (check(html)) hits.push(name);
    }
    const negatives = [];
    for (const [name, re] of Object.entries(NEGATIVE_SIGNALS)) {
      if (re.test(html)) negatives.push(name);
    }

    if (negatives.length > 0) return { tier: 'suspicious', signals: negatives };
    if (hits.length >= 2) return { tier: 'confirmed', signals: hits };
    if (hits.length >= 1) return { tier: 'likely', signals: hits };
    return { tier: 'suspicious', signals: ['no_positive_signals'] };
  } catch (err) {
    return { tier: 'unverified', signals: [], reason: err.message || String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test tests/legitimacy.test.mjs
```

Expected: `pass 3 fail 0`.

- [ ] **Step 6: Commit**

```bash
git add lib/legitimacy.mjs tests/legitimacy.test.mjs tests/fixtures/legitimacy/
git commit -m "feat(auto-prep): add lib/legitimacy.mjs Playwright posting check"
```

---

## Task 2: `lib/auto-prep.mjs` `generateEvalBlocks` + 2 tests

**Files:**
- Create: `lib/auto-prep.mjs`
- Create: `tests/auto-prep.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/auto-prep.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEvalBlocks } from '../lib/auto-prep.mjs';

function mockLlmClient(responseText) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: responseText }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    },
  };
}

const goodJson = JSON.stringify({
  block_a: 'Acme is hiring a backend engineer...',
  block_b_rows: [
    { req: 'Go/Java', evidence: 'LinkedIn 531M events/day in Go' },
    { req: 'Kafka', evidence: 'TikTok real-time pipelines' },
  ],
  block_e: 'Lead with the 531M/day scale number...',
  block_f_stories: [
    { scenario: 'Scaling Kafka to 2K QPS', star_prompt: 'STAR: 2021 LinkedIn migration' },
  ],
  block_h_answers: [
    { prompt: 'Why Acme?', answer: 'Your distributed systems investment...' },
  ],
});

test('generateEvalBlocks: parses valid JSON into structured blocks', async () => {
  const client = mockLlmClient(goodJson);
  const result = await generateEvalBlocks({
    jdText: 'JD text',
    candidateSummary: 'candidate summary',
    tierBreakdown: null,
    existingStoryThemes: [],
    llmClient: client,
    llmConfig: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  });
  assert.equal(result.block_a.startsWith('Acme'), true);
  assert.equal(result.block_b_rows.length, 2);
  assert.equal(result.block_f_stories.length, 1);
});

test('generateEvalBlocks: returns empty-stub shape when LLM returns malformed JSON', async () => {
  const client = mockLlmClient('this is not JSON');
  const result = await generateEvalBlocks({
    jdText: 'JD',
    candidateSummary: 'summary',
    tierBreakdown: null,
    existingStoryThemes: [],
    llmClient: client,
    llmConfig: { provider: 'anthropic', model: 'x' },
  });
  assert.equal(result.block_a, '');
  assert.deepEqual(result.block_b_rows, []);
  assert.deepEqual(result.block_f_stories, []);
  assert.deepEqual(result.block_h_answers, []);
  assert.ok(result._parse_failed === true, 'should flag parse failure');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: 2 failures with `Cannot find package '../lib/auto-prep.mjs'`.

- [ ] **Step 3: Implement `lib/auto-prep.mjs` (first export)**

```js
/**
 * lib/auto-prep.mjs — pure helpers for auto-prep.mjs.
 * Exports:
 *   - generateEvalBlocks: single LLM call → blocks A+B+E+F+H
 *   - appendStoryBank: dedup + append STAR+R stories (added in Task 3)
 *   - renderReport: combine blocks + legitimacy → final markdown (added in Task 4)
 */

const SYSTEM_PROMPT = `You are writing a job-match evaluation for the candidate.
Return ONLY JSON matching this schema:
{
  "block_a": string,                              // Role Summary: 2-3 sentences on what the role is
  "block_b_rows": [{"req": string, "evidence": string}, ...],  // 3-5 JD requirements mapped to candidate evidence
  "block_e": string,                              // Personalization plan: how to customize the application
  "block_f_stories": [{"scenario": string, "star_prompt": string}, ...],  // 3-5 STAR+R interview stories
  "block_h_answers": [{"prompt": string, "answer": string}, ...]          // 2-3 draft application answers
}

Ground every claim in either the <job> text or the <candidate_summary>.
Never invent metrics or technologies the candidate didn't cite.
Skip stories already in <existing_story_themes> (they are already in the bank).`;

/**
 * Generate evaluation blocks A, B, E, F, H via a single LLM call.
 *
 * @param {object} params
 * @param {string} params.jdText
 * @param {string} params.candidateSummary
 * @param {string|null} params.tierBreakdown — optional marker from .cv-tailored-meta.json
 * @param {string[]} params.existingStoryThemes — scenarios already in story bank
 * @param {object} params.llmClient — returned by initLlm()
 * @param {object} params.llmConfig — returned by initLlm()
 * @returns {Promise<{block_a, block_b_rows, block_e, block_f_stories, block_h_answers, _parse_failed?}>}
 */
export async function generateEvalBlocks({
  jdText, candidateSummary, tierBreakdown, existingStoryThemes,
  llmClient, llmConfig,
}) {
  const userMessage =
    `<job>\n${jdText.slice(0, 6000)}\n</job>\n\n` +
    `<candidate_summary>\n${candidateSummary}\n</candidate_summary>\n\n` +
    `<tier_breakdown>\n${tierBreakdown || '(none)'}\n</tier_breakdown>\n\n` +
    `<existing_story_themes>\n${(existingStoryThemes || []).join('\n') || '(none)'}\n</existing_story_themes>\n\n` +
    `Return JSON matching the schema in the system prompt.`;

  let text = '';
  try {
    if (llmConfig.provider === 'anthropic') {
      const response = await llmClient.messages.create({
        model: llmConfig.model,
        max_tokens: 3000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });
      text = (response.content || [])
        .filter(b => typeof b?.text === 'string')
        .map(b => b.text).join('\n').trim();
    } else {
      const response = await llmClient.chat.completions.create({
        model: llmConfig.model,
        max_tokens: 3000,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      });
      text = (response.choices?.[0]?.message?.content || '').trim();
    }
  } catch (e) {
    return emptyBlocks({ _parse_failed: true, _reason: `llm: ${(e.message || '').slice(0, 80)}` });
  }

  // Parse — try strict JSON first, then brace-counting scan for JSON embedded in prose.
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const start = text.indexOf('{');
    if (start !== -1) {
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
      if (end !== -1) {
        try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { /* ignore */ }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return emptyBlocks({ _parse_failed: true, _reason: 'parse_failed' });
  }

  return {
    block_a: String(parsed.block_a || ''),
    block_b_rows: Array.isArray(parsed.block_b_rows) ? parsed.block_b_rows : [],
    block_e: String(parsed.block_e || ''),
    block_f_stories: Array.isArray(parsed.block_f_stories) ? parsed.block_f_stories : [],
    block_h_answers: Array.isArray(parsed.block_h_answers) ? parsed.block_h_answers : [],
  };
}

function emptyBlocks(extra = {}) {
  return {
    block_a: '',
    block_b_rows: [],
    block_e: '',
    block_f_stories: [],
    block_h_answers: [],
    ...extra,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: `pass 2 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-prep.mjs tests/auto-prep.test.mjs
git commit -m "feat(auto-prep): add generateEvalBlocks with mock-LLM tests"
```

---

## Task 3: `lib/auto-prep.mjs` `appendStoryBank` + 2 tests

**Files:**
- Modify: `lib/auto-prep.mjs`
- Modify: `tests/auto-prep.test.mjs`

- [ ] **Step 1: Write failing tests**

Append to `tests/auto-prep.test.mjs`:

```js
import { appendStoryBank } from '../lib/auto-prep.mjs';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('appendStoryBank: new stories write to file; dedup by normalized scenario', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sb-'));
  const path = join(tmp, 'story-bank.md');
  writeFileSync(path, '# Story Bank\n\n');

  try {
    const stories = [
      { scenario: 'Scaling Kafka to 2K QPS', star_prompt: 'STAR prompt A' },
      { scenario: 'Privacy compliance rollout', star_prompt: 'STAR prompt B' },
    ];
    const added = appendStoryBank({ storyBankPath: path, newStories: stories, companyTag: 'Mercor', dateTag: '2026-04-23' });
    assert.equal(added, 2);
    const body = readFileSync(path, 'utf-8');
    assert.ok(body.includes('Scaling Kafka to 2K QPS'));
    assert.ok(body.includes('Mercor'));

    // Second call with one duplicate scenario
    const added2 = appendStoryBank({
      storyBankPath: path,
      newStories: [
        { scenario: 'Scaling Kafka to 2K QPS', star_prompt: 'STAR prompt A duplicate' },
        { scenario: 'New unique scenario', star_prompt: 'STAR prompt C' },
      ],
      companyTag: 'Google',
      dateTag: '2026-04-23',
    });
    assert.equal(added2, 1, 'only new unique story should be appended');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('appendStoryBank: bootstraps file if missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sb-'));
  const path = join(tmp, 'story-bank.md');  // does not exist yet
  try {
    const added = appendStoryBank({
      storyBankPath: path,
      newStories: [{ scenario: 'first story', star_prompt: 'prompt' }],
      companyTag: 'Acme',
      dateTag: '2026-04-23',
    });
    assert.equal(added, 1);
    const body = readFileSync(path, 'utf-8');
    assert.ok(body.startsWith('# Story Bank'));
    assert.ok(body.includes('first story'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: previous 2 pass, 2 new fail with `appendStoryBank is not a function`.

- [ ] **Step 3: Implement `appendStoryBank` in `lib/auto-prep.mjs`**

Append to `lib/auto-prep.mjs`:

```js
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

/**
 * Normalize a scenario for dedup matching.
 */
function normalizeScenario(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract already-stored scenarios from a story-bank markdown body.
 */
function existingScenarios(body) {
  const out = new Set();
  const re = /\*\*Scenario:\*\*\s*(.+)$/gim;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.add(normalizeScenario(m[1]));
  }
  return out;
}

/**
 * Append STAR+R stories to `interview-prep/story-bank.md`, deduplicating
 * against already-stored scenarios (exact normalized match).
 *
 * @param {object} params
 * @param {string} params.storyBankPath
 * @param {Array<{scenario, star_prompt}>} params.newStories
 * @param {string} params.companyTag — label for the "## [Auto-generated · date · company]" header
 * @param {string} params.dateTag — YYYY-MM-DD
 * @returns {number} count of stories actually appended (after dedup)
 */
export function appendStoryBank({ storyBankPath, newStories, companyTag, dateTag }) {
  const body = existsSync(storyBankPath) ? readFileSync(storyBankPath, 'utf-8') : '# Story Bank\n\n';
  const already = existingScenarios(body);
  const toAppend = [];

  for (const s of (newStories || [])) {
    if (!s || typeof s.scenario !== 'string') continue;
    const key = normalizeScenario(s.scenario);
    if (!key || already.has(key)) continue;
    already.add(key);
    toAppend.push(s);
  }

  if (toAppend.length === 0) {
    if (!existsSync(storyBankPath)) writeFileSync(storyBankPath, body);
    return 0;
  }

  const lines = [];
  for (const s of toAppend) {
    lines.push(`## [Auto-generated · ${dateTag} · ${companyTag}]`);
    lines.push(`**Scenario:** ${s.scenario}`);
    lines.push(`**STAR prompt:** ${s.star_prompt || '(missing)'}`);
    lines.push('');
  }

  if (!existsSync(storyBankPath)) writeFileSync(storyBankPath, body);
  appendFileSync(storyBankPath, lines.join('\n') + '\n');
  return toAppend.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: `pass 4 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-prep.mjs tests/auto-prep.test.mjs
git commit -m "feat(auto-prep): add appendStoryBank dedup helper"
```

---

## Task 4: `lib/auto-prep.mjs` `renderReport` + 1 test

**Files:**
- Modify: `lib/auto-prep.mjs`
- Modify: `tests/auto-prep.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/auto-prep.test.mjs`:

```js
import { renderReport } from '../lib/auto-prep.mjs';

test('renderReport: combines blocks + legitimacy into expected markdown', () => {
  const blocks = {
    block_a: 'Acme hiring backend engineer.',
    block_b_rows: [
      { req: 'Go', evidence: 'LinkedIn 531M events' },
      { req: 'Kafka', evidence: 'TikTok pipelines' },
    ],
    block_e: 'Lead with scale.',
    block_f_stories: [
      { scenario: 'Kafka 2K QPS', star_prompt: 'STAR prompt' },
    ],
    block_h_answers: [
      { prompt: 'Why Acme?', answer: 'Their distributed investment.' },
    ],
  };
  const legitimacy = { tier: 'confirmed', signals: ['has_h1', 'has_apply_button'] };
  const job = {
    company: 'Acme',
    title: 'Backend Engineer',
    url: 'https://example.com/job',
    prefilter_archetype: 'backend',
    prefilter_score: 9,
  };

  const md = renderReport({ blocks, legitimacy, job, score: 4.5, pdfPath: 'cvs/acme/be/123_cv_picker.pdf' });
  assert.ok(md.startsWith('# Acme — Backend Engineer'));
  assert.ok(md.includes('**Score:** 4.5/5'));
  assert.ok(md.includes('**Legitimacy:** confirmed'));
  assert.ok(md.includes('## Block A — Resumen del Rol'));
  assert.ok(md.includes('## Block B — Match con CV'));
  assert.ok(md.includes('| Go | LinkedIn 531M events |'));
  assert.ok(md.includes('## Block E — Plan de Personalización'));
  assert.ok(md.includes('## Block F — Plan de Entrevistas'));
  assert.ok(md.includes('## Block G — Posting Legitimacy'));
  assert.ok(md.includes('## Block H — Draft Application Answers'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: previous 4 pass, 1 new fail with `renderReport is not a function`.

- [ ] **Step 3: Implement `renderReport` in `lib/auto-prep.mjs`**

Append to `lib/auto-prep.mjs`:

```js
/**
 * Render the 6-block evaluation report markdown.
 *
 * @param {object} params
 * @param {object} params.blocks — from generateEvalBlocks()
 * @param {object} params.legitimacy — from verifyLegitimacy()
 * @param {object} params.job — the Mongo jobs document
 * @param {number} params.score — the X.X/5 tracker score
 * @param {string} params.pdfPath — path to the PDF the tracker row will cite
 * @returns {string} markdown
 */
export function renderReport({ blocks, legitimacy, job, score, pdfPath }) {
  const lines = [];
  lines.push(`# ${job.company} — ${job.title}`);
  lines.push('');
  lines.push(`**Score:** ${score}/5`);
  lines.push(`**URL:** ${job.url || 'n/a'}`);
  lines.push(`**PDF:** \`${pdfPath}\``);
  lines.push(`**Legitimacy:** ${legitimacy.tier}${legitimacy.signals?.length ? ` (${legitimacy.signals.join(', ')})` : ''}`);
  lines.push(`**Archetype:** ${job.prefilter_archetype || '?'} · **Prefilter score:** ${job.prefilter_score ?? '?'}/10`);
  lines.push('');
  lines.push('---');

  lines.push('');
  lines.push('## Block A — Resumen del Rol');
  lines.push('');
  lines.push(blocks.block_a || '_(auto-prep produced no content for this block)_');

  lines.push('');
  lines.push('## Block B — Match con CV');
  lines.push('');
  if (blocks.block_b_rows?.length > 0) {
    lines.push('| JD requirement | Evidence in CV |');
    lines.push('|---|---|');
    for (const row of blocks.block_b_rows) {
      lines.push(`| ${row.req || ''} | ${row.evidence || ''} |`);
    }
  } else {
    lines.push('_(no rows)_');
  }

  lines.push('');
  lines.push('## Block E — Plan de Personalización');
  lines.push('');
  lines.push(blocks.block_e || '_(no content)_');

  lines.push('');
  lines.push('## Block F — Plan de Entrevistas');
  lines.push('');
  if (blocks.block_f_stories?.length > 0) {
    for (const s of blocks.block_f_stories) {
      lines.push(`- **${s.scenario || 'scenario'}** — ${s.star_prompt || ''}`);
    }
  } else {
    lines.push('_(no stories)_');
  }

  lines.push('');
  lines.push('## Block G — Posting Legitimacy');
  lines.push('');
  lines.push(`**Tier:** ${legitimacy.tier}`);
  if (legitimacy.signals?.length) {
    lines.push('');
    lines.push(`Signals: ${legitimacy.signals.join(', ')}`);
  }
  if (legitimacy.reason) {
    lines.push('');
    lines.push(`Reason: ${legitimacy.reason}`);
  }

  lines.push('');
  lines.push('## Block H — Draft Application Answers');
  lines.push('');
  if (blocks.block_h_answers?.length > 0) {
    for (const a of blocks.block_h_answers) {
      lines.push(`**Q: ${a.prompt || ''}**`);
      lines.push('');
      lines.push(a.answer || '_(no answer)_');
      lines.push('');
    }
  } else {
    lines.push('_(no answers)_');
  }

  lines.push('');
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: `pass 5 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-prep.mjs tests/auto-prep.test.mjs
git commit -m "feat(auto-prep): add renderReport for 6-block evaluation markdown"
```

---

## Task 5: `generate-pdf.mjs` refactor — export `renderPdf`

**Files:**
- Modify: `generate-pdf.mjs`
- Modify: `tests/auto-prep.test.mjs` (smoke test)

- [ ] **Step 1: Write a smoke test for the new export**

Append to `tests/auto-prep.test.mjs`:

```js
import { renderPdf } from '../generate-pdf.mjs';
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';

test('renderPdf: renders a minimal HTML to a PDF file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pdf-'));
  const htmlPath = join(tmp, 'in.html');
  const pdfPath = join(tmp, 'out.pdf');
  writeFileSync(htmlPath, '<!doctype html><html><body><h1>Hello</h1><p>body text</p></body></html>');
  try {
    const result = await renderPdf({ htmlPath, pdfPath, format: 'letter' });
    assert.ok(existsSync(pdfPath), 'PDF file should exist');
    assert.ok(statSync(pdfPath).size > 500, 'PDF should be non-trivial size');
    assert.equal(result.outputPath, pdfPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: 5 passing, 1 new failing with `renderPdf is not a function` or similar.

- [ ] **Step 3: Refactor `generate-pdf.mjs`**

Replace the `generatePDF()` function and the bottom `.catch()` with:

```js
/**
 * Render an HTML file to a PDF using Playwright.
 *
 * @param {object} params
 * @param {string} params.htmlPath — absolute or relative path to HTML
 * @param {string} params.pdfPath — absolute or relative output path
 * @param {'a4'|'letter'} [params.format='a4']
 * @param {boolean} [params.verbose=false] — print progress to stdout (CLI use)
 * @returns {Promise<{outputPath: string, pageCount: number, size: number}>}
 */
export async function renderPdf({ htmlPath, pdfPath, format = 'a4', verbose = false }) {
  const validFormats = ['a4', 'letter'];
  if (!validFormats.includes(format)) {
    throw new Error(`Invalid format "${format}". Use: ${validFormats.join(', ')}`);
  }
  const inputPath = resolve(htmlPath);
  const outputPath = resolve(pdfPath);

  if (verbose) {
    console.log(`📄 Input:  ${inputPath}`);
    console.log(`📁 Output: ${outputPath}`);
    console.log(`📏 Format: ${format.toUpperCase()}`);
  }

  let html = await readFile(inputPath, 'utf-8');
  const fontsDir = resolve(__dirname, 'fonts');
  html = html.replace(/url\(['"]?\.\/fonts\//g, `url('file://${fontsDir}/`);
  html = html.replace(/file:\/\/([^'")]+)\.(woff2?|ttf|otf)['"]?\)/g, `file://$1.$2')`);

  const normalized = normalizeTextForATS(html);
  html = normalized.html;
  const totalReplacements = Object.values(normalized.replacements).reduce((a, b) => a + b, 0);
  if (verbose && totalReplacements > 0) {
    const breakdown = Object.entries(normalized.replacements).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`🧹 ATS normalization: ${totalReplacements} replacements (${breakdown})`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle', baseURL: `file://${dirname(inputPath)}/` });
    await page.evaluate(() => document.fonts.ready);
    const pdfBuffer = await page.pdf({
      format,
      printBackground: true,
      margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' },
      preferCSSPageSize: false,
    });
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, pdfBuffer);
    const pdfString = pdfBuffer.toString('latin1');
    const pageCount = (pdfString.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (verbose) {
      console.log(`✅ PDF generated: ${outputPath}`);
      console.log(`📊 Pages: ${pageCount}`);
      console.log(`📦 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
    }
    return { outputPath, pageCount, size: pdfBuffer.length };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let htmlPath, pdfPath, format = 'a4';
  for (const arg of args) {
    if (arg.startsWith('--format=')) format = arg.split('=')[1].toLowerCase();
    else if (!htmlPath) htmlPath = arg;
    else if (!pdfPath) pdfPath = arg;
  }
  if (!htmlPath || !pdfPath) {
    console.error('Usage: node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]');
    process.exit(1);
  }
  try {
    await renderPdf({ htmlPath, pdfPath, format, verbose: true });
  } catch (err) {
    console.error('❌ PDF generation failed:', err.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: `pass 6 fail 0`. Playwright boot may make this test take 5-10 seconds.

Also regression-check the CLI with a manual spot-check:

```bash
# Quick no-op: just verify it doesn't error on flag parse
node generate-pdf.mjs 2>&1 | head -2
```

Expected: Usage line (exits 1 with the expected message).

- [ ] **Step 5: Commit**

```bash
git add generate-pdf.mjs tests/auto-prep.test.mjs
git commit -m "refactor(generate-pdf): export renderPdf; main() becomes CLI wrapper"
```

---

## Task 6: `assemble-cv.mjs` refactor — export `runPickerMode` + `runAssemblerMode`

**Files:**
- Modify: `assemble-cv.mjs`
- Modify: `tests/picker.test.mjs` (ensure existing tests still pass after the refactor)

- [ ] **Step 1: Confirm existing tests pass before refactor**

```bash
node --test tests/picker.test.mjs
```

Expected: `pass 10 fail 0`.

- [ ] **Step 2: Extend `runPickerMode` to accept `outputPaths`**

Replace the existing `runPickerMode` function in `assemble-cv.mjs` with:

```js
/**
 * Picker mode: select a pre-made PDF by archetype + extract text.
 *
 * @param {object} params
 * @param {string} params.jdPath
 * @param {string|null} [params.archetypeOverride]
 * @param {object} [params.outputPaths] — { cv_md_path, cv_meta_path }. When
 *   omitted, writes to repo-root cv.tailored.md + .cv-tailored-meta.json
 *   (preserves CLI default behavior).
 */
export async function runPickerMode({ jdPath, archetypeOverride, outputPaths }) {
  const jdText = readFileSync(resolve(jdPath), 'utf-8');

  const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
  const pickerCfg = profile?.cv?.picker || { resumes_dir: 'resumes', archetype_map: {} };
  if (pickerCfg.resumes_dir && !pickerCfg.resumes_dir.startsWith('/')) {
    pickerCfg.resumes_dir = resolve(__dirname, pickerCfg.resumes_dir);
  }

  const archetype = archetypeOverride || await classifyArchetype(jdText);

  const resolved = resolvePickerResume(archetype, pickerCfg);

  const meta = {
    mode: 'picker',
    archetype,
    source_pdf: null,
    extracted_at: new Date().toISOString(),
  };

  let cvText;
  if (resolved.missing) {
    cvText = buildPlaceholderCv(archetype, resolved.filename);
    meta.missing = true;
    meta.source_pdf = resolved.filename;
  } else {
    cvText = await extractPdfText(resolved.path);
    meta.source_pdf = resolved.path;
  }

  const mdPath = outputPaths?.cv_md_path ? resolve(__dirname, outputPaths.cv_md_path) : OUT_TAILORED;
  const metaPath = outputPaths?.cv_meta_path ? resolve(__dirname, outputPaths.cv_meta_path) : OUT_META;
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, cvText);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.error(`[picker] archetype=${archetype} → ${resolved.filename || '(placeholder)'}`);

  return { archetype, source_pdf: meta.source_pdf, missing: meta.missing || false, cv_md_path: mdPath, cv_meta_path: metaPath };
}
```

Add to existing imports at the top of the file (the ones that are already there — `mkdirSync` and `dirname` may not be imported yet):

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
```

(Review the file's existing imports and add `mkdirSync` and `dirname` if missing.)

- [ ] **Step 3: Extract assembler path into `runAssemblerMode` export**

Identify the body of the existing `main()` from the line `let excludeBullets = [];` (after the `if (args.mode === 'picker')` branch) down through the final write of `cv.tailored.md` + `.cv-tailored-meta.json`. Extract it into:

```js
/**
 * Assembler mode: pick bullets from experience_source/ + LLM-tailor per JD.
 *
 * @param {object} params
 * @param {string} params.jdPath
 * @param {string|null} [params.archetypeOverride]
 * @param {string|null} [params.feedbackPath]
 * @param {object} [params.outputPaths] — { cv_md_path, cv_meta_path }. When
 *   omitted, writes to repo-root paths AND per-job paths (current CLI behavior).
 *   When supplied, only writes to the supplied paths.
 */
export async function runAssemblerMode({ jdPath, archetypeOverride, feedbackPath, outputPaths }) {
  let excludeBullets = [];
  if (feedbackPath) {
    try {
      const errs = JSON.parse(readFileSync(resolve(feedbackPath), 'utf-8'));
      excludeBullets = (errs.errors || [])
        .filter(e => e.type === 'fabricated_bullet')
        .map(e => e.bullet);
    } catch { /* ignore */ }
  }

  const jdText = readFileSync(resolve(jdPath), 'utf-8');
  const config = loadConfig(PROFILE_PATH);
  const sources = loadAllSources(SOURCES_ROOT);
  validateConsistency(sources);

  const meta = { jd: jdPath, archetype: null, intent: null, companies: [] };

  const archetype = archetypeOverride || await classifyArchetype(jdText);
  meta.archetype = archetype;

  const firedSignals = deriveSignals(jdText);
  meta.fired_signals = [...firedSignals];
  console.error(`[assemble-cv] Fired signals: ${[...firedSignals].join(', ') || '(none)'}`);

  const intentRaw = await extractJdIntent(jdText);
  const intent = { ...intentRaw, role_type: archetype };
  meta.intent = intent;
  console.error(`[assemble-cv] Intent source: ${intent._source}; role_type=${intent.role_type}`);
  console.error(`  focus: "${intent.primary_focus}"`);
  if (intent.prefer_patterns?.length) console.error(`  PREFER: ${intent.prefer_patterns.join(' | ')}`);
  if (intent.deprioritize_patterns?.length) console.error(`  DEPRIORITIZE: ${intent.deprioritize_patterns.join(' | ')}`);

  let keywords = extractKeywords(jdText);
  keywords = expandSynonyms(keywords, SYNONYMS_PATH);
  meta.keyword_count = keywords.size;

  const allDirs = Object.keys(sources);
  const sortedDirs = await sortCompanies(SOURCES_ROOT, allDirs);

  const companies = [];
  const allProjects = [];
  const allSkills = new Set();

  for (const dir of sortedDirs) {
    const facetFiles = sources[dir];
    const pool = [];
    const skillsBonusesForCompany = {};
    for (const f of facetFiles) {
      const skillsBonus = computeSkillsBonus(f.skills, keywords);
      const facetFileName = basename(f._sourcePath);
      skillsBonusesForCompany[facetFileName] = skillsBonus;
      for (const b of f.bullets) {
        const baseScore = scoreBullet(b.text, keywords);
        const score = baseScore + skillsBonus;
        if (score >= SCORE_THRESHOLD) {
          pool.push({
            text: b.text, sourcePath: f._sourcePath, sourceLine: b.lineNumber,
            facet: f.frontmatter.facet, score,
            _baseScore: baseScore, _skillsBonus: skillsBonus,
          });
        }
      }
      for (const p of f.projects) {
        allProjects.push({ text: p.text, sourcePath: f._sourcePath, sourceLine: p.lineNumber, score: scoreBullet(p.text, keywords) });
      }
      for (const s of f.skills) allSkills.add(s);
    }
    pool.sort((a, b) => b.score - a.score);

    const floor = config.experience_sources.overrides?.[dir]?.tier_floor || null;
    const topScore = pool.length > 0 ? pool[0].score : 0;
    const poolProxy = topScore >= 3 ? 3 : (topScore >= 1 ? 1 : 0);
    const tier = assignTier(poolProxy, floor);
    const fmRef = sources[dir][0].frontmatter;
    const stub = config.experience_sources.overrides?.[dir]?.stub || `Worked at ${fmRef.company} as ${fmRef.role}.`;
    const co = { dir, frontmatter: fmRef, tier, stub };

    if (tier !== 'stub') {
      const n = tier === 'full'
        ? (config.archetype_defaults?.[archetype]?.top_bullets_full || 4)
        : (config.tier_rules?.light_bullets || 2);
      const truncated = pool.slice(0, Math.max(n * 4, 15));
      co.bullets = await pickBullets(truncated, jdText, Math.min(n, truncated.length), defaultClient(), excludeBullets, intent);
    }
    companies.push(co);
    meta.companies.push({
      dir, tier, pool_size: pool.length, picked: co.bullets?.length || (co.stub ? 1 : 0),
      skills_bonuses: skillsBonusesForCompany, top_pool_scores: pool.slice(0, 10).map(p => p.score),
    });
  }

  const articleProjects = loadArticleDigest(__dirname);
  for (const p of articleProjects) {
    if (!p.archetype || p.archetype === archetype) {
      allProjects.push({ ...p, score: scoreBullet(p.text, keywords) });
    }
  }

  const projects = [];
  void allProjects;

  const competencies = [...allSkills].filter(s => keywords.has(s.toLowerCase())).slice(0, 8);
  const summary = '';
  const md = renderTailored({ profile: config, companies, projects, competencies, summary });

  // Per-job paths: compute if not supplied
  const jdSlug = jdPath.replace(/^.*\//, '').replace(/\.md$/, '');
  const { job_id, link_status, fingerprint, matched_job } = await deriveJobIdForCv({ jdText, jdSlug });
  const company_slug = matched_job?.company_slug || jdSlug;
  const title_slug = matched_job ? matched_job.title_normalized : jdSlug;
  const paths = outputPaths || buildCvPaths({ company_slug, title_slug, job_id });

  const dirToMake = resolve(__dirname, paths.dir || dirname(paths.cv_md_path));
  mkdirSync(dirToMake, { recursive: true });

  const cvMdFullPath = resolve(__dirname, paths.cv_md_path);
  writeFileSync(cvMdFullPath, md);

  const { createHash } = await import('node:crypto');
  const checksum_md = 'sha256:' + createHash('sha256').update(md).digest('hex');

  // When no custom outputPaths supplied (CLI case), also write repo-root paths
  // for back-compat with downstream modes that expect cv.tailored.md at root.
  if (!outputPaths) {
    writeFileSync(OUT_TAILORED, md);
    writeFileSync(OUT_META, JSON.stringify({ ...meta, checksum_md, job_id, link_status, fingerprint }, null, 2));
  } else if (outputPaths.cv_meta_path) {
    writeFileSync(resolve(__dirname, outputPaths.cv_meta_path), JSON.stringify({ ...meta, checksum_md, job_id, link_status, fingerprint }, null, 2));
  }

  // Persist cv_artifact record
  await upsertCvArtifact({ job_id, company_slug, title_slug, cv_md_path: paths.cv_md_path, checksum_md, archetype });

  return { archetype, job_id, link_status, cv_md_path: cvMdFullPath, paths, companies, meta };
}
```

(Note: `upsertCvArtifact` is imported at the top of `assemble-cv.mjs` already per the Mongo migration plan.)

- [ ] **Step 4: Replace `main()` body with a thin CLI adapter**

```js
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.jd) {
    console.error('Usage: node assemble-cv.mjs --jd=<path> [--archetype=...] [--feedback=...] [--mode=picker|assembler]');
    process.exit(1);
  }
  if (args.mode === 'picker') {
    await runPickerMode({ jdPath: args.jd, archetypeOverride: args.archetype });
  } else {
    await runAssemblerMode({ jdPath: args.jd, archetypeOverride: args.archetype, feedbackPath: args.feedback });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Run picker tests to confirm CLI is still working**

```bash
node --test tests/picker.test.mjs
```

Expected: `pass 10 fail 0`.

Also run the full suite to catch regressions:

```bash
node --test tests/*.test.mjs 2>&1 | tail -6
```

Expected: `pass 176 fail 0` (unchanged).

- [ ] **Step 6: Commit**

```bash
git add assemble-cv.mjs
git commit -m "refactor(assemble-cv): export runPickerMode + runAssemblerMode with outputPaths"
```

---

## Task 7: `scan.mjs` refactor — export `runScan`

**Files:**
- Modify: `scan.mjs`

- [ ] **Step 1: Locate and rename current `main()`**

In `scan.mjs`, find the existing `async function main() { ... }` body and convert it to:

```js
/**
 * Top-level scan orchestration: load config, fetch jobs from portals,
 * filter, upsert to Mongo, print summary.
 *
 * Extracted from main() so auto-prep / run-pipeline can invoke scan
 * in-process without shelling out.
 */
export async function runScan({ sinceHours } = {}) {
  // ... existing main() body, but:
  //   - argv parsing either uses passed sinceHours OR falls back to the
  //     CLI default (the existing code in main()). Simplest: accept the
  //     parsed value as a function argument, keep the rest of main() body
  //     as-is.
  // ... keep existing final `await closeDb();` at end
}

async function main() {
  const args = process.argv.slice(2);
  let sinceHours = null;
  for (const a of args) {
    const m = a.match(/^--since-hours=(\d+)$/);
    if (m) sinceHours = parseInt(m[1], 10);
  }
  await runScan({ sinceHours });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('scan.mjs failed:', err);
    process.exit(1);
  });
}
```

The goal is: any code currently in `main()` that did arg parsing (`sinceHours` default logic, etc.) stays in `main()`. Everything else moves into `runScan({ sinceHours })` which takes the already-parsed value.

Read `scan.mjs` carefully to see the current main() body before editing — the key rule is: the signature and behavior of the CLI must be unchanged, but `runScan` exposes the same flow as an importable function.

- [ ] **Step 2: Verify CLI still works**

```bash
node scan.mjs --since-hours=1 2>&1 | tail -3
```

Expected: normal scan output (no errors), same format as before.

- [ ] **Step 3: Verify existing tests still pass**

```bash
node --test tests/*.test.mjs 2>&1 | tail -6
```

Expected: `pass 176 fail 0`.

- [ ] **Step 4: Commit**

```bash
git add scan.mjs
git commit -m "refactor(scan): export runScan; main() becomes CLI wrapper"
```

---

## Task 8: `auto-prep.mjs` main orchestrator + e2e tests

**Files:**
- Create: `auto-prep.mjs`
- Modify: `tests/auto-prep.test.mjs`

- [ ] **Step 1: Write the failing e2e tests**

Append to `tests/auto-prep.test.mjs`:

```js
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetDbForTesting, connectWithClient } from '../lib/db.mjs';
import { runAutoPrep } from '../auto-prep.mjs';

test('runAutoPrep: skips jobs with application_id set (dedup X)', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-auto-prep');
  const db = client.db('test-auto-prep');

  try {
    await db.collection('jobs').insertOne({
      linkedin_id: 'j-applied',
      stage: 'scored',
      prefilter_score: 9,
      prefilter_archetype: 'backend',
      company: 'X', title: 'Backend',
      first_seen_at: new Date(),
      application_id: 42,  // already applied
    });

    const result = await runAutoPrep({
      minScore: 8,
      mockLlmClient: null,  // not needed since no eligible jobs
      mockLegitimacy: null,
      mockRenderPdf: null,
    });
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_already_applied, 1);
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});

test('runAutoPrep: skips jobs whose archetype has no PDF (dedup Y)', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-auto-prep-y');

  try {
    await client.db('test-auto-prep-y').collection('jobs').insertOne({
      linkedin_id: 'j-no-pdf',
      stage: 'scored',
      prefilter_score: 9,
      prefilter_archetype: 'applied_ai',  // maps to applied_ai_2.0.pdf (not on disk)
      company: 'X', title: 'AI Eng',
      first_seen_at: new Date(),
      application_id: null,
    });
    const result = await runAutoPrep({ minScore: 8 });
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_no_pdf, 1);
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: prior 6 pass; 2 new fail with `Cannot find package '../auto-prep.mjs'`.

- [ ] **Step 3: Implement `auto-prep.mjs`**

```js
#!/usr/bin/env node
/**
 * auto-prep.mjs — orchestrator producing 6 artifacts per eligible job:
 *   1. JD at jds/<slug>.md
 *   2. Tailored CV PDF at cvs/<slug>/<job_id>_cv_tailored.pdf
 *   3. Picker CV PDF at cvs/<slug>/<job_id>_cv_picker.pdf
 *   4. 6-block evaluation report at reports/<company_slug>/<job_id>_report.md
 *   5. Story bank append to interview-prep/story-bank.md
 *   6. Evaluated-status row in applications collection
 *
 * Usage:
 *   node auto-prep.mjs                         # min-score from profile.yml, default 8
 *   node auto-prep.mjs --min-score=7           # override
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { getDb, closeDb, upsertApplication, getNextApplicationNum } from './lib/db.mjs';
import { runPickerMode, runAssemblerMode, buildCvPaths } from './assemble-cv.mjs';
import { renderPdf } from './generate-pdf.mjs';
import { resolvePickerResume } from './lib/picker.mjs';
import { persistReport } from './lib/reports.mjs';
import { generateEvalBlocks, appendStoryBank, renderReport } from './lib/auto-prep.mjs';
import { verifyLegitimacy } from './lib/legitimacy.mjs';
import { initLlm } from './lib/llm.mjs';
import { loadAllSources } from './assemble-core.mjs';
import { buildCandidateSummary } from './digest-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const STORY_BANK_PATH = resolve(__dirname, 'interview-prep/story-bank.md');
const HTML_TEMPLATE_PATH = resolve(__dirname, 'templates/cv-template.html');

function parseArgs(argv) {
  const out = { minScore: null };
  for (const a of argv) {
    const m = a.match(/^--min-score=(\d+)$/);
    if (m) out.minScore = parseInt(m[1], 10);
  }
  return out;
}

function slugify(company, title) {
  const s = `${company}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return s || 'job';
}

async function materializeJd(job) {
  const slug = slugify(job.company || 'unknown', job.title || 'role');
  const path = resolve(__dirname, 'jds', `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const body = [
    `# ${job.company}: ${job.title}`,
    '',
    `**Location:** ${job.location || 'n/a'}`,
    `**URL:** ${job.url || 'n/a'}`,
    `**Archetype:** ${job.prefilter_archetype || '?'} · **Prefilter:** ${job.prefilter_score ?? '?'}/10`,
    '', '---', '', '## Description', '', job.description || '', '',
  ].join('\n');
  writeFileSync(path, body);
  return { jdPath: path, slug };
}

/**
 * Core orchestration loop. Exported for testing; main() wraps this.
 *
 * @param {object} params
 * @param {number} [params.minScore]
 * @param {object} [params.mockLlmClient] — test hook
 * @param {object} [params.mockLegitimacy] — test hook
 * @param {Function} [params.mockRenderPdf] — test hook
 */
export async function runAutoPrep({
  minScore: explicitMinScore = null,
  mockLlmClient = null,
  mockLegitimacy = null,
  mockRenderPdf = null,
} = {}) {
  const profile = existsSync(PROFILE_PATH) ? yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) : {};
  const minScore = explicitMinScore || profile?.cv?.auto_prep?.min_score || 8;
  const pickerCfg = profile?.cv?.picker || { resumes_dir: 'resumes', archetype_map: {} };
  if (pickerCfg.resumes_dir && !pickerCfg.resumes_dir.startsWith('/')) {
    pickerCfg.resumes_dir = resolve(__dirname, pickerCfg.resumes_dir);
  }

  const db = await getDb();
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const eligible = await db.collection('jobs').find({
    first_seen_at: { $gte: cutoff },
    stage: 'scored',
    prefilter_score: { $gte: minScore },
    application_id: null,
  }).sort({ prefilter_score: -1 }).toArray();

  console.error(`[auto-prep] ${eligible.length} candidate jobs, min_score=${minScore}`);

  const stats = { processed: 0, skipped_no_pdf: 0, skipped_already_applied: 0, errors: 0 };

  const { client: llmClient, config: llmConfig } = mockLlmClient
    ? { client: mockLlmClient, config: { provider: 'anthropic', model: 'mock' } }
    : initLlm();

  // Candidate summary for LLM calls
  const sources = existsSync(resolve(__dirname, 'experience_source'))
    ? loadAllSources(resolve(__dirname, 'experience_source')) : {};
  const candidateSummary = buildCandidateSummary(profile, sources);

  for (const job of eligible) {
    // Dedup rule Y: archetype PDF must exist on disk
    const resolved = resolvePickerResume(job.prefilter_archetype, pickerCfg);
    if (resolved.missing) {
      stats.skipped_no_pdf++;
      console.error(`[auto-prep] skip ${job.company}: ${job.title} — no PDF for archetype=${job.prefilter_archetype}`);
      continue;
    }

    try {
      // 1. Materialize JD
      const { jdPath, slug } = await materializeJd(job);

      // 2. Tailored path
      const title_slug = (job.title_normalized || slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const company_slug = job.company_slug || slug;
      const job_id = job.linkedin_id || slug;
      const tailored_paths = {
        dir: `cvs/${company_slug}/${title_slug}`,
        cv_md_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.md`,
        cv_meta_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.meta.json`,
        cv_pdf_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.pdf`,
      };
      await runAssemblerMode({ jdPath, archetypeOverride: job.prefilter_archetype, outputPaths: tailored_paths });
      // Assembler wrote markdown; the tailored PDF rendering needs md → HTML
      // that conforms to templates/cv-template.html's layout. The existing
      // oferta/pdf mode uses an LLM to fill the template; auto-prep uses a
      // simpler placeholder substitution. If the template doesn't expose a
      // '<!-- CV_CONTENT -->' marker, tailored PDF rendering is skipped
      // gracefully — we still have the tailored .md file, and user can
      // render a tailored PDF manually when they decide to apply.
      const tailoredPdfAbs = resolve(__dirname, tailored_paths.cv_pdf_path);
      let tailoredPdfReady = false;
      if (mockRenderPdf) {
        writeFileSync(tailoredPdfAbs, 'mock PDF content');
        tailoredPdfReady = true;
      } else {
        try {
          const htmlPath = await renderTailoredToHtml(tailored_paths.cv_md_path, tailored_paths.dir);
          await renderPdf({ htmlPath, pdfPath: tailoredPdfAbs, format: 'letter' });
          tailoredPdfReady = true;
        } catch (e) {
          console.error(`[auto-prep] tailored PDF skipped for ${job.company}: ${e.message}`);
        }
      }

      // 3. Picker path
      const picker_paths = {
        dir: `cvs/${company_slug}/${title_slug}`,
        cv_md_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_picker.md`,
        cv_meta_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_picker.meta.json`,
      };
      const pickerRes = await runPickerMode({ jdPath, archetypeOverride: job.prefilter_archetype, outputPaths: picker_paths });
      const pickerPdfAbs = resolve(__dirname, `cvs/${company_slug}/${title_slug}/${job_id}_cv_picker.pdf`);
      copyFileSync(pickerRes.source_pdf, pickerPdfAbs);

      // 4. Evaluation blocks
      const jdText = readFileSync(jdPath, 'utf-8');
      const blocks = await generateEvalBlocks({
        jdText,
        candidateSummary,
        tierBreakdown: null,
        existingStoryThemes: [],
        llmClient, llmConfig,
      });

      // 5. Legitimacy
      const legitimacy = mockLegitimacy || await verifyLegitimacy(job.url || '', { timeout: 12000 });

      // 6. Render + persist report
      const score = Number((job.prefilter_score / 2).toFixed(1));
      const reportBody = renderReport({
        blocks, legitimacy, job, score,
        pdfPath: picker_paths.cv_md_path.replace(/\.md$/, '.pdf'),
      });
      const { num: reportNum, report_path } = await persistReport({
        job_id, company: job.company, company_slug,
        url: job.url || '',
        score,
        block_scores: {},
        body: reportBody,
        legitimacy: legitimacy.tier,
      });

      // 7. Story bank append
      await appendStoryBank({
        storyBankPath: STORY_BANK_PATH,
        newStories: blocks.block_f_stories,
        companyTag: job.company,
        dateTag: new Date().toISOString().slice(0, 10),
      });

      // 8. Application row
      const num = await getNextApplicationNum();
      await upsertApplication({
        num,
        job_id,
        company: job.company,
        role: job.title,
        status: 'Evaluated',
        url: job.url || '',
        date: new Date().toISOString().split('T')[0],
        score,
        notes: `auto-prep (LLM A+B+E+F+H, Playwright G, ${legitimacy.tier})`,
        pdf_generated: true,
        report_id: String(reportNum),
        cv_artifact_ids: [],
      });

      console.error(`[auto-prep] ✓ ${job.company}: ${job.title} — score=${score}/5, legitimacy=${legitimacy.tier}`);
      stats.processed++;
    } catch (err) {
      stats.errors++;
      console.error(`[auto-prep] ✗ ${job.company}: ${job.title} — ${err.message}`);
    }
  }

  console.error(`[auto-prep] done  processed=${stats.processed}  skipped_no_pdf=${stats.skipped_no_pdf}  skipped_already_applied=${stats.skipped_already_applied}  errors=${stats.errors}`);
  return stats;
}

/**
 * Read tailored cv.md and wrap it in a minimal HTML shell compatible with
 * templates/cv-template.html's styling. Returns the path to the written HTML.
 */
async function renderTailoredToHtml(cvMdPath, dir) {
  const htmlTemplate = readFileSync(HTML_TEMPLATE_PATH, 'utf-8');
  const marker = '<!-- CV_CONTENT -->';
  if (!htmlTemplate.includes(marker)) {
    throw new Error(
      `templates/cv-template.html has no '${marker}' placeholder — ` +
      `add one where the CV body should go, or disable tailored PDF rendering.`,
    );
  }
  const md = readFileSync(resolve(__dirname, cvMdPath), 'utf-8');
  const htmlBody = md
    .split('\n')
    .map(line => {
      if (/^# /.test(line)) return `<h1>${line.slice(2)}</h1>`;
      if (/^## /.test(line)) return `<h2>${line.slice(3)}</h2>`;
      if (/^### /.test(line)) return `<h3>${line.slice(4)}</h3>`;
      if (/^- /.test(line)) return `<li>${line.slice(2)}</li>`;
      if (line.trim() === '') return '';
      return `<p>${line}</p>`;
    }).join('\n');
  const html = htmlTemplate.replace(marker, htmlBody);
  mkdirSync(resolve(__dirname, dir), { recursive: true });
  const htmlPath = resolve(__dirname, dir, 'cv_tailored.html');
  writeFileSync(htmlPath, html);
  return htmlPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await runAutoPrep({ minScore: args.minScore });
  } finally {
    await closeDb().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async err => {
    console.error('auto-prep.mjs crashed:', err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/auto-prep.test.mjs
```

Expected: `pass 8 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add auto-prep.mjs tests/auto-prep.test.mjs
git commit -m "feat(auto-prep): add main orchestrator + dedup tests"
```

---

## Task 9: `run-pipeline.mjs` + config + launchd

**Files:**
- Create: `run-pipeline.mjs`
- Modify: `config/profile.example.yml`
- Modify: `.launchd/setup.sh` (if present — otherwise skip)

- [ ] **Step 1: Append `cv.auto_prep` to `config/profile.example.yml`**

Locate the end of `config/profile.example.yml` and append:

```yaml

# Auto-prep (node auto-prep.mjs)
# Jobs scored >= min_score are auto-prepped: tailored PDF + picker PDF
# + 6-block evaluation report + Evaluated-status tracker row.
# Set min_score=9 for stricter filter; 7 for wider net.
cv:
  auto_prep:
    min_score: 8
```

Note: if `cv:` is already a top-level key (from the picker block), merge `auto_prep:` under it. Otherwise this adds a new top-level.

Verify:

```bash
node -e "const y=require('js-yaml'); const p=y.load(require('fs').readFileSync('config/profile.example.yml','utf-8')); console.log(JSON.stringify(p.cv,null,2))"
```

Expected output includes `picker: {...}` AND `auto_prep: { min_score: 8 }` under `cv`.

- [ ] **Step 2: Create `run-pipeline.mjs`**

```js
#!/usr/bin/env node
/**
 * run-pipeline.mjs — top-level orchestrator for launchd.
 *
 * Runs the full flow in one Node.js process:
 *   1. apify-scan (LinkedIn via Apify)
 *   2. scan (Greenhouse/Ashby/Lever)
 *   3. stage-2 scoring (title filter + Haiku prefilter)
 *   4. auto-prep (CV + PDF + report + tracker for score>=threshold)
 *
 * Single closeDb() at the end. Any failure in one stage logs and continues
 * to the next — we want to see as much coverage as possible per run.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ApifyClient } from 'apify-client';

import { runApifyScan } from './apify-scan.mjs';
import { runScan } from './scan.mjs';
import { runDigestStage2AndScoring } from './digest-builder.mjs';
import { runAutoPrep } from './auto-prep.mjs';
import { closeDb } from './lib/db.mjs';
import { loadAllSources } from './assemble-core.mjs';
import { initLlm } from './lib/llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function stage1Apify() {
  const cfgPath = resolve(__dirname, 'config/apify-search.yml');
  if (!existsSync(cfgPath)) { console.error('[pipeline] skip apify: no config'); return; }
  const config = yaml.load(readFileSync(cfgPath, 'utf-8'));
  const token = process.env[config.api_token_env];
  if (!token) { console.error('[pipeline] skip apify: missing token'); return; }
  const client = new ApifyClient({ token });
  const profilePath = resolve(__dirname, 'config/profile.yml');
  const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf-8')) : {};
  const blacklist = profile?.target_roles?.company_blacklist || [];
  console.error('[pipeline] apify-scan starting…');
  const result = await runApifyScan({
    config, client,
    seenJobsPath: resolve(__dirname, 'data/seen-jobs.tsv'),
    apifyNewPath: resolve(__dirname, `data/apify-new-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    blacklist,
  });
  console.error(`[pipeline] apify-scan done: new=${result.totalNew} errors=${result.errors.length}`);
}

async function stage2Scan() {
  console.error('[pipeline] scan.mjs starting…');
  try {
    await runScan({ sinceHours: 2 });
  } catch (e) {
    console.error(`[pipeline] scan.mjs failed: ${e.message}`);
  }
}

async function stage3Score() {
  console.error('[pipeline] stage-2 scoring starting…');
  const profilePath = resolve(__dirname, 'config/profile.yml');
  const portalsPath = resolve(__dirname, 'portals.yml');
  if (!existsSync(profilePath) || !existsSync(portalsPath)) {
    console.error('[pipeline] skip scoring: profile/portals missing');
    return;
  }
  const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  const portals = yaml.load(readFileSync(portalsPath, 'utf-8'));
  const sources = loadAllSources(resolve(__dirname, 'experience_source'));
  const dealBreakers = profile?.target_roles?.deal_breakers || [];
  const { client: haikuClient, config: llmConfig } = initLlm();
  // Load raw-stage candidates only (post-hardening default).
  const { loadCandidatesFromMongo } = await import('./digest-builder.mjs');
  const candidates = await loadCandidatesFromMongo({ sinceHours: 24 });
  console.error(`[pipeline] scoring ${candidates.length} raw candidates`);
  await runDigestStage2AndScoring({ candidates, portals, profile, sources, haikuClient, llmConfig, dealBreakers });
}

async function stage4AutoPrep() {
  console.error('[pipeline] auto-prep starting…');
  return runAutoPrep({});
}

async function main() {
  const t0 = Date.now();
  try {
    await stage1Apify();
    await stage2Scan();
    await stage3Score();
    await stage4AutoPrep();
  } catch (err) {
    console.error('[pipeline] fatal:', err.message);
  } finally {
    await closeDb().catch(() => {});
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[pipeline] total elapsed: ${elapsed}s`);
}

main().catch(async err => {
  console.error('run-pipeline.mjs crashed:', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 3: Confirm syntax**

```bash
node -c run-pipeline.mjs 2>&1 || node --check run-pipeline.mjs 2>&1
```

Expected: no output (syntactically valid).

- [ ] **Step 4: Update `.launchd/setup.sh` if present**

```bash
ls .launchd/setup.sh 2>&1
```

If present, read it to find where `apify-scan.mjs` and `digest-builder.mjs` are invoked. Replace those two lines with a single invocation of `node run-pipeline.mjs`. If not present, skip.

- [ ] **Step 5: Commit**

```bash
git add run-pipeline.mjs config/profile.example.yml
# Include .launchd/setup.sh if modified
git commit -m "feat(auto-prep): add run-pipeline.mjs + cv.auto_prep config"
```

---

## Task 10: Live verification (no commit)

**Files:** None modified.

This validates the end-to-end flow against the current Mongo backlog. No commit.

- [ ] **Step 1: Ensure live `config/profile.yml` has `cv.auto_prep.min_score`**

```bash
node -e "const y=require('js-yaml');const p=y.load(require('fs').readFileSync('config/profile.yml','utf-8'));console.log(JSON.stringify(p.cv?.auto_prep || {missing:true}, null, 2))"
```

If missing, copy the block from `config/profile.example.yml` into the live file.

- [ ] **Step 2: Run `auto-prep.mjs` with a single-job dry-run**

Cap the processing to one job by temporarily raising min_score to a value only one job clears (e.g., 10). Or if no job scored 10, use 9.

```bash
node auto-prep.mjs --min-score=10 2>&1 | tail -40
```

Expected: `[auto-prep] N candidate jobs, min_score=10` followed by one `✓` log line (or 0 if no score-10 jobs). Confirm:

```bash
ls -la cvs/ reports/ 2>&1 | head -10
tail -2 data/applications.md  # after merge-tracker
```

- [ ] **Step 3: Run `merge-tracker.mjs` and check tracker**

```bash
node merge-tracker.mjs 2>&1 | tail -2
tail -3 data/applications.md
```

Expected: a new row with ✅ PDF and a working report link.

- [ ] **Step 4: (Optional) Process the full backlog**

```bash
node auto-prep.mjs 2>&1 | tee /tmp/auto-prep.log
```

Watch the log. Ctrl-C to abort at any time; already-processed jobs won't re-run (dedup X).

- [ ] **Step 5: Confirm story bank was appended**

```bash
head -30 interview-prep/story-bank.md
```

Expected: new `## [Auto-generated · <date> · <company>]` entries.

---

## Self-review checklist

| Spec section | Task covering it |
|---|---|
| §3 invocation (auto-prep CLI, run-pipeline orchestrator) | Task 8 + Task 9 |
| §4 6-block evaluation A+B+E+F+G+H | Tasks 2 (gen blocks A/B/E/F/H) + Task 1 (G) + Task 4 (render) |
| §5 config cv.auto_prep.min_score | Task 9 |
| §6 selection rules X + Y | Task 8 (tests verify both) |
| §7 per-job flow | Task 8 runAutoPrep body |
| §8 single LLM prompt for A+B+E+F+H | Task 2 generateEvalBlocks |
| §9 story bank accumulation | Task 3 appendStoryBank |
| §10 Playwright legitimacy check | Task 1 verifyLegitimacy |
| §11 in-process architecture | Tasks 5/6/7 (refactors so all imports work) + Task 8 (imports, no shell-outs) |
| §12 file structure | All tasks map to the structure |
| §13 testing plan | Tasks 1, 2, 3, 4, 5, 8 add ~11 test cases total |
| §14 failure handling | Task 8 try/catch per job |
| §15 risks and mitigations | Task 8 orchestrator handles most; Task 10 verifies live |
| §17 integration | Task 9 run-pipeline wiring |
