# Experience-Source Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork career-ops to assemble JD-tailored CVs deterministically from per-company × per-facet `experience_source/` files, with hard validation that every company appears in the output.

**Architecture:** Two new Node scripts (`assemble-cv.mjs` for selection, `validate-cv.mjs` for structural enforcement) wrap the LLM in a deterministic pool→pick→validate pipeline. Existing `generate-pdf.mjs` / `generate-latex.mjs` are unchanged; modes/*.md are updated to call the new scripts and consume `cv.tailored.md` instead of `cv.md`. `cv.md` is removed entirely.

**Tech Stack:** Node ESM (.mjs), js-yaml (existing dep), @anthropic-ai/sdk (new dep), Node built-in `node --test` runner, no other test framework.

**Spec:** `docs/superpowers/specs/2026-04-21-experience-source-assembly-design.md` (commit `5c6608c`)

## §14 Open Questions Resolved

1. **Synonym table** → small hardcoded YAML at `config/synonyms.yml`; loaded by score module; user-editable.
2. **LLM model** → `claude-haiku-4-5-20251001` for both bullet selection and summary; configurable via `ASSEMBLE_MODEL` env var.
3. **Archetype classification** → LLM call (Haiku); no regex rules. Adds ~1s/$0.001 per assembly; worth it for robustness.
4. **Multi-company same-date sort** → by `min(start)` desc, tie-break by `max(end)` desc, then alphabetical by directory name.
5. **Fixture content** → fully synthetic ("Acme Corp", "Globex Inc", "Initech") with invented but realistic-looking metrics. Safe to commit publicly.

## File Map

**New files:**
- `assemble-cv.mjs` — CLI entrypoint (~150 lines)
- `assemble-core.mjs` — pure functions: parse, score, tier, render (~600 lines)
- `assemble-llm.mjs` — LLM-facing functions: classifyArchetype, pickBullets, writeSummary (~150 lines, dependency-injected client)
- `validate-cv.mjs` — CLI entrypoint (~80 lines)
- `validate-core.mjs` — three check functions + levenshtein (~200 lines)
- `config/synonyms.yml` — initial synonym table
- `tests/assemble.parse.test.mjs`
- `tests/assemble.scoring.test.mjs`
- `tests/assemble.tier.test.mjs`
- `tests/assemble.render.test.mjs`
- `tests/validate.coverage.test.mjs`
- `tests/validate.provenance.test.mjs`
- `tests/validate.chronology.test.mjs`
- `tests/e2e.assemble.test.mjs`
- `__fixtures__/experience_source/{acme,globex,initech}/{frontend,backend,infra,machine_learning}.md` (subset)
- `__fixtures__/profile.yml`
- `__fixtures__/jds/{frontend,backend,fullstack,ml}.md`
- `__fixtures__/expected/cv.tailored.{frontend,backend,fullstack,ml}.md`

**Modified files:**
- `package.json` — add `@anthropic-ai/sdk` dep, new scripts (`assemble`, `validate`, `test`)
- `DATA_CONTRACT.md` — register new files in correct layers
- `test-all.mjs` — remove `cv-sync-check.mjs` entry, add `node --test tests/` section
- `modes/pdf.md` — call assemble + validate, read cv.tailored.md
- `modes/latex.md` — same
- `modes/auto-pipeline.md` — insert Paso 0.5 + 0.6
- `modes/oferta.md` — read cv.tailored.md, surface tier breakdown in Block B
- `modes/contacto.md` — require JD context, read cv.tailored.md
- `modes/deep.md` — same
- `modes/apply.md` — read cv.tailored.md
- `examples/cv-example.md` — repurpose comment header to "delete this file after migrating to experience_source/"
- `config/profile.example.yml` — add `experience_sources` / `archetype_defaults` / `tier_rules` / `prefer_latex` example block

**Deleted files:**
- `cv-sync-check.mjs` — depends on cv.md which no longer exists

---

## Phase A — Foundation (deps, layout, contract)

### Task 1: Add @anthropic-ai/sdk dependency

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Add the dependency**

Edit `package.json` so the `dependencies` block reads:

```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.32.1",
  "@google/generative-ai": "^0.21.0",
  "dotenv": "^16.4.5",
  "js-yaml": "^4.1.1",
  "playwright": "^1.58.1"
}
```

- [ ] **Step 2: Add new npm scripts**

In the `scripts` block, add (alphabetical between existing entries):

```json
"assemble": "node assemble-cv.mjs",
"validate-cv": "node validate-cv.mjs",
"test": "node --test tests/"
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: lockfile updated, no errors.

- [ ] **Step 4: Verify SDK importable**

Run: `node -e "import('@anthropic-ai/sdk').then(m => console.log('ok', typeof m.Anthropic))"`
Expected: `ok function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @anthropic-ai/sdk dep and assembly scripts"
```

---

### Task 2: Update DATA_CONTRACT.md for new layer split

**Files:**
- Modify: `DATA_CONTRACT.md`

- [ ] **Step 1: Edit User Layer table**

Remove the `cv.md` row. Add these rows (in alphabetical order with existing entries):

```
| `experience_source/*` | Per-company × per-facet structured experience source files |
```

Modify the `article-digest.md` row to:

```
| `article-digest.md` | Non-company proof points (open-source, blog posts, talks, side projects) |
```

- [ ] **Step 2: Edit System Layer table**

Add these rows (alphabetical):

```
| `assemble-cv.mjs` | Tailored CV assembler |
| `assemble-core.mjs` | Pure functions for assembly (parse, score, tier, render) |
| `assemble-llm.mjs` | LLM-facing functions used by assembler |
| `validate-cv.mjs` | Structural validator |
| `validate-core.mjs` | Validation check functions |
| `tests/*` | Unit + E2E test files |
| `__fixtures__/*` | Test fixtures (synthetic experience_source + profile + JDs) |
```

Remove the `cv-sync-check.mjs` row if present (it isn't in the current table — verify).

- [ ] **Step 3: Add a paragraph explaining the artifact change**

After the System Layer table, add:

```markdown
## Note on cv.md (removed)

This fork removes `cv.md` as a hand-edited file. All CV content lives in
`experience_source/{company}/{facet}.md`. A per-JD `cv.tailored.md` is
produced by `assemble-cv.mjs --jd=<path>` and consumed by every mode that
has a JD in context. `cv.tailored.md` is gitignored.
```

- [ ] **Step 4: Commit**

```bash
git add DATA_CONTRACT.md
git commit -m "docs: update DATA_CONTRACT.md for experience_source layer"
```

---

### Task 3: Add cv.tailored.md to .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append entries**

Append at the end of `.gitignore`:

```
# Tailored CV intermediate artifact (per-JD, regenerated each run)
cv.tailored.md
.cv-tailored-meta.json
.cv-tailored-errors.json

# Removed in fork: cv.md is no longer hand-edited
cv.md
```

- [ ] **Step 2: Verify**

Run: `git check-ignore cv.tailored.md cv.md .cv-tailored-meta.json`
Expected: each path printed (means ignored).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore cv.tailored.md and removed cv.md"
```

---

### Task 4: Add config/synonyms.yml

**Files:**
- Create: `config/synonyms.yml`

- [ ] **Step 1: Create the file with initial content**

```yaml
# Synonyms for keyword scoring in assemble-cv.mjs
# Format: each entry maps a canonical term to a list of equivalent surface forms.
# Matching is case-insensitive, whole-word.

groups:
  - canonical: rag
    aliases: [rag pipeline, rag pipelines, retrieval-augmented generation, retrieval augmented generation, retrieval over embeddings]
  - canonical: llm
    aliases: [llms, large language model, large language models, foundation model, foundation models]
  - canonical: vector_db
    aliases: [vector database, vector store, embeddings store, semantic search index, pinecone, weaviate, qdrant, chroma]
  - canonical: mlops
    aliases: [ml ops, ml-ops, ml platform, ml infra, ml infrastructure, model ops]
  - canonical: feature_store
    aliases: [feature store, feature platform, online feature serving]
  - canonical: kubernetes
    aliases: [k8s, kube]
  - canonical: ci_cd
    aliases: [ci/cd, ci cd, continuous integration, continuous delivery, continuous deployment]
  - canonical: react
    aliases: [react.js, reactjs]
  - canonical: nextjs
    aliases: [next.js, next js]
  - canonical: typescript
    aliases: [ts]
  - canonical: postgres
    aliases: [postgresql, pg]
  - canonical: observability
    aliases: [monitoring, metrics, traces, logging, telemetry]
  - canonical: distributed_systems
    aliases: [distributed system, distributed compute, distributed training]
  - canonical: design_system
    aliases: [design systems, component library, ui library]
```

- [ ] **Step 2: Commit**

```bash
git add config/synonyms.yml
git commit -m "feat: seed config/synonyms.yml with ML/web canonical terms"
```

---

### Task 5: Update config/profile.example.yml with new fields

**Files:**
- Modify: `config/profile.example.yml`

- [ ] **Step 1: Append new sections**

Append at the end of the file:

```yaml

# ── Experience-Source Assembly (this fork) ──────────────────────────

experience_sources:
  root: experience_source
  archetypes:
    frontend: frontend.md
    backend: backend.md
    infra: infra.md
    machine_learning: machine_learning.md
  jd_archetype_sources:
    frontend:         [frontend]
    backend:          [backend]
    infra:            [infra]
    machine_learning: [machine_learning]
    fullstack:        [frontend, backend]
  overrides:
    # Example: force a current employer to never appear as stub
    # acme:
    #   tier_floor: full
    #   stub: "Shipped production systems on a high-traffic AI platform."

archetype_defaults:
  frontend:         { top_bullets_full: 4, top_projects: 3 }
  backend:          { top_bullets_full: 5, top_projects: 4 }
  infra:            { top_bullets_full: 4, top_projects: 3 }
  machine_learning: { top_bullets_full: 5, top_projects: 4 }
  fullstack:        { top_bullets_full: 5, top_projects: 4 }

tier_rules:
  light_bullets: 2

prefer_latex: false
```

- [ ] **Step 2: Commit**

```bash
git add config/profile.example.yml
git commit -m "docs: example profile.yml with experience_sources fields"
```

---

### Task 6: Delete cv-sync-check.mjs and its test-all hook

**Files:**
- Delete: `cv-sync-check.mjs`
- Modify: `test-all.mjs:65-72`
- Modify: `package.json`

- [ ] **Step 1: Delete the script**

Run: `git rm cv-sync-check.mjs`

- [ ] **Step 2: Remove from test-all.mjs scripts list**

In `test-all.mjs`, find the `scripts` array (currently around line 65–72) and delete this line:

```js
{ name: 'cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
```

- [ ] **Step 3: Remove from package.json**

In `package.json`, delete the `"sync-check": "node cv-sync-check.mjs"` script.

- [ ] **Step 4: Verify test-all still runs**

Run: `node test-all.mjs --quick`
Expected: section 1 syntax checks pass (cv-sync-check no longer in mjsFiles); section 2 doesn't try to run it.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "chore: remove cv-sync-check.mjs (no cv.md in this fork)"
```

---

## Phase B — validate-core.mjs (TDD)

### Task 7: Write failing test for fuzzy match utility

**Files:**
- Create: `tests/validate.provenance.test.mjs`

- [ ] **Step 1: Create the test file**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levenshteinRatio } from '../validate-core.mjs';

test('levenshteinRatio: identical strings → 1.0', () => {
  assert.equal(levenshteinRatio('hello world', 'hello world'), 1.0);
});

test('levenshteinRatio: empty strings → 1.0', () => {
  assert.equal(levenshteinRatio('', ''), 1.0);
});

test('levenshteinRatio: completely different → low', () => {
  const r = levenshteinRatio('abc', 'xyz');
  assert.ok(r <= 0.34, `expected <=0.34 got ${r}`);
});

test('levenshteinRatio: ATS rephrase still matches above 0.85', () => {
  const original = 'Built RAG pipeline with retrieval over embeddings';
  const rephrased = 'Built RAG pipeline with vector retrieval embeddings';
  const r = levenshteinRatio(original, rephrased);
  assert.ok(r >= 0.85, `expected >=0.85 got ${r}`);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/validate.provenance.test.mjs`
Expected: FAIL with "Cannot find module '../validate-core.mjs'"

---

### Task 8: Implement validate-core.mjs with levenshteinRatio

**Files:**
- Create: `validate-core.mjs`

- [ ] **Step 1: Create file with levenshtein utility**

```js
/**
 * validate-core.mjs — Pure functions for cv.tailored.md validation.
 */

/** Levenshtein distance (iterative, two-row). */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Returns 1.0 - normalized edit distance, in [0, 1]. */
export function levenshteinRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/validate.provenance.test.mjs`
Expected: 4/4 pass.

- [ ] **Step 3: Commit**

```bash
git add validate-core.mjs tests/validate.provenance.test.mjs
git commit -m "feat(validate): add levenshteinRatio utility (TDD)"
```

---

### Task 9: Failing test for checkCompanyCoverage

**Files:**
- Create: `tests/validate.coverage.test.mjs`

- [ ] **Step 1: Create test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompanyCoverage } from '../validate-core.mjs';

test('coverage: all companies present → no errors', () => {
  const tailored = `## Work Experience\n\n### Acme Corp — SF\n**Senior Engineer** | 2023-04 → 2024-11\n\n- bullet <!-- src:acme/backend.md#L1 -->\n\n### Globex Inc — NYC\n**Engineer** | 2020 → 2023\n`;
  const required = ['acme', 'globex'];
  const errors = checkCompanyCoverage(tailored, required);
  assert.deepEqual(errors, []);
});

test('coverage: missing company detected', () => {
  const tailored = `### Acme Corp — SF\n**Senior Engineer** | 2023 → 2024\n`;
  const required = ['acme', 'globex'];
  const errors = checkCompanyCoverage(tailored, required);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'missing_company');
  assert.equal(errors[0].company, 'globex');
});

test('coverage: extra company is not an error', () => {
  const tailored = `### Acme Corp\n### Globex Inc\n### Initech\n`;
  const required = ['acme', 'globex'];
  const errors = checkCompanyCoverage(tailored, required);
  assert.deepEqual(errors, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/validate.coverage.test.mjs`
Expected: FAIL — `checkCompanyCoverage` not exported.

---

### Task 10: Implement checkCompanyCoverage

**Files:**
- Modify: `validate-core.mjs` (append)

- [ ] **Step 1: Add exports**

Append to `validate-core.mjs`:

```js
/**
 * Extract company headers from a tailored CV markdown.
 * Matches: ### CompanyName ... (third-level headings under Work Experience).
 * Returns the company part lowercased and slugified to compare against directory names.
 */
export function extractCompanyHeaders(markdown) {
  const headers = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)(?:\s+—\s+|\s+--\s+|$)/);
    if (m) {
      const slug = m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      headers.push(slug);
    }
  }
  return headers;
}

/**
 * Check that every required company directory has a header in the tailored CV.
 * @param {string} markdown — cv.tailored.md content
 * @param {string[]} required — company directory names (already kebab-case)
 * @returns {Array<{type: string, company: string, hint: string}>}
 */
export function checkCompanyCoverage(markdown, required) {
  const present = new Set(extractCompanyHeaders(markdown));
  const errors = [];
  for (const company of required) {
    // Match either exact slug or a slug that starts with the directory name
    // (so "Acme Corp" header satisfies "acme" required).
    const matched = [...present].some(p => p === company || p.startsWith(company + '-') || p.startsWith(company));
    if (!matched) {
      errors.push({
        type: 'missing_company',
        company,
        hint: `Company "${company}" missing from cv.tailored.md. Ensure stub or higher tier is assigned.`,
      });
    }
  }
  return errors;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/validate.coverage.test.mjs`
Expected: 3/3 pass.

- [ ] **Step 3: Commit**

```bash
git add validate-core.mjs tests/validate.coverage.test.mjs
git commit -m "feat(validate): checkCompanyCoverage with header extraction"
```

---

### Task 11: Failing test for checkBulletProvenance

**Files:**
- Create: `tests/validate.provenance.test.mjs` (append; if file already exists from Task 7, append; otherwise create)

- [ ] **Step 1: Append tests for provenance check**

Append to `tests/validate.provenance.test.mjs`:

```js
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBulletProvenance } from '../validate-core.mjs';

function withTempSource(setup, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-fixture-'));
  try {
    setup(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('provenance: bullet matches source → no error', () => {
  withTempSource(
    (dir) => {
      mkdirSync(join(dir, 'acme'), { recursive: true });
      writeFileSync(join(dir, 'acme', 'backend.md'), '## Bullets\n\n- Built distributed queue handling 10K rps\n');
    },
    (dir) => {
      const tailored = '- Built distributed queue handling 10K rps <!-- src:acme/backend.md#L3 -->';
      const errors = checkBulletProvenance(tailored, dir);
      assert.deepEqual(errors, []);
    }
  );
});

test('provenance: fabricated bullet detected', () => {
  withTempSource(
    (dir) => {
      mkdirSync(join(dir, 'acme'), { recursive: true });
      writeFileSync(join(dir, 'acme', 'backend.md'), '## Bullets\n\n- Real bullet here\n');
    },
    (dir) => {
      const tailored = '- Totally fabricated content <!-- src:acme/backend.md#L3 -->';
      const errors = checkBulletProvenance(tailored, dir);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].type, 'fabricated_bullet');
    }
  );
});

test('provenance: missing marker detected', () => {
  const tailored = '- Bullet without provenance';
  const errors = checkBulletProvenance(tailored, '/nonexistent');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'missing_marker');
});

test('provenance: ATS rephrase within 0.85 ratio passes', () => {
  withTempSource(
    (dir) => {
      mkdirSync(join(dir, 'acme'), { recursive: true });
      writeFileSync(join(dir, 'acme', 'backend.md'), '## Bullets\n\n- Built RAG pipeline with retrieval over embeddings\n');
    },
    (dir) => {
      const tailored = '- Built RAG pipeline with vector retrieval embeddings <!-- src:acme/backend.md#L3 -->';
      const errors = checkBulletProvenance(tailored, dir);
      assert.deepEqual(errors, []);
    }
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/validate.provenance.test.mjs`
Expected: 4 new tests fail with "checkBulletProvenance is not exported".

---

### Task 12: Implement checkBulletProvenance

**Files:**
- Modify: `validate-core.mjs` (append)

- [ ] **Step 1: Add exports**

Append to `validate-core.mjs`:

```js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FUZZY_THRESHOLD = 0.85;

/**
 * Extract all bullets and their provenance markers from a tailored CV.
 * @returns {Array<{text: string, marker: {path: string, line: number}|null, raw: string}>}
 */
export function extractBulletsWithProvenance(markdown) {
  const bullets = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.+?)(?:\s*<!--\s*src:([^#\s]+)(?:#L(\d+))?\s*-->)?\s*$/);
    if (m) {
      const text = m[1].trim();
      const path = m[2] || null;
      const lineNo = m[3] ? Number(m[3]) : null;
      bullets.push({
        text,
        marker: path ? { path, line: lineNo } : null,
        raw: line,
      });
    }
  }
  return bullets;
}

/**
 * Read all bullet texts from a source file's "## Bullets" section.
 */
function readSourceBullets(absPath) {
  if (!existsSync(absPath)) return null;
  const content = readFileSync(absPath, 'utf-8');
  const bulletsSection = content.match(/##\s+Bullets\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!bulletsSection) return [];
  const bullets = [];
  for (const line of bulletsSection[1].split('\n')) {
    const m = line.match(/^\s*-\s+(.+?)\s*$/);
    if (m) bullets.push(m[1].trim());
  }
  return bullets;
}

/**
 * @param {string} markdown — cv.tailored.md content
 * @param {string} sourcesRoot — absolute path to experience_source/ root
 * @returns {Array<{type: string, ...}>}
 */
export function checkBulletProvenance(markdown, sourcesRoot) {
  const bullets = extractBulletsWithProvenance(markdown);
  const errors = [];
  for (const b of bullets) {
    if (!b.marker) {
      errors.push({
        type: 'missing_marker',
        bullet: b.text,
        hint: 'Every bullet in cv.tailored.md must end with <!-- src:path/to/file.md#Lnnn -->',
      });
      continue;
    }
    const sourcePath = join(sourcesRoot, b.marker.path);
    const sourceBullets = readSourceBullets(sourcePath);
    if (sourceBullets === null) {
      errors.push({
        type: 'source_not_found',
        bullet: b.text,
        path: b.marker.path,
        hint: `Source file ${b.marker.path} does not exist.`,
      });
      continue;
    }
    const matched = sourceBullets.some(src => levenshteinRatio(b.text, src) >= FUZZY_THRESHOLD);
    if (!matched) {
      errors.push({
        type: 'fabricated_bullet',
        bullet: b.text,
        expected_sources: [b.marker.path],
        hint: `Bullet not found in candidate pool of ${b.marker.path}; only select from provided pool.`,
      });
    }
  }
  return errors;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/validate.provenance.test.mjs`
Expected: 8/8 pass (4 from Task 7 + 4 new).

- [ ] **Step 3: Commit**

```bash
git add validate-core.mjs tests/validate.provenance.test.mjs
git commit -m "feat(validate): checkBulletProvenance with fuzzy match"
```

---

### Task 13: Failing test for checkChronologicalOrder

**Files:**
- Create: `tests/validate.chronology.test.mjs`

- [ ] **Step 1: Create test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChronologicalOrder } from '../validate-core.mjs';

test('chronology: companies in correct reverse-chrono order → no error', () => {
  const tailored = `### Acme — SF\n### Globex — NYC\n### Initech — Boston\n`;
  const expected = ['acme', 'globex', 'initech'];
  const errors = checkChronologicalOrder(tailored, expected);
  assert.deepEqual(errors, []);
});

test('chronology: out-of-order detected', () => {
  const tailored = `### Globex — NYC\n### Acme — SF\n`;
  const expected = ['acme', 'globex'];
  const errors = checkChronologicalOrder(tailored, expected);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'chronology_violation');
  assert.deepEqual(errors[0].found, ['globex', 'acme']);
  assert.deepEqual(errors[0].expected, ['acme', 'globex']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/validate.chronology.test.mjs`
Expected: FAIL — `checkChronologicalOrder` not exported.

---

### Task 14: Implement checkChronologicalOrder

**Files:**
- Modify: `validate-core.mjs` (append)

- [ ] **Step 1: Add export**

Append to `validate-core.mjs`:

```js
/**
 * Verify that company headers in cv.tailored.md appear in the expected order.
 * @param {string} markdown
 * @param {string[]} expected — companies in the order they should appear (already chronologically sorted)
 */
export function checkChronologicalOrder(markdown, expected) {
  const found = extractCompanyHeaders(markdown);
  // Reduce found to only those that appear in expected (in case extras exist)
  const reduced = found.filter(c => expected.some(e => c === e || c.startsWith(e + '-') || c.startsWith(e)))
    .map(c => expected.find(e => c === e || c.startsWith(e + '-') || c.startsWith(e)));
  for (let i = 0; i < expected.length; i++) {
    if (reduced[i] !== expected[i]) {
      return [{
        type: 'chronology_violation',
        found: reduced,
        expected,
        hint: 'Companies must appear in reverse chronological order (most recent first).',
      }];
    }
  }
  return [];
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/validate.chronology.test.mjs`
Expected: 2/2 pass.

- [ ] **Step 3: Commit**

```bash
git add validate-core.mjs tests/validate.chronology.test.mjs
git commit -m "feat(validate): checkChronologicalOrder"
```

---

### Task 15: Build validate-cv.mjs CLI

**Files:**
- Create: `validate-cv.mjs`

- [ ] **Step 1: Write CLI**

```js
#!/usr/bin/env node
/**
 * validate-cv.mjs — Hard structural gate before PDF generation.
 *
 * Usage:
 *   node validate-cv.mjs <cv.tailored.md> [--sources=experience_source]
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more violations (errors written as JSON to stderr and to .cv-tailored-errors.json)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCompanyCoverage,
  checkBulletProvenance,
  checkChronologicalOrder,
} from './validate-core.mjs';
import { loadConfig, sortCompanies } from './assemble-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let input = null;
  let sourcesRoot = null;
  for (const arg of argv) {
    if (arg.startsWith('--sources=')) sourcesRoot = arg.split('=')[1];
    else if (!input) input = arg;
  }
  return { input, sourcesRoot };
}

function listCompanyDirs(sourcesRoot) {
  return readdirSync(sourcesRoot)
    .filter(name => statSync(resolve(sourcesRoot, name)).isDirectory())
    .filter(name => !name.startsWith('.') && !name.startsWith('_'))
    .sort();
}

async function main() {
  const { input, sourcesRoot: explicitRoot } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error('Usage: node validate-cv.mjs <cv.tailored.md> [--sources=experience_source]');
    process.exit(1);
  }
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }
  const markdown = readFileSync(inputPath, 'utf-8');

  const config = loadConfig(resolve(__dirname, 'config/profile.yml'));
  const sourcesRoot = resolve(__dirname, explicitRoot || config.experience_sources?.root || 'experience_source');

  const requiredCompanies = listCompanyDirs(sourcesRoot);
  const sortedCompanies = await sortCompanies(sourcesRoot, requiredCompanies);

  const errors = [
    ...checkCompanyCoverage(markdown, requiredCompanies),
    ...checkBulletProvenance(markdown, sourcesRoot),
    ...checkChronologicalOrder(markdown, sortedCompanies),
  ];

  if (errors.length > 0) {
    const payload = { ok: false, errors };
    const errorsPath = resolve(__dirname, '.cv-tailored-errors.json');
    writeFileSync(errorsPath, JSON.stringify(payload, null, 2));
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, checks_passed: 3 }, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('validate-cv.mjs crashed:', err.message);
  process.exit(2);
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check validate-cv.mjs`
Expected: no output (means OK).

- [ ] **Step 3: Smoke test (will fail because assemble-core.mjs doesn't exist yet)**

Run: `node validate-cv.mjs /tmp/nonexistent.md 2>&1 | head -1`
Expected: error mentioning either "Input file not found" or import failure for assemble-core. Either is acceptable at this stage; this just confirms the CLI parses.

- [ ] **Step 4: Commit**

```bash
git add validate-cv.mjs
git commit -m "feat(validate): CLI wrapping the three structural checks"
```

---

## Phase C — assemble-core.mjs (TDD: parse, sort, score, tier, render)

### Task 16: Failing test for parseSourceFile

**Files:**
- Create: `tests/assemble.parse.test.mjs`

- [ ] **Step 1: Create test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceFile } from '../assemble-core.mjs';

const sample = `---
company: Acme Corp
role: Senior Engineer
location: San Francisco, CA
start: 2023-04
end: 2024-11
facet: backend
---

## Bullets

- Built distributed queue handling 10K rps
- Migrated monolith to microservices over 6 months

## Projects

- **Queue Service** — Kafka-based, 99.99% delivery
  - Handled DLQ replay logic
- **Monolith Migration** — strangler-fig pattern, zero-downtime

## Skills used

Go, Kafka, Postgres, Kubernetes
`;

test('parseSourceFile: extracts frontmatter', () => {
  const parsed = parseSourceFile(sample);
  assert.equal(parsed.frontmatter.company, 'Acme Corp');
  assert.equal(parsed.frontmatter.role, 'Senior Engineer');
  assert.equal(parsed.frontmatter.start, '2023-04');
  assert.equal(parsed.frontmatter.facet, 'backend');
});

test('parseSourceFile: extracts bullets', () => {
  const parsed = parseSourceFile(sample);
  assert.equal(parsed.bullets.length, 2);
  assert.match(parsed.bullets[0].text, /distributed queue/);
  assert.equal(parsed.bullets[0].lineNumber, 11);
});

test('parseSourceFile: extracts projects (top-level only, not indented details)', () => {
  const parsed = parseSourceFile(sample);
  assert.equal(parsed.projects.length, 2);
  assert.match(parsed.projects[0].text, /Queue Service/);
});

test('parseSourceFile: extracts skills as array', () => {
  const parsed = parseSourceFile(sample);
  assert.deepEqual(parsed.skills, ['Go', 'Kafka', 'Postgres', 'Kubernetes']);
});

test('parseSourceFile: missing required frontmatter throws', () => {
  const broken = `---\ncompany: Acme\n---\n## Bullets\n- foo`;
  assert.throws(() => parseSourceFile(broken), /frontmatter/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/assemble.parse.test.mjs`
Expected: FAIL — module not found.

---

### Task 17: Implement parseSourceFile

**Files:**
- Create: `assemble-core.mjs`

- [ ] **Step 1: Create file**

```js
/**
 * assemble-core.mjs — Pure (non-LLM) functions for tailored CV assembly.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUIRED_FRONTMATTER = ['company', 'role', 'location', 'start', 'end', 'facet'];

/**
 * Parse one experience_source/{company}/{facet}.md file.
 * Returns { frontmatter, bullets, projects, skills }.
 */
export function parseSourceFile(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('parseSourceFile: file must start with --- frontmatter ---');
  const frontmatter = yaml.load(m[1]);
  for (const key of REQUIRED_FRONTMATTER) {
    if (!(key in frontmatter)) {
      throw new Error(`parseSourceFile: frontmatter missing required key "${key}"`);
    }
  }
  const body = m[2];
  const bodyOffset = m[1].split('\n').length + 2;  // 1 for opening ---, 1 for closing ---

  const bullets = extractSection(body, 'Bullets', bodyOffset);
  const projects = extractSection(body, 'Projects', bodyOffset, true);
  const skills = extractSkills(body);

  return { frontmatter, bullets, projects, skills };
}

/**
 * Extract `## Section` items as bullets. If projectsMode, takes only top-level
 * (non-indented) lines; indented sub-bullets become `details` of the parent.
 */
function extractSection(body, sectionName, lineOffset, projectsMode = false) {
  const sectionRe = new RegExp(`##\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'm');
  const m = body.match(sectionRe);
  if (!m) return [];
  const sectionStartOffset = body.slice(0, m.index).split('\n').length + 1; // ##  line
  const lines = m[1].split('\n');
  const items = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = lineOffset + sectionStartOffset + i + 1; // 1-based, accounting for the ## line itself
    const top = line.match(/^-\s+(.+?)\s*$/);
    const sub = line.match(/^\s+-\s+(.+?)\s*$/);
    if (top) {
      current = { text: top[1].trim(), lineNumber, details: [] };
      items.push(current);
    } else if (sub && projectsMode && current) {
      current.details.push(sub[1].trim());
    }
  }
  return items;
}

function extractSkills(body) {
  const m = body.match(/##\s+Skills used\s*\n+([^\n]+)/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/assemble.parse.test.mjs`
Expected: 5/5 pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-core.mjs tests/assemble.parse.test.mjs
git commit -m "feat(assemble): parseSourceFile with frontmatter validation"
```

---

### Task 18: Failing test for loadAllSources + cross-facet consistency

**Files:**
- Modify: `tests/assemble.parse.test.mjs` (append)

- [ ] **Step 1: Append tests**

```js
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAllSources, validateConsistency } from '../assemble-core.mjs';

function withFakeSources(setup, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-sources-'));
  try {
    setup(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const facetA = `---
company: Acme Corp
role: Senior Engineer
location: SF
start: 2023-04
end: 2024-11
facet: backend
---
## Bullets
- A1
- A2
`;

const facetB = `---
company: Acme Corp
role: Senior Engineer
location: SF
start: 2023-04
end: 2024-11
facet: frontend
---
## Bullets
- B1
`;

const facetMismatch = `---
company: Acme Corp
role: Staff Engineer
location: SF
start: 2023-04
end: 2024-11
facet: frontend
---
## Bullets
- B1
`;

test('loadAllSources: groups files by company', () => {
  withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'acme'));
      writeFileSync(join(dir, 'acme', 'backend.md'), facetA);
      writeFileSync(join(dir, 'acme', 'frontend.md'), facetB);
    },
    (dir) => {
      const sources = loadAllSources(dir);
      assert.equal(Object.keys(sources).length, 1);
      assert.equal(sources.acme.length, 2);
    }
  );
});

test('validateConsistency: identical role across facets → ok', () => {
  withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'acme'));
      writeFileSync(join(dir, 'acme', 'backend.md'), facetA);
      writeFileSync(join(dir, 'acme', 'frontend.md'), facetB);
    },
    (dir) => {
      const sources = loadAllSources(dir);
      assert.doesNotThrow(() => validateConsistency(sources));
    }
  );
});

test('validateConsistency: mismatched role across facets throws', () => {
  withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'acme'));
      writeFileSync(join(dir, 'acme', 'backend.md'), facetA);
      writeFileSync(join(dir, 'acme', 'frontend.md'), facetMismatch);
    },
    (dir) => {
      const sources = loadAllSources(dir);
      assert.throws(() => validateConsistency(sources), /role/i);
    }
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/assemble.parse.test.mjs`
Expected: 3 new tests fail with "loadAllSources is not exported".

---

### Task 19: Implement loadAllSources + validateConsistency

**Files:**
- Modify: `assemble-core.mjs` (append)

- [ ] **Step 1: Append**

```js
/**
 * Walk a sources root and return { [companyDir]: [parsedFacetFile, ...] }.
 */
export function loadAllSources(sourcesRoot) {
  const out = {};
  const dirs = readdirSync(sourcesRoot)
    .filter(name => statSync(join(sourcesRoot, name)).isDirectory())
    .filter(name => !name.startsWith('.') && !name.startsWith('_'));
  for (const company of dirs) {
    const dir = join(sourcesRoot, company);
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    out[company] = [];
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      try {
        const parsed = parseSourceFile(content);
        parsed._sourcePath = join(company, file);
        out[company].push(parsed);
      } catch (err) {
        throw new Error(`${join(company, file)}: ${err.message}`);
      }
    }
  }
  return out;
}

/**
 * Within each company, every facet file must agree on role / start / end / location.
 */
export function validateConsistency(sources) {
  for (const [company, files] of Object.entries(sources)) {
    if (files.length < 2) continue;
    const ref = files[0].frontmatter;
    for (const f of files.slice(1)) {
      for (const key of ['role', 'start', 'end', 'location']) {
        if (f.frontmatter[key] !== ref[key]) {
          throw new Error(
            `Cross-facet mismatch in ${company}: "${key}" differs ` +
            `("${ref[key]}" in ${files[0]._sourcePath} vs "${f.frontmatter[key]}" in ${f._sourcePath})`
          );
        }
      }
    }
  }
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/assemble.parse.test.mjs`
Expected: 8/8 pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-core.mjs tests/assemble.parse.test.mjs
git commit -m "feat(assemble): loadAllSources + cross-facet consistency check"
```

---

### Task 20: Failing test for sortCompanies

**Files:**
- Create test entries in: `tests/assemble.parse.test.mjs` (append)

- [ ] **Step 1: Append test**

```js
import { sortCompanies } from '../assemble-core.mjs';

const _2024 = (facet) => `---
company: A
role: r
location: l
start: 2024-01
end: present
facet: ${facet}
---
## Bullets
- x
`;

const _2020 = (facet) => `---
company: B
role: r
location: l
start: 2020-01
end: 2023-12
facet: ${facet}
---
## Bullets
- x
`;

test('sortCompanies: most recent first by start date', async () => {
  await withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'older'));
      mkdirSync(join(dir, 'newer'));
      writeFileSync(join(dir, 'older', 'backend.md'), _2020('backend'));
      writeFileSync(join(dir, 'newer', 'backend.md'), _2024('backend'));
    },
    async (dir) => {
      const sorted = await sortCompanies(dir, ['older', 'newer']);
      assert.deepEqual(sorted, ['newer', 'older']);
    }
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/assemble.parse.test.mjs`
Expected: new test fails — `sortCompanies` not exported.

---

### Task 21: Implement sortCompanies

**Files:**
- Modify: `assemble-core.mjs` (append)

- [ ] **Step 1: Append**

```js
/**
 * Returns company directory names sorted reverse-chronologically by frontmatter start.
 * Tie-break: end desc, then alphabetical.
 *
 * "present" or empty end is treated as a date past any actual date.
 */
export async function sortCompanies(sourcesRoot, companyDirs) {
  const dated = companyDirs.map(dir => {
    const facetFiles = readdirSync(join(sourcesRoot, dir)).filter(f => f.endsWith('.md'));
    if (facetFiles.length === 0) return { dir, start: '0000-00', end: '0000-00' };
    const first = parseSourceFile(readFileSync(join(sourcesRoot, dir, facetFiles[0]), 'utf-8'));
    const start = String(first.frontmatter.start);
    const endRaw = String(first.frontmatter.end || 'present');
    const end = endRaw.toLowerCase() === 'present' ? '9999-99' : endRaw;
    return { dir, start, end };
  });
  dated.sort((a, b) => {
    if (a.start !== b.start) return b.start.localeCompare(a.start);
    if (a.end !== b.end) return b.end.localeCompare(a.end);
    return a.dir.localeCompare(b.dir);
  });
  return dated.map(d => d.dir);
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/assemble.parse.test.mjs`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-core.mjs tests/assemble.parse.test.mjs
git commit -m "feat(assemble): sortCompanies by reverse-chronological start"
```

---

### Task 22: Failing test for keyword scoring

**Files:**
- Create: `tests/assemble.scoring.test.mjs`

- [ ] **Step 1: Create test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywords, expandSynonyms, scoreBullet } from '../assemble-core.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYNONYM_YAML = `
groups:
  - canonical: rag
    aliases: [rag pipeline, retrieval-augmented generation]
  - canonical: vector_db
    aliases: [vector database, pinecone]
`;

function withSynonyms(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'syn-'));
  const path = join(dir, 'synonyms.yml');
  writeFileSync(path, SYNONYM_YAML);
  return fn(path);
}

test('extractKeywords: extracts capitalized phrases and tech tokens', () => {
  const jd = 'We are hiring a Senior Backend Engineer with Postgres, Kafka, and Kubernetes experience.';
  const keywords = extractKeywords(jd);
  assert.ok(keywords.has('postgres'));
  assert.ok(keywords.has('kafka'));
  assert.ok(keywords.has('kubernetes'));
});

test('expandSynonyms: expands canonical via synonyms file', () => {
  withSynonyms((path) => {
    const expanded = expandSynonyms(new Set(['rag pipeline']), path);
    assert.ok(expanded.has('rag'));
    assert.ok(expanded.has('rag pipeline'));
    assert.ok(expanded.has('retrieval-augmented generation'));
  });
});

test('scoreBullet: counts unique keyword hits', () => {
  const bullet = 'Built RAG pipeline with Pinecone and OpenAI embeddings';
  const keywords = new Set(['rag pipeline', 'pinecone', 'embeddings']);
  assert.equal(scoreBullet(bullet, keywords), 3);
});

test('scoreBullet: case insensitive, whole-token match', () => {
  const bullet = 'Designed Postgres schema for high write throughput';
  const keywords = new Set(['postgres']);
  assert.equal(scoreBullet(bullet, keywords), 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/assemble.scoring.test.mjs`
Expected: FAIL — functions not exported.

---

### Task 23: Implement keyword extraction + scoring

**Files:**
- Modify: `assemble-core.mjs` (append)

- [ ] **Step 1: Append**

```js
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'with', 'for', 'of', 'to', 'in', 'on', 'at',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must',
  'we', 'our', 'you', 'your', 'their', 'this', 'that', 'these', 'those', 'job', 'role',
  'team', 'company', 'work', 'experience', 'years', 'year', 'looking', 'hiring', 'engineer',
  'engineering', 'senior', 'junior', 'staff', 'lead', 'principal',
]);

/**
 * Cheap keyword extraction: lowercase tokens 3+ chars, drop stopwords.
 * No stemming. Returns Set<string>.
 */
export function extractKeywords(jdText) {
  const tokens = jdText.toLowerCase().match(/[a-z][a-z0-9+#./-]{2,}/g) || [];
  const out = new Set();
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * Given a Set of keywords, expand each by adding all aliases from the synonym table
 * AND the canonical form when an alias matches.
 * @param {Set<string>} keywords
 * @param {string} synonymsPath — path to YAML
 * @returns {Set<string>}
 */
export function expandSynonyms(keywords, synonymsPath) {
  let table;
  try {
    table = yaml.load(readFileSync(synonymsPath, 'utf-8'));
  } catch {
    return new Set(keywords);
  }
  const expanded = new Set(keywords);
  for (const group of table.groups || []) {
    const allForms = [group.canonical, ...(group.aliases || [])];
    const lcForms = allForms.map(f => f.toLowerCase());
    const triggered = lcForms.some(f => expanded.has(f));
    if (triggered) {
      for (const f of lcForms) expanded.add(f);
    }
  }
  return expanded;
}

/**
 * Count the number of distinct keywords that appear in the bullet text (case-insensitive,
 * whole-phrase). Returns an integer.
 */
export function scoreBullet(bulletText, keywords) {
  const lc = bulletText.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`);
    if (re.test(lc)) hits++;
  }
  return hits;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/assemble.scoring.test.mjs`
Expected: 4/4 pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-core.mjs tests/assemble.scoring.test.mjs
git commit -m "feat(assemble): keyword extraction + synonyms + bullet scoring"
```

---

### Task 24: Failing test for tier assignment

**Files:**
- Create: `tests/assemble.tier.test.mjs`

- [ ] **Step 1: Create test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTier } from '../assemble-core.mjs';

test('tier: pool size 3+ → full', () => {
  assert.equal(assignTier(5, null), 'full');
  assert.equal(assignTier(3, null), 'full');
});

test('tier: pool 1-2 → light', () => {
  assert.equal(assignTier(2, null), 'light');
  assert.equal(assignTier(1, null), 'light');
});

test('tier: pool 0 → stub', () => {
  assert.equal(assignTier(0, null), 'stub');
});

test('tier: floor=full overrides empty pool', () => {
  assert.equal(assignTier(0, 'full'), 'full');
  assert.equal(assignTier(1, 'full'), 'full');
});

test('tier: floor=light prevents stub', () => {
  assert.equal(assignTier(0, 'light'), 'light');
  assert.equal(assignTier(2, 'light'), 'light');
  assert.equal(assignTier(5, 'light'), 'full');  // floor doesn't cap upward
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/assemble.tier.test.mjs`
Expected: FAIL — `assignTier` not exported.

---

### Task 25: Implement assignTier

**Files:**
- Modify: `assemble-core.mjs` (append)

- [ ] **Step 1: Append**

```js
/**
 * Decide the rendering tier for a company based on candidate pool size and per-company floor.
 * @param {number} poolSize
 * @param {'full'|'light'|'stub'|null} floor
 * @returns {'full'|'light'|'stub'}
 */
export function assignTier(poolSize, floor) {
  let natural;
  if (poolSize >= 3) natural = 'full';
  else if (poolSize >= 1) natural = 'light';
  else natural = 'stub';

  if (!floor) return natural;
  const order = { stub: 0, light: 1, full: 2 };
  return order[natural] >= order[floor] ? natural : floor;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/assemble.tier.test.mjs`
Expected: 5/5 pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-core.mjs tests/assemble.tier.test.mjs
git commit -m "feat(assemble): assignTier with floor override"
```

---

### Task 26: Failing test for renderTailored

**Files:**
- Create: `tests/assemble.render.test.mjs`

- [ ] **Step 1: Create test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTailored } from '../assemble-core.mjs';

const profile = {
  candidate: { full_name: 'Test User', email: 't@example.com', location: 'SF', linkedin: 'linkedin.com/in/x' },
  narrative: { headline: 'Backend engineer' },
};

const companies = [
  {
    dir: 'acme',
    frontmatter: { company: 'Acme Corp', role: 'Senior Engineer', location: 'SF', start: '2023-04', end: '2024-11' },
    tier: 'full',
    bullets: [
      { text: 'Built distributed queue', sourcePath: 'acme/backend.md', sourceLine: 11 },
      { text: 'Migrated monolith', sourcePath: 'acme/backend.md', sourceLine: 12 },
    ],
  },
  {
    dir: 'globex',
    frontmatter: { company: 'Globex Inc', role: 'Engineer', location: 'NYC', start: '2020-01', end: '2023-03' },
    tier: 'stub',
    stub: 'Built features on a global commerce platform.',
  },
];

const projects = [
  { text: '**Queue Service** — Kafka-based, 99.99% delivery', sourcePath: 'acme/backend.md', sourceLine: 15 },
];
const competencies = ['Distributed systems', 'Postgres', 'Kafka'];
const summary = 'Backend engineer with 5 years experience building distributed systems.';

test('renderTailored: includes header with name', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /# Test User/);
  assert.match(md, /t@example\.com/);
});

test('renderTailored: each company has H3 header and tier-appropriate bullets', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /### Acme Corp/);
  assert.match(md, /### Globex Inc/);
  assert.match(md, /Built distributed queue.*<!-- src:acme\/backend\.md#L11 -->/);
  assert.match(md, /Built features on a global commerce platform/);
});

test('renderTailored: projects have provenance markers', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /Queue Service.*<!-- src:acme\/backend\.md#L15 -->/);
});

test('renderTailored: competencies and summary present', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /Distributed systems/);
  assert.match(md, /Backend engineer with 5 years/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/assemble.render.test.mjs`
Expected: FAIL — `renderTailored` not exported.

---

### Task 27: Implement renderTailored

**Files:**
- Modify: `assemble-core.mjs` (append)

- [ ] **Step 1: Append**

```js
/**
 * Render the final cv.tailored.md markdown.
 * @param {object} args
 * @param {object} args.profile — config/profile.yml content
 * @param {Array} args.companies — [{dir, frontmatter, tier, bullets?, stub?}, ...] in render order
 * @param {Array} args.projects — selected projects with sourcePath, sourceLine
 * @param {string[]} args.competencies — Core Competency phrases
 * @param {string} args.summary — Professional Summary text
 * @returns {string} markdown
 */
export function renderTailored({ profile, companies, projects, competencies, summary }) {
  const c = profile.candidate || {};
  const lines = [];
  lines.push(`# ${c.full_name || 'Candidate'}`);
  lines.push('');
  const contact = [c.location, c.email, c.linkedin, c.portfolio_url].filter(Boolean).join(' · ');
  if (contact) lines.push(`*${contact}*`);
  lines.push('');

  lines.push('## Professional Summary');
  lines.push('');
  lines.push(summary);
  lines.push('');

  if (competencies?.length) {
    lines.push('## Core Competencies');
    lines.push('');
    lines.push(competencies.join(' · '));
    lines.push('');
  }

  lines.push('## Work Experience');
  lines.push('');
  for (const co of companies) {
    const fm = co.frontmatter;
    lines.push(`### ${fm.company} — ${fm.location}`);
    lines.push(`**${fm.role}** | ${fm.start} → ${fm.end}`);
    lines.push('');
    if (co.tier === 'stub') {
      lines.push(`- ${co.stub}`);
    } else {
      for (const b of co.bullets || []) {
        const marker = b.sourcePath ? ` <!-- src:${b.sourcePath}#L${b.sourceLine || 0} -->` : '';
        lines.push(`- ${b.text}${marker}`);
      }
    }
    lines.push('');
  }

  if (projects?.length) {
    lines.push('## Projects');
    lines.push('');
    for (const p of projects) {
      const marker = p.sourcePath ? ` <!-- src:${p.sourcePath}#L${p.sourceLine || 0} -->` : '';
      lines.push(`- ${p.text}${marker}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/assemble.render.test.mjs`
Expected: 4/4 pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-core.mjs tests/assemble.render.test.mjs
git commit -m "feat(assemble): renderTailored markdown output"
```

---

### Task 28: Add loadConfig helper

**Files:**
- Modify: `assemble-core.mjs` (append)

- [ ] **Step 1: Append**

```js
/**
 * Load and parse config/profile.yml. Throws if file missing.
 */
export function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Copy config/profile.example.yml.`);
  }
  return yaml.load(readFileSync(path, 'utf-8'));
}
```

- [ ] **Step 2: Verify import in validate-cv.mjs works**

Run: `node --check validate-cv.mjs && node --check assemble-core.mjs`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add assemble-core.mjs
git commit -m "feat(assemble): loadConfig helper"
```

---

## Phase D — assemble-llm.mjs (LLM-facing)

### Task 29: Create assemble-llm.mjs with mock-injectable client

**Files:**
- Create: `assemble-llm.mjs`

- [ ] **Step 1: Write file**

```js
/**
 * assemble-llm.mjs — LLM-facing functions (dependency-injected client for testability).
 *
 * Three calls per assembly:
 *   1. classifyArchetype(jd)         → "frontend" | "backend" | ...
 *   2. pickBullets(pool, jd, tier)   → selected bullets (per company)
 *   3. writeSummary(profile, jd)     → Professional Summary text
 */

import { Anthropic } from '@anthropic-ai/sdk';

const DEFAULT_MODEL = process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

export function defaultClient() {
  return new Anthropic();
}

export async function classifyArchetype(jdText, client = defaultClient()) {
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 50,
    system: 'You classify job descriptions into one archetype. Return ONLY one word.',
    messages: [{
      role: 'user',
      content: `Classify this JD into exactly one of: frontend, backend, infra, machine_learning, fullstack.
Reply with only the word, no punctuation.

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
  const text = response.content[0].text.trim().toLowerCase();
  const valid = ['frontend', 'backend', 'infra', 'machine_learning', 'fullstack'];
  if (!valid.includes(text)) {
    throw new Error(`classifyArchetype: invalid response "${text}"`);
  }
  return text;
}

/**
 * Given a candidate pool of bullets for ONE company and a JD summary, ask the LLM
 * to pick the top N most relevant. The LLM may make light ATS-friendly rephrasing
 * but cannot invent bullets.
 *
 * @param {Array<{text, sourcePath, sourceLine}>} pool
 * @param {string} jdText
 * @param {number} n — how many to pick
 * @param {object} client — Anthropic client (injectable for tests)
 * @returns {Promise<Array<{text, sourcePath, sourceLine}>>}
 */
export async function pickBullets(pool, jdText, n, client = defaultClient()) {
  if (pool.length === 0) return [];
  if (pool.length <= n) return pool;

  const numbered = pool.map((b, i) => `${i}: ${b.text}`).join('\n');
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1000,
    system: 'You pick the most relevant resume bullets for a job description. Return JSON only.',
    messages: [{
      role: 'user',
      content: `Pick the ${n} bullets most relevant to this JD. You may slightly rephrase to inject JD keywords (max 15% length change), but do NOT invent content.

Return JSON: {"selected": [{"index": <int>, "text": "<original or rephrased>"}, ...]}

JD:
${jdText.slice(0, 4000)}

BULLETS:
${numbered}`,
    }],
  });
  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`pickBullets: no JSON in response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.selected.map(s => {
    const original = pool[s.index];
    if (!original) throw new Error(`pickBullets: invalid index ${s.index}`);
    return { ...original, text: s.text };
  });
}

export async function writeSummary(profile, jdText, client = defaultClient()) {
  const headline = profile.narrative?.headline || 'Engineer';
  const exitStory = profile.narrative?.exit_story || '';
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 200,
    system: 'You write a 3-4 line Professional Summary section for a resume.',
    messages: [{
      role: 'user',
      content: `Write a Professional Summary (3-4 sentences, dense with JD keywords) given the candidate's headline and the JD. Do NOT invent skills.

CANDIDATE HEADLINE: ${headline}
EXIT STORY: ${exitStory}

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
  return response.content[0].text.trim();
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check assemble-llm.mjs`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add assemble-llm.mjs
git commit -m "feat(assemble): LLM-facing classify/pick/summary with injected client"
```

---

## Phase E — assemble-cv.mjs CLI orchestrator

### Task 30: Build assemble-cv.mjs CLI

**Files:**
- Create: `assemble-cv.mjs`

- [ ] **Step 1: Write CLI**

```js
#!/usr/bin/env node
/**
 * assemble-cv.mjs — Build cv.tailored.md from experience_source/ + JD.
 *
 * Usage:
 *   node assemble-cv.mjs --jd=jds/some-job.md [--archetype=backend] [--feedback=.cv-tailored-errors.json]
 *
 * Outputs:
 *   cv.tailored.md
 *   .cv-tailored-meta.json   (debug: pools, scores, tier decisions)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
} from './assemble-core.mjs';
import {
  defaultClient, classifyArchetype, pickBullets, writeSummary,
} from './assemble-llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_ROOT = resolve(__dirname, 'experience_source');
const SYNONYMS_PATH = resolve(__dirname, 'config/synonyms.yml');
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const OUT_TAILORED = resolve(__dirname, 'cv.tailored.md');
const OUT_META = resolve(__dirname, '.cv-tailored-meta.json');

const SCORE_THRESHOLD = 1; // bullet keeps if it has >= 1 keyword hit

function parseArgs(argv) {
  const out = { jd: null, archetype: null, feedback: null };
  for (const a of argv) {
    if (a.startsWith('--jd=')) out.jd = a.split('=')[1];
    else if (a.startsWith('--archetype=')) out.archetype = a.split('=')[1];
    else if (a.startsWith('--feedback=')) out.feedback = a.split('=')[1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.jd) {
    console.error('Usage: node assemble-cv.mjs --jd=<path> [--archetype=...] [--feedback=...]');
    process.exit(1);
  }
  const jdText = readFileSync(resolve(args.jd), 'utf-8');
  const config = loadConfig(PROFILE_PATH);
  const sources = loadAllSources(SOURCES_ROOT);
  validateConsistency(sources);

  const meta = { jd: args.jd, archetype: null, companies: [] };

  // 1. Classify archetype
  const archetype = args.archetype || await classifyArchetype(jdText);
  meta.archetype = archetype;

  // 2. Determine which facets to pull
  const facetsToUse = config.experience_sources.jd_archetype_sources[archetype];
  if (!facetsToUse) throw new Error(`No jd_archetype_sources entry for "${archetype}"`);

  // 3. Build keyword set
  let keywords = extractKeywords(jdText);
  keywords = expandSynonyms(keywords, SYNONYMS_PATH);
  meta.keyword_count = keywords.size;

  // 4. Sort companies
  const allDirs = Object.keys(sources);
  const sortedDirs = await sortCompanies(SOURCES_ROOT, allDirs);

  // 5. For each company, build candidate pool, assign tier, ask LLM to pick
  const companies = [];
  const allProjects = [];
  const allSkills = new Set();

  for (const dir of sortedDirs) {
    const facetFiles = sources[dir].filter(f => facetsToUse.includes(f.frontmatter.facet));
    const pool = [];
    for (const f of facetFiles) {
      for (const b of f.bullets) {
        const score = scoreBullet(b.text, keywords);
        if (score >= SCORE_THRESHOLD) {
          pool.push({
            text: b.text,
            sourcePath: f._sourcePath,
            sourceLine: b.lineNumber,
            score,
          });
        }
      }
      for (const p of f.projects) {
        allProjects.push({
          text: p.text,
          sourcePath: f._sourcePath,
          sourceLine: p.lineNumber,
          score: scoreBullet(p.text, keywords),
        });
      }
      for (const s of f.skills) allSkills.add(s);
    }
    pool.sort((a, b) => b.score - a.score);

    const floor = config.experience_sources.overrides?.[dir]?.tier_floor || null;
    const tier = assignTier(pool.length, floor);
    const fmRef = sources[dir][0].frontmatter;
    const co = { dir, frontmatter: fmRef, tier };

    if (tier === 'stub') {
      co.stub = config.experience_sources.overrides?.[dir]?.stub
        || `Worked at ${fmRef.company} as ${fmRef.role}.`;
    } else {
      const n = tier === 'full'
        ? (config.archetype_defaults?.[archetype]?.top_bullets_full || 4)
        : (config.tier_rules?.light_bullets || 2);
      const truncated = pool.slice(0, Math.max(n * 2, n + 2));
      co.bullets = await pickBullets(truncated, jdText, Math.min(n, truncated.length));
    }

    companies.push(co);
    meta.companies.push({ dir, tier, pool_size: pool.length, picked: co.bullets?.length || (co.stub ? 1 : 0) });
  }

  // 6. Projects: top-N across all
  const topProjects = config.archetype_defaults?.[archetype]?.top_projects || 3;
  allProjects.sort((a, b) => b.score - a.score);
  const projects = allProjects.slice(0, topProjects);

  // 7. Competencies: skills ∩ keyword set, top 6-8
  const competencies = [...allSkills]
    .filter(s => keywords.has(s.toLowerCase()))
    .slice(0, 8);

  // 8. Summary
  const summary = await writeSummary(config, jdText);

  // 9. Render
  const md = renderTailored({ profile: config, companies, projects, competencies, summary });
  writeFileSync(OUT_TAILORED, md);
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2));

  console.log(JSON.stringify({ ok: true, output: OUT_TAILORED, archetype, companies: meta.companies }, null, 2));
}

main().catch(err => {
  console.error('assemble-cv.mjs failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check assemble-cv.mjs`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add assemble-cv.mjs
git commit -m "feat(assemble): CLI orchestrator wiring core + LLM"
```

---

### Task 30a: Wire --feedback into pickBullets

**Files:**
- Modify: `assemble-llm.mjs`
- Modify: `assemble-cv.mjs`

- [ ] **Step 1: Extend pickBullets to accept an exclusion list**

Edit `assemble-llm.mjs`. Change `pickBullets` signature to accept `exclude`:

```js
export async function pickBullets(pool, jdText, n, client = defaultClient(), exclude = []) {
  if (pool.length === 0) return [];
  const filteredPool = pool.filter(p => !exclude.some(ex => ex.includes(p.text.slice(0, 40))));
  if (filteredPool.length <= n) return filteredPool;

  const numbered = filteredPool.map((b, i) => `${i}: ${b.text}`).join('\n');
  const excludeNote = exclude.length > 0
    ? `\n\nIMPORTANT: A previous attempt failed validation. Avoid rephrasing too aggressively — keep wording very close to the original bullet text. Bullets that previously failed validation: ${exclude.slice(0, 5).map(e => `"${e.slice(0, 60)}"`).join(', ')}`
    : '';

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1000,
    system: 'You pick the most relevant resume bullets for a job description. Return JSON only.',
    messages: [{
      role: 'user',
      content: `Pick the ${n} bullets most relevant to this JD. You may slightly rephrase to inject JD keywords (max 15% length change), but do NOT invent content.${excludeNote}

Return JSON: {"selected": [{"index": <int>, "text": "<original or rephrased>"}, ...]}

JD:
${jdText.slice(0, 4000)}

BULLETS:
${numbered}`,
    }],
  });
  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`pickBullets: no JSON in response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.selected.map(s => {
    const original = filteredPool[s.index];
    if (!original) throw new Error(`pickBullets: invalid index ${s.index}`);
    return { ...original, text: s.text };
  });
}
```

- [ ] **Step 2: Wire feedback in assemble-cv.mjs**

Edit `assemble-cv.mjs`. After the `parseArgs` call, add:

```js
let excludeBullets = [];
if (args.feedback) {
  try {
    const errs = JSON.parse(readFileSync(resolve(args.feedback), 'utf-8'));
    excludeBullets = (errs.errors || [])
      .filter(e => e.type === 'fabricated_bullet')
      .map(e => e.bullet);
  } catch {
    // feedback file not present or unreadable — proceed without
  }
}
```

Then in the company loop, change the pickBullets call:

```js
co.bullets = await pickBullets(truncated, jdText, Math.min(n, truncated.length), defaultClient(), excludeBullets);
```

(Add `defaultClient` to the existing import from assemble-llm.mjs.)

- [ ] **Step 3: Verify syntax**

Run: `node --check assemble-llm.mjs assemble-cv.mjs`
Expected: no output.

- [ ] **Step 4: Update mock client in e2e test to accept exclude param**

The mock in `tests/e2e.assemble.test.mjs` already ignores extra args, so no change needed. Verify:

Run: `node --test tests/e2e.assemble.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add assemble-llm.mjs assemble-cv.mjs
git commit -m "feat(assemble): thread --feedback through pickBullets exclusion"
```

---

### Task 30b: Parse article-digest.md and feed into Projects pool

**Files:**
- Modify: `assemble-core.mjs`
- Modify: `assemble-cv.mjs`
- Create: `tests/assemble.article.test.mjs`

- [ ] **Step 1: Failing test for parseArticleDigest**

Create `tests/assemble.article.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticleDigest } from '../assemble-core.mjs';

const sample = `# Article Digest — Personal/Non-company Proof Points

## FraudShield — Real-time Fraud Detection (Open Source)
**Type:** open-source
**Archetype:** machine_learning
**Hero metrics:** 99.7% precision, 50ms p99, 500+ GitHub stars

## "Why RAG is not enough" (Blog)
**Type:** article
**Archetype:** machine_learning
`;

test('parseArticleDigest: extracts each H2 entry as a project', () => {
  const projects = parseArticleDigest(sample, 'article-digest.md');
  assert.equal(projects.length, 2);
  assert.match(projects[0].text, /FraudShield/);
  assert.equal(projects[0].sourcePath, 'article-digest.md');
  assert.equal(projects[0].archetype, 'machine_learning');
});

test('parseArticleDigest: missing file or empty content returns []', () => {
  assert.deepEqual(parseArticleDigest('', 'article-digest.md'), []);
});
```

Run: `node --test tests/assemble.article.test.mjs`
Expected: FAIL.

- [ ] **Step 2: Implement parseArticleDigest**

Append to `assemble-core.mjs`:

```js
/**
 * Parse article-digest.md into a list of project candidates.
 * Each "## ..." H2 becomes one entry. Captures Hero metrics line as the bullet text.
 */
export function parseArticleDigest(content, sourcePath) {
  if (!content) return [];
  const projects = [];
  const sections = content.split(/^##\s+/m).slice(1);
  let lineCounter = 1;
  for (const sec of sections) {
    const lines = sec.split('\n');
    const titleLine = lines[0].trim();
    const heroLine = lines.find(l => /^\*\*Hero metrics:?\*\*/i.test(l));
    const archetypeLine = lines.find(l => /^\*\*Archetype:?\*\*/i.test(l));
    const heroText = heroLine ? heroLine.replace(/^\*\*Hero metrics:?\*\*\s*/i, '') : '';
    const archetype = archetypeLine ? archetypeLine.replace(/^\*\*Archetype:?\*\*\s*/i, '').trim() : null;
    const text = heroText ? `**${titleLine}** — ${heroText}` : `**${titleLine}**`;
    projects.push({
      text,
      sourcePath,
      sourceLine: lineCounter,
      archetype,
    });
    lineCounter += sec.split('\n').length + 1;
  }
  return projects;
}

/**
 * Convenience: read article-digest.md from the project root if it exists.
 */
export function loadArticleDigest(rootDir) {
  const path = join(rootDir, 'article-digest.md');
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf-8');
  return parseArticleDigest(content, 'article-digest.md');
}
```

Run: `node --test tests/assemble.article.test.mjs`
Expected: 2/2 pass.

- [ ] **Step 3: Wire into assemble-cv.mjs**

In `assemble-cv.mjs`, add to imports:

```js
import { ..., loadArticleDigest } from './assemble-core.mjs';
```

After the company loop builds `allProjects`, before the projects sort, append:

```js
const articleProjects = loadArticleDigest(__dirname);
for (const p of articleProjects) {
  // Filter by archetype: include if matches current archetype OR no archetype declared
  if (!p.archetype || p.archetype === archetype) {
    allProjects.push({
      ...p,
      score: scoreBullet(p.text, keywords),
    });
  }
}
```

- [ ] **Step 4: Verify**

Run: `node --check assemble-cv.mjs && node --test tests/assemble.article.test.mjs`
Expected: clean + tests pass.

- [ ] **Step 5: Commit**

```bash
git add assemble-core.mjs assemble-cv.mjs tests/assemble.article.test.mjs
git commit -m "feat(assemble): parse article-digest.md into Projects pool"
```

---

## Phase F — Fixtures + E2E test

### Task 31: Create synthetic experience_source fixtures

**Files:**
- Create: `__fixtures__/experience_source/acme/backend.md`
- Create: `__fixtures__/experience_source/acme/frontend.md`
- Create: `__fixtures__/experience_source/globex/backend.md`
- Create: `__fixtures__/experience_source/globex/machine_learning.md`
- Create: `__fixtures__/experience_source/initech/infra.md`

- [ ] **Step 1: Create acme/backend.md**

```markdown
---
company: Acme Corp
role: Senior Backend Engineer
location: San Francisco, CA
start: 2023-04
end: 2024-11
facet: backend
---

## Bullets

- Built distributed queue handling 10K rps with Kafka and Postgres
- Migrated monolith to microservices over 6 months, zero customer downtime
- Designed event sourcing layer for order pipeline, p99 latency 30ms
- Led on-call rotation of 8 engineers, halved incident MTTR

## Projects

- **Queue Service** — Kafka-based at-least-once delivery, 99.99% uptime
- **Event Sourcing Layer** — Postgres-backed CDC pipeline

## Skills used

Go, Kafka, Postgres, Kubernetes, gRPC, OpenTelemetry
```

- [ ] **Step 2: Create acme/frontend.md**

```markdown
---
company: Acme Corp
role: Senior Backend Engineer
location: San Francisco, CA
start: 2023-04
end: 2024-11
facet: frontend
---

## Bullets

- Shipped admin dashboard in React + TypeScript serving 200 internal users
- Established design system with 40+ Tailwind-based components

## Projects

- **Admin Dashboard** — React, TypeScript, Tailwind, server actions

## Skills used

React, TypeScript, Tailwind, Next.js, Vite
```

- [ ] **Step 3: Create globex/backend.md**

```markdown
---
company: Globex Inc
role: Software Engineer
location: New York, NY
start: 2020-01
end: 2023-03
facet: backend
---

## Bullets

- Owned billing service rewrite from Ruby to Go, throughput 8x
- Built rate-limiter middleware used across 12 services
- Cut Postgres query p95 from 800ms to 90ms via index audit

## Projects

- **Rate-limiter Middleware** — token bucket, Redis-backed

## Skills used

Go, Ruby, Postgres, Redis, AWS
```

- [ ] **Step 4: Create globex/machine_learning.md**

```markdown
---
company: Globex Inc
role: Software Engineer
location: New York, NY
start: 2020-01
end: 2023-03
facet: machine_learning
---

## Bullets

- Built fraud detection model on 2B transactions, precision 0.94
- Productionized BERT classifier for support ticket routing, 87% accuracy

## Projects

- **Fraud Detection Pipeline** — XGBoost + Kafka, sub-100ms inference

## Skills used

Python, PyTorch, XGBoost, scikit-learn, Spark
```

- [ ] **Step 5: Create initech/infra.md**

```markdown
---
company: Initech
role: DevOps Engineer
location: Boston, MA
start: 2017-06
end: 2019-12
facet: infra
---

## Bullets

- Migrated 80 services from EC2 to EKS over 18 months
- Built Terraform module library used by 4 product teams
- Implemented OIDC-based deploy workflow replacing long-lived AWS keys

## Projects

- **Terraform Module Library** — 24 reusable modules, semantic versioning

## Skills used

Terraform, Kubernetes, AWS, GitHub Actions, Vault
```

- [ ] **Step 6: Commit**

```bash
git add __fixtures__/experience_source/
git commit -m "test: add synthetic experience_source fixtures"
```

---

### Task 32: Create fixture profile.yml and JDs

**Files:**
- Create: `__fixtures__/profile.yml`
- Create: `__fixtures__/jds/backend-jd.md`
- Create: `__fixtures__/jds/ml-jd.md`

- [ ] **Step 1: Create __fixtures__/profile.yml**

```yaml
candidate:
  full_name: Test User
  email: test@example.com
  location: San Francisco, CA
  linkedin: linkedin.com/in/testuser
  portfolio_url: https://testuser.dev

narrative:
  headline: Backend engineer who's worked across infra and ML
  exit_story: Built and shipped systems at three companies over 7 years.

experience_sources:
  root: experience_source
  archetypes:
    frontend: frontend.md
    backend: backend.md
    infra: infra.md
    machine_learning: machine_learning.md
  jd_archetype_sources:
    frontend:         [frontend]
    backend:          [backend]
    infra:            [infra]
    machine_learning: [machine_learning]
    fullstack:        [frontend, backend]
  overrides:
    initech:
      tier_floor: light
      stub: "Built infra at a mid-stage SaaS company."

archetype_defaults:
  frontend:         { top_bullets_full: 4, top_projects: 3 }
  backend:          { top_bullets_full: 4, top_projects: 3 }
  infra:            { top_bullets_full: 4, top_projects: 3 }
  machine_learning: { top_bullets_full: 4, top_projects: 3 }
  fullstack:        { top_bullets_full: 5, top_projects: 4 }

tier_rules:
  light_bullets: 2
```

- [ ] **Step 2: Create __fixtures__/jds/backend-jd.md**

```markdown
# Senior Backend Engineer at SampleCo

We're hiring a Senior Backend Engineer to build distributed systems on Go and Kafka.

Requirements:
- 5+ years building production backend services
- Deep experience with Postgres, Kafka, and Kubernetes
- Strong distributed systems fundamentals
- Experience with event-driven architectures and CDC

Nice to have:
- Go expertise
- gRPC, OpenTelemetry
- On-call experience
```

- [ ] **Step 3: Create __fixtures__/jds/ml-jd.md**

```markdown
# Machine Learning Engineer at SampleAI

We're hiring an ML Engineer to build fraud detection and ranking systems.

Requirements:
- Production ML experience: PyTorch or XGBoost
- Experience with Spark or large-scale data processing
- Familiarity with BERT-class language models
- Building production inference pipelines
```

- [ ] **Step 4: Commit**

```bash
git add __fixtures__/profile.yml __fixtures__/jds/
git commit -m "test: add fixture profile.yml and two sample JDs"
```

---

### Task 33: E2E test for assemble (mock LLM)

**Files:**
- Create: `tests/e2e.assemble.test.mjs`

- [ ] **Step 1: Create test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
} from '../assemble-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../__fixtures__');

// Mock LLM client: returns first N from pool, no rephrasing
function mockClient(archetypeAnswer) {
  return {
    messages: {
      create: async ({ messages }) => {
        const userText = messages[0].content;
        if (/Classify this JD/.test(userText)) {
          return { content: [{ text: archetypeAnswer }] };
        }
        if (/Pick the (\d+) bullets/.test(userText)) {
          const n = Number(userText.match(/Pick the (\d+) bullets/)[1]);
          const bulletsBlock = userText.split('BULLETS:')[1].trim();
          const lines = bulletsBlock.split('\n').filter(l => /^\d+:/.test(l));
          const selected = lines.slice(0, n).map(l => {
            const [idxStr, ...rest] = l.split(':');
            return { index: Number(idxStr), text: rest.join(':').trim() };
          });
          return { content: [{ text: JSON.stringify({ selected }) }] };
        }
        if (/Professional Summary/.test(userText)) {
          return { content: [{ text: 'Mock summary for testing.' }] };
        }
        throw new Error('mockClient: unrecognized prompt');
      },
    },
  };
}

test('e2e: backend JD pulls bullets from acme + globex backend, initech as light', async () => {
  // Inline a runner instead of shelling out to assemble-cv.mjs
  // (keeps the test free of fs side effects in repo root)

  const config = loadConfig(resolve(FIXTURES, 'profile.yml'));
  const jdText = readFileSync(resolve(FIXTURES, 'jds/backend-jd.md'), 'utf-8');
  const sourcesRoot = resolve(FIXTURES, 'experience_source');
  const sources = loadAllSources(sourcesRoot);
  validateConsistency(sources);

  const archetype = 'backend';
  const facets = config.experience_sources.jd_archetype_sources[archetype];

  let keywords = extractKeywords(jdText);
  keywords = expandSynonyms(keywords, resolve(__dirname, '../config/synonyms.yml'));

  const sortedDirs = await sortCompanies(sourcesRoot, Object.keys(sources));
  // Expect: acme (start 2023) → globex (2020) → initech (2017)
  assert.deepEqual(sortedDirs, ['acme', 'globex', 'initech']);

  const client = mockClient('backend');
  const { pickBullets } = await import('../assemble-llm.mjs');

  const companies = [];
  for (const dir of sortedDirs) {
    const facetFiles = sources[dir].filter(f => facets.includes(f.frontmatter.facet));
    const pool = [];
    for (const f of facetFiles) {
      for (const b of f.bullets) {
        if (scoreBullet(b.text, keywords) >= 1) {
          pool.push({ text: b.text, sourcePath: f._sourcePath, sourceLine: b.lineNumber });
        }
      }
    }
    const floor = config.experience_sources.overrides?.[dir]?.tier_floor || null;
    const tier = assignTier(pool.length, floor);
    const fmRef = sources[dir][0].frontmatter;
    const co = { dir, frontmatter: fmRef, tier };
    if (tier === 'stub') {
      co.stub = config.experience_sources.overrides?.[dir]?.stub || `Worked at ${fmRef.company}.`;
    } else {
      const n = tier === 'full' ? 4 : 2;
      co.bullets = await pickBullets(pool.slice(0, n + 2), jdText, Math.min(n, pool.length), client);
    }
    companies.push(co);
  }

  // Acme should be full tier (multiple keyword-matching bullets)
  assert.equal(companies[0].dir, 'acme');
  assert.equal(companies[0].tier, 'full');
  assert.ok(companies[0].bullets.length >= 2);

  // Globex backend should also have hits
  assert.equal(companies[1].dir, 'globex');
  assert.notEqual(companies[1].tier, 'stub');

  // Initech (only infra facet for this archetype, but no infra is in jd_archetype_sources[backend])
  // → no facet file matches → empty pool → would be stub, but tier_floor=light → light
  assert.equal(companies[2].dir, 'initech');
  assert.equal(companies[2].tier, 'light');
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/e2e.assemble.test.mjs`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.assemble.test.mjs
git commit -m "test(e2e): assembly happy-path with mock LLM client"
```

---

## Phase G — Mode markdown rewrites

### Task 34: Rewrite modes/pdf.md

**Files:**
- Modify: `modes/pdf.md`

- [ ] **Step 1: Replace the "Pipeline completo" section**

Open `modes/pdf.md`. Replace the section starting `## Pipeline completo` through step 15 (Reporta) with this English-only block:

```markdown
## Pipeline (this fork)

1. If JD not provided in plain text, extract via MCP-Playwright (Paso 0 of auto-pipeline).
2. Save JD to `jds/{company-slug}.md`.
3. Run: `node assemble-cv.mjs --jd=jds/{company-slug}.md`
4. Run: `node validate-cv.mjs cv.tailored.md`
   - On failure: read `.cv-tailored-errors.json`, re-invoke `assemble-cv.mjs --jd=... --feedback=.cv-tailored-errors.json` (≤3 retries). If all 3 fail, abort with error.
5. Read `cv.tailored.md` and fill placeholders in `templates/cv-template.html`.
6. Detect paper format from JD location: US/Canada → letter, else a4.
7. Read `name` from `config/profile.yml` → kebab-case → `{candidate}`.
8. Write HTML to `/tmp/cv-{candidate}-{company}.html`.
9. Run: `node generate-pdf.mjs /tmp/cv-{candidate}-{company}.html output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}`
10. Archive: copy `cv.tailored.md` → `output/cv-tailored-{company}-{YYYY-MM-DD}.md`
11. Report: PDF path, page count, archetype detected, tier breakdown per company (from `.cv-tailored-meta.json`).
```

- [ ] **Step 2: Verify the file still has its other sections (ATS rules, design, fonts, etc.)**

Run: `head -80 modes/pdf.md`
Expected: still see "## Reglas ATS" or equivalent design rules below.

- [ ] **Step 3: Commit**

```bash
git add modes/pdf.md
git commit -m "feat(modes): rewrite pdf.md to call assemble + validate"
```

---

### Task 35: Rewrite modes/latex.md

**Files:**
- Modify: `modes/latex.md`

- [ ] **Step 1: Replace the pipeline steps**

Find the section that describes how the LLM produces the .tex file. Replace it with:

```markdown
## Pipeline (this fork)

1. If JD not provided, follow Paso 0 of auto-pipeline.
2. Save JD to `jds/{slug}.md`.
3. Run: `node assemble-cv.mjs --jd=jds/{slug}.md`
4. Run: `node validate-cv.mjs cv.tailored.md` (≤3 retries with --feedback).
5. Read `cv.tailored.md` and fill `templates/cv-template.tex` placeholders.
6. Write to `/tmp/cv-{candidate}-{company}.tex`.
7. Run: `node generate-latex.mjs /tmp/cv-{candidate}-{company}.tex output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf`
8. Archive `cv.tailored.md` to `output/`.
```

- [ ] **Step 2: Commit**

```bash
git add modes/latex.md
git commit -m "feat(modes): rewrite latex.md to call assemble + validate"
```

---

### Task 36: Update modes/auto-pipeline.md

**Files:**
- Modify: `modes/auto-pipeline.md`

- [ ] **Step 1: Insert Paso 0.5 and 0.6 between existing Paso 0 and Paso 1**

Locate the line ending Paso 0 and starting Paso 1. Insert before Paso 1:

```markdown
## Paso 0.5 — Assemble Tailored CV

Run: `node assemble-cv.mjs --jd=jds/{slug}.md`

This produces `cv.tailored.md` and `.cv-tailored-meta.json`. Every subsequent
mode that needs the candidate's CV will read `cv.tailored.md` (NOT `cv.md` —
this fork removed that file).

## Paso 0.6 — Validate

Run: `node validate-cv.mjs cv.tailored.md`

If validation fails: read `.cv-tailored-errors.json`, re-run assemble with
`--feedback=.cv-tailored-errors.json` (max 3 retries). If still failing,
abort the pipeline with the error JSON for manual inspection.
```

- [ ] **Step 2: Update Paso 1 wording**

Find Paso 1 and ensure it reads:

```markdown
## Paso 1 — Evaluación A-G

Ejecutar exactamente igual que el modo `oferta` (leer `modes/oferta.md` para todos los bloques A-F + Block G Posting Legitimacy). **El modo oferta lee `cv.tailored.md`** (no `cv.md`).
```

- [ ] **Step 3: Update Paso 3**

Find Paso 3 (PDF). Make sure it just says:

```markdown
## Paso 3 — Generar PDF

Ejecutar el pipeline de `pdf` (leer `modes/pdf.md`). Si `config/profile.yml`
tiene `prefer_latex: true`, ejecutar también `modes/latex.md`.
```

- [ ] **Step 4: Add Paso 6 at end**

After Paso 5, add:

```markdown
## Paso 6 — Archive

Move `cv.tailored.md` → `output/cv-tailored-{company-slug}-{YYYY-MM-DD}.md`
so each application has its own archived view.
```

- [ ] **Step 5: Commit**

```bash
git add modes/auto-pipeline.md
git commit -m "feat(modes): insert Paso 0.5/0.6 + archive in auto-pipeline"
```

---

### Task 37: Update modes/oferta.md to read cv.tailored.md

**Files:**
- Modify: `modes/oferta.md`

- [ ] **Step 1: Replace cv.md references**

Run: `grep -n 'cv\.md' modes/oferta.md`
For each occurrence, replace `cv.md` with `cv.tailored.md`.

- [ ] **Step 2: Add precondition note at top**

Add after the front-matter heading:

```markdown
> **Precondition (this fork):** This mode requires `cv.tailored.md` to exist.
> Run `node assemble-cv.mjs --jd=<jd-path>` first. The auto-pipeline mode does
> this automatically at Paso 0.5.
```

- [ ] **Step 3: Add tier breakdown to Block B instructions**

Find the section describing Block B (CV Match). Add this paragraph at the end:

```markdown
**Tier breakdown:** Read `.cv-tailored-meta.json` and include in Block B a
table or bullet list showing each company's tier (full / light / stub) and
candidate pool size. This makes the score's basis transparent.
```

- [ ] **Step 4: Commit**

```bash
git add modes/oferta.md
git commit -m "feat(modes): oferta reads cv.tailored.md + tier breakdown in Block B"
```

---

### Task 38: Update modes/contacto.md and deep.md to require JD

**Files:**
- Modify: `modes/contacto.md`
- Modify: `modes/deep.md`

- [ ] **Step 1: Add precondition to contacto.md (top)**

```markdown
> **Precondition (this fork):** Requires a JD or target role URL in context.
> If absent, abort with: "I need a JD or target role URL before drafting outreach."
```

Replace any `cv.md` references with `cv.tailored.md`.

- [ ] **Step 2: Add precondition to deep.md (top)**

```markdown
> **Precondition (this fork):** Requires a JD or target role URL in context.
> If absent, abort with: "I need a JD or target role URL before deep research."
```

Replace `cv.md` → `cv.tailored.md`.

- [ ] **Step 3: Commit**

```bash
git add modes/contacto.md modes/deep.md
git commit -m "feat(modes): contacto/deep require JD; read cv.tailored.md"
```

---

### Task 39: Update modes/apply.md

**Files:**
- Modify: `modes/apply.md`

- [ ] **Step 1: Replace cv.md references**

Run: `grep -n 'cv\.md' modes/apply.md`
Replace each with `cv.tailored.md`.

- [ ] **Step 2: Commit**

```bash
git add modes/apply.md
git commit -m "feat(modes): apply reads cv.tailored.md"
```

---

## Phase H — test-all integration + final wiring

### Task 40: Add unit-tests section to test-all.mjs

**Files:**
- Modify: `test-all.mjs`

- [ ] **Step 1: Add new section after section 3 (Liveness)**

After the closing brace of the Liveness `try/catch` block (around line 119), insert:

```js
// ── 3.5 UNIT TESTS (assemble + validate) ────────────────────────

console.log('\n3.5. Unit + E2E tests (assemble + validate)');

const testResult = run('node', ['--test', 'tests/']);
if (testResult !== null && !testResult.includes('fail')) {
  pass('All assemble/validate tests pass');
} else if (testResult === null) {
  fail('Test runner crashed');
} else {
  // Count failures
  const failMatch = testResult.match(/# fail (\d+)/);
  const passMatch = testResult.match(/# pass (\d+)/);
  if (failMatch && Number(failMatch[1]) > 0) {
    fail(`${failMatch[1]} test(s) failed (passed: ${passMatch?.[1] || '?'})`);
  } else {
    pass(`Tests OK (passed: ${passMatch?.[1] || '?'})`);
  }
}
```

- [ ] **Step 2: Update systemFiles list (section 5) to include new files**

In `test-all.mjs` around line 140, add to the `systemFiles` array:

```js
  'assemble-cv.mjs', 'assemble-core.mjs', 'assemble-llm.mjs',
  'validate-cv.mjs', 'validate-core.mjs',
  'config/synonyms.yml',
```

- [ ] **Step 3: Update expectedModes list (section 8) to keep matching reality**

No new modes added; existing list stays the same. Verify list still matches.

- [ ] **Step 4: Run full test-all**

Run: `node test-all.mjs --quick`
Expected: all checks pass (or only warnings).

- [ ] **Step 5: Commit**

```bash
git add test-all.mjs
git commit -m "test: integrate node --test into test-all.mjs"
```

---

### Task 41: Update CLAUDE.md to document the new pipeline

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the "Main Files" table**

In `CLAUDE.md`, locate the `### Main Files` table. Remove the row for `cv.md`. Add new rows:

```
| `experience_source/{company}/{facet}.md` | Per-company × per-facet experience source |
| `assemble-cv.mjs` | Tailored CV assembler (run before any JD-driven mode) |
| `validate-cv.mjs` | Structural validator gate |
| `cv.tailored.md` | Per-JD assembly output (gitignored, regenerated each run) |
| `.cv-tailored-meta.json` | Debug sidecar (pools, tiers, archetype decisions) |
```

- [ ] **Step 2: Find the "CV Source of Truth" section**

Replace the bullet `- cv.md in project root is the canonical CV` with:

```
- `experience_source/{company}/{facet}.md` is the canonical source. cv.md does NOT exist in this fork.
- `cv.tailored.md` is generated per-JD by `assemble-cv.mjs`. Modes with JD context read it.
- `article-digest.md` holds non-company proof points (open-source, articles, talks).
- **NEVER hardcode metrics** — read them from these files at evaluation time.
```

- [ ] **Step 3: Add a new section after "First Run — Onboarding"**

```markdown
### Assembly First Rule (this fork)

Before invoking any mode that needs a CV (`oferta`, `pdf`, `latex`, `apply`,
`contacto`, `deep`), the auto-pipeline runs:

  Paso 0.5: node assemble-cv.mjs --jd=jds/{slug}.md
  Paso 0.6: node validate-cv.mjs cv.tailored.md  (with up to 3 retries)

These produce `cv.tailored.md` which all downstream modes consume. If you
invoke a CV-needing mode manually without going through auto-pipeline, you
MUST run those two commands yourself first or the mode will read a stale or
missing `cv.tailored.md`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for assembly-first pipeline"
```

---

### Task 42: Final smoke check + summary commit

**Files:**
- (verification only)

- [ ] **Step 1: Run full test suite**

Run: `node test-all.mjs --quick`
Expected: all green (no failures, warnings allowed).

- [ ] **Step 2: Verify all new files committed**

Run: `git status`
Expected: `working tree clean`.

- [ ] **Step 3: Verify package.json scripts work**

Run: `npm run validate-cv -- --help 2>&1 | head -3`
Expected: usage line printed.

Run: `npm test 2>&1 | tail -5`
Expected: pass count printed, no failures.

- [ ] **Step 4: Tag the milestone**

```bash
git tag -a fork-v0.1.0 -m "Experience-source assembly fork: initial implementation"
```

(Optional — only if user wants to push tag later.)

- [ ] **Step 5: Update CHANGELOG.md** (if it exists)

Add a section at top:

```markdown
## fork-v0.1.0 — 2026-04-21

- BREAKING: removed `cv.md` and `cv-sync-check.mjs`
- Added `experience_source/{company}/{facet}.md` model
- Added `assemble-cv.mjs` (deterministic candidate pool + LLM picks + validator gate)
- Added `validate-cv.mjs` (CompanyCoverage + BulletProvenance + ChronologicalOrder)
- All JD-driven modes now read `cv.tailored.md`
- New deps: `@anthropic-ai/sdk`
```

- [ ] **Step 6: Commit changelog**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for fork-v0.1.0"
```

---

## Implementation Notes

- **TDD discipline**: every task in Phase B and C follows test-first. Don't skip the "verify failure" step — it confirms the test actually exercises the missing code.
- **No half-implementations**: each task ends with a green test and a commit. If you can't make the test pass, leave the task in_progress and surface the blocker — don't move on.
- **LLM costs**: Tasks 33 (E2E) and unit tests use mock client → free. Only Tasks 30+ run real LLM if you smoke-test. Default model is Haiku — assembly costs ~$0.005 per JD.
- **Migration**: this plan does NOT include moving the user's existing `cv.md` content into `experience_source/`. That's a one-time manual user action. Do it after this plan completes by reading the user's `cv.md` (if any backup exists) and splitting bullets into the appropriate facet files.
- **Order matters**: Phase B (validate) BEFORE Phase C (assemble) because assemble's E2E test imports from validate? No — actually assemble doesn't import from validate. The order chosen here is: contract → utility (validate) → main (assemble) → integration → modes. This keeps each phase self-testable.

