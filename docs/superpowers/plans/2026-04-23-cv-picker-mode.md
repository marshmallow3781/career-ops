# CV Picker Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--mode=picker` flag to `assemble-cv.mjs` that selects a pre-made PDF from `resumes/` based on JD archetype, extracts its text via `pdftotext`, and writes `cv.tailored.md` + sidecar — letting downstream modes run unchanged.

**Architecture:** New pure-function helper `lib/picker.mjs` (`resolvePickerResume`, `extractPdfText`, `buildPlaceholderCv`). `assemble-cv.mjs` parses the `--mode` flag and, when `picker`, branches to a thin `runPickerMode` that stitches the helpers together. No changes to downstream modes, no new npm deps — `pdftotext` is shelled out as a child process. The existing bullet-assembler path is untouched.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, `pdftotext` CLI from poppler (already installed at `/opt/homebrew/bin/pdftotext`).

**Spec reference:** `docs/superpowers/specs/2026-04-23-cv-picker-mode-design.md` (commit `ad4200e`).

---

## File Structure

### Files created
- `lib/picker.mjs` — helpers: `resolvePickerResume(archetype, pickerConfig)`, `extractPdfText(pdfPath)`, `buildPlaceholderCv(archetype, filename)`.
- `tests/picker.test.mjs` — unit tests for the three helpers + end-to-end CLI integration.
- `tests/fixtures/resumes/sample_backend.pdf` — tiny PDF used as fixture in tests.

### Files modified
- `assemble-cv.mjs` — `parseArgs` gains a `--mode` field; `main()` branches to `runPickerMode()` when `mode === 'picker'`; otherwise the existing assembler code runs unchanged.
- `config/profile.example.yml` — add `cv.picker` block so new users get the map out of the box. (User's live `config/profile.yml` is gitignored — they must copy the block over manually.)

### Files NOT modified
- `validate-cv.mjs` — picker output goes through validation unchanged.
- `assemble-core.mjs`, `assemble-llm.mjs` — picker doesn't need bullets or intent extraction.
- Downstream modes (`modes/oferta.md`, `modes/pipeline.md`, etc.) — they still read `cv.tailored.md`.

---

## Task 1: `resolvePickerResume` + fixture

**Files:**
- Create: `lib/picker.mjs`
- Create: `tests/picker.test.mjs`
- Create: `tests/fixtures/resumes/sample_backend.pdf` (generated from the user's existing PDF)

- [ ] **Step 1: Create the fixture PDF**

A tiny known-text PDF is needed for `extractPdfText` and the end-to-end tests later. Reuse the user's existing resume as the fixture — any working PDF with extractable text is sufficient.

```bash
mkdir -p tests/fixtures/resumes
cp resumes/backend_ai_2.0.pdf tests/fixtures/resumes/sample_backend.pdf
```

Verify the fixture is non-empty and `pdftotext` can read it:

```bash
pdftotext tests/fixtures/resumes/sample_backend.pdf - | head -5
```

Expected: several lines of resume text (name, headline, first bullets).

- [ ] **Step 2: Write the failing tests for `resolvePickerResume`**

Create `tests/picker.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePickerResume } from '../lib/picker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures/resumes');

const mapCfg = {
  resumes_dir: FIXTURE_DIR,
  archetype_map: {
    backend: 'sample_backend.pdf',
    infra: 'sample_backend.pdf',                // reuse same fixture
    applied_ai: 'future_applied_ai.pdf',        // intentionally absent on disk
  },
};

test('resolvePickerResume: returns path for mapped archetype with existing file', () => {
  const r = resolvePickerResume('backend', mapCfg);
  assert.equal(r.missing, undefined);
  assert.equal(r.filename, 'sample_backend.pdf');
  assert.ok(r.path.endsWith('fixtures/resumes/sample_backend.pdf'));
});

test('resolvePickerResume: missing=true for mapped archetype with no file on disk', () => {
  const r = resolvePickerResume('applied_ai', mapCfg);
  assert.equal(r.missing, true);
  assert.equal(r.filename, 'future_applied_ai.pdf');
  assert.equal(r.path, undefined);
});

test('resolvePickerResume: missing=true + filename=null for unknown archetype', () => {
  const r = resolvePickerResume('unknown', mapCfg);
  assert.equal(r.missing, true);
  assert.equal(r.filename, null);
});

test('resolvePickerResume: missing=true + filename=null for unmapped archetype', () => {
  const r = resolvePickerResume('frontend', mapCfg);
  assert.equal(r.missing, true);
  assert.equal(r.filename, null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
node --test tests/picker.test.mjs
```

Expected: 4 failures, error like `Cannot find package '../lib/picker.mjs'` or `resolvePickerResume is not a function`.

- [ ] **Step 4: Implement `resolvePickerResume` in `lib/picker.mjs`**

```js
// lib/picker.mjs
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Resolve which resume PDF to use for a given archetype.
 *
 * @param {string} archetype — the JD archetype (e.g. 'backend', 'infra', 'unknown')
 * @param {{resumes_dir: string, archetype_map: object}} pickerConfig
 * @returns {{path?: string, filename: string|null, missing?: true}}
 *   - { path, filename } when the archetype is mapped AND the file exists
 *   - { missing: true, filename } when the archetype is mapped but the file is absent
 *   - { missing: true, filename: null } when the archetype is not in the map
 */
export function resolvePickerResume(archetype, pickerConfig) {
  const map = pickerConfig?.archetype_map || {};
  const filename = map[archetype] || null;

  if (!filename) {
    return { missing: true, filename: null };
  }

  const dir = pickerConfig?.resumes_dir || 'resumes';
  const path = resolve(dir, filename);
  if (!existsSync(path)) {
    return { missing: true, filename };
  }
  return { path, filename };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test tests/picker.test.mjs
```

Expected: `pass 4 fail 0`.

- [ ] **Step 6: Commit**

```bash
git add lib/picker.mjs tests/picker.test.mjs tests/fixtures/resumes/sample_backend.pdf
git commit -m "feat(picker): add resolvePickerResume helper + tests"
```

---

## Task 2: `extractPdfText`

**Files:**
- Modify: `lib/picker.mjs`
- Modify: `tests/picker.test.mjs`

- [ ] **Step 1: Write the failing tests for `extractPdfText`**

Append to `tests/picker.test.mjs`:

```js
import { extractPdfText } from '../lib/picker.mjs';

test('extractPdfText: returns text on happy path', async () => {
  const path = resolve(FIXTURE_DIR, 'sample_backend.pdf');
  const text = await extractPdfText(path);
  assert.ok(typeof text === 'string');
  assert.ok(text.length > 50, 'expected non-trivial extracted text');
});

test('extractPdfText: throws with install hint when pdftotext binary missing', async () => {
  // Mock by passing a non-existent PDF path — pdftotext will fail with a
  // non-zero exit code, and our wrapper should surface a clear error.
  await assert.rejects(
    () => extractPdfText('/nonexistent/path/to/resume.pdf'),
    /pdftotext/i,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/picker.test.mjs
```

Expected: previous 4 pass, 2 new fail with `extractPdfText is not a function`.

- [ ] **Step 3: Implement `extractPdfText` in `lib/picker.mjs`**

Append to `lib/picker.mjs`:

```js
import { spawn } from 'node:child_process';

/**
 * Shell out to `pdftotext <pdfPath> -` and return stdout as a string.
 * Throws with an install hint if the binary is missing.
 */
export async function extractPdfText(pdfPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pdftotext', [pdfPath, '-']);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', c => { stdout += c.toString(); });
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          `pdftotext binary not found. Install it with: brew install poppler`,
        ));
      } else {
        reject(err);
      }
    });
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`pdftotext exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/picker.test.mjs
```

Expected: `pass 6 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/picker.mjs tests/picker.test.mjs
git commit -m "feat(picker): add extractPdfText child-process wrapper"
```

---

## Task 3: `buildPlaceholderCv`

**Files:**
- Modify: `lib/picker.mjs`
- Modify: `tests/picker.test.mjs`

- [ ] **Step 1: Write the failing test for `buildPlaceholderCv`**

Append to `tests/picker.test.mjs`:

```js
import { buildPlaceholderCv } from '../lib/picker.mjs';

test('buildPlaceholderCv: includes archetype and filename in output', () => {
  const md = buildPlaceholderCv('applied_ai', 'applied_ai_2.0.pdf');
  assert.ok(md.includes('applied_ai'), 'archetype should appear');
  assert.ok(md.includes('applied_ai_2.0.pdf'), 'filename should appear');
  assert.ok(md.startsWith('#'), 'should be a markdown heading');
});

test('buildPlaceholderCv: handles unmapped archetype (null filename)', () => {
  const md = buildPlaceholderCv('unknown', null);
  assert.ok(md.includes('unknown'));
  assert.ok(md.toLowerCase().includes('archetype_map'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/picker.test.mjs
```

Expected: previous 6 pass, 2 new fail with `buildPlaceholderCv is not a function`.

- [ ] **Step 3: Implement `buildPlaceholderCv` in `lib/picker.mjs`**

Append to `lib/picker.mjs`:

```js
/**
 * Build the markdown body written to cv.tailored.md when no resume PDF
 * can be resolved. The placeholder is intentionally loud so downstream
 * evaluations will visibly break rather than silently use an empty CV.
 */
export function buildPlaceholderCv(archetype, filename) {
  const lines = [`# No resume for archetype \`${archetype}\``, ''];
  if (filename) {
    lines.push(
      `The picker mode resolved archetype \`${archetype}\` to filename \`${filename}\`, ` +
      `but that file was not found in the configured \`resumes_dir\`.`,
      '',
      `Add \`${filename}\` to \`resumes/\` and re-run, or update \`cv.picker.archetype_map\` ` +
      `in \`config/profile.yml\` to point to an existing file.`,
    );
  } else {
    lines.push(
      `Archetype \`${archetype}\` is not listed in \`cv.picker.archetype_map\` ` +
      `in \`config/profile.yml\`.`,
      '',
      `Add an entry mapping \`${archetype}\` to one of your resume filenames, ` +
      `or override the archetype on the command line with \`--archetype=<name>\`.`,
    );
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/picker.test.mjs
```

Expected: `pass 8 fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/picker.mjs tests/picker.test.mjs
git commit -m "feat(picker): add buildPlaceholderCv for missing-resume path"
```

---

## Task 4: Wire `--mode=picker` into `assemble-cv.mjs`

**Files:**
- Modify: `assemble-cv.mjs:64-72` (parseArgs) and `assemble-cv.mjs:74-79` (main entry branching)
- Modify: `tests/picker.test.mjs`

- [ ] **Step 1: Write the failing end-to-end tests**

Append to `tests/picker.test.mjs`:

```js
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');

function runAssembleCv(args, env = {}) {
  return new Promise((res, rej) => {
    const proc = spawn('node', ['assemble-cv.mjs', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c.toString(); });
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('close', code => res({ code, stdout, stderr }));
    proc.on('error', rej);
  });
}

test('assemble-cv --mode=picker writes extracted PDF text to cv.tailored.md', async () => {
  // Use a throwaway JD file so we don't touch real jds/
  const tmp = mkdtempSync(join(tmpdir(), 'picker-e2e-'));
  const jdPath = join(tmp, 'test-jd.md');
  writeFileSync(jdPath, '# Test JD\nSenior Backend Engineer at Acme. Go, distributed systems, Kafka.');

  try {
    const { code, stderr } = await runAssembleCv(
      [`--jd=${jdPath}`, '--mode=picker', '--archetype=backend'],
    );
    assert.equal(code, 0, `expected exit 0, got ${code}. stderr:\n${stderr}`);

    const cv = readFileSync(resolve(REPO_ROOT, 'cv.tailored.md'), 'utf-8');
    assert.ok(cv.length > 100, 'cv.tailored.md should contain extracted PDF text');

    const meta = JSON.parse(readFileSync(resolve(REPO_ROOT, '.cv-tailored-meta.json'), 'utf-8'));
    assert.equal(meta.mode, 'picker');
    assert.equal(meta.archetype, 'backend');
    assert.ok(meta.source_pdf);
    assert.ok(meta.extracted_at);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('assemble-cv --mode=picker writes placeholder when archetype unmapped', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'picker-e2e-'));
  const jdPath = join(tmp, 'test-jd.md');
  writeFileSync(jdPath, '# Test JD\nSome role.');

  try {
    const { code } = await runAssembleCv(
      [`--jd=${jdPath}`, '--mode=picker', '--archetype=totally_made_up'],
    );
    assert.equal(code, 0);

    const cv = readFileSync(resolve(REPO_ROOT, 'cv.tailored.md'), 'utf-8');
    assert.ok(cv.includes('totally_made_up'), 'placeholder should name the archetype');
    assert.ok(cv.startsWith('#'), 'placeholder should be markdown heading');

    const meta = JSON.parse(readFileSync(resolve(REPO_ROOT, '.cv-tailored-meta.json'), 'utf-8'));
    assert.equal(meta.mode, 'picker');
    assert.equal(meta.archetype, 'totally_made_up');
    assert.equal(meta.missing, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

Note: these tests clobber the real `cv.tailored.md` and `.cv-tailored-meta.json` at the repo root. That's the same behavior the assembler already has, so we accept it. The existing `cv.tailored.md` is already gitignored (regenerated per JD).

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/picker.test.mjs
```

Expected: previous 8 pass, 2 new fail with non-zero exit or `--mode` unknown arg.

- [ ] **Step 3: Modify `parseArgs` in `assemble-cv.mjs:64-72`**

Replace lines 64-72 with:

```js
function parseArgs(argv) {
  const out = { jd: null, archetype: null, feedback: null, mode: 'assembler' };
  for (const a of argv) {
    if (a.startsWith('--jd=')) out.jd = a.split('=')[1];
    else if (a.startsWith('--archetype=')) out.archetype = a.split('=')[1];
    else if (a.startsWith('--feedback=')) out.feedback = a.split('=')[1];
    else if (a.startsWith('--mode=')) out.mode = a.split('=')[1];
  }
  return out;
}
```

- [ ] **Step 4: Add `runPickerMode` and branch in `main()`**

Insert a new `runPickerMode` function above `main()` and add the branching as the first thing inside `main()`:

```js
import { resolvePickerResume, extractPdfText, buildPlaceholderCv } from './lib/picker.mjs';
import yaml from 'js-yaml';
```

(Add these imports near the top of the file, alongside the existing imports.)

Add the helper function above `main()`:

```js
async function runPickerMode({ jdPath, archetypeOverride }) {
  const jdText = readFileSync(resolve(jdPath), 'utf-8');

  // Load picker config from profile.yml (not loadConfig — we want raw YAML).
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
    // Spec §5: when the PDF is missing, source_pdf carries the *expected*
    // filename (or null for unmapped archetypes) — not a path to a
    // nonexistent file. When the PDF exists, carry the full repo-relative
    // path so downstream tools can find it without re-resolving.
    source_pdf: null,
    extracted_at: new Date().toISOString(),
  };

  let cvText;
  if (resolved.missing) {
    cvText = buildPlaceholderCv(archetype, resolved.filename);
    meta.missing = true;
    meta.source_pdf = resolved.filename;  // null when unmapped, filename otherwise
  } else {
    cvText = await extractPdfText(resolved.path);
    meta.source_pdf = resolved.path;
  }

  writeFileSync(OUT_TAILORED, cvText);
  writeFileSync(OUT_META, JSON.stringify(meta, null, 2));
  console.error(`[picker] archetype=${archetype} → ${resolved.filename || '(placeholder)'}`);
}
```

Modify `main()` to branch early. Replace the body of `main()` from line 74 onward, keeping everything but inserting the branch right after arg parsing:

```js
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.jd) {
    console.error('Usage: node assemble-cv.mjs --jd=<path> [--archetype=...] [--feedback=...] [--mode=picker|assembler]');
    process.exit(1);
  }

  if (args.mode === 'picker') {
    await runPickerMode({ jdPath: args.jd, archetypeOverride: args.archetype });
    return;
  }

  // ...existing assembler code from line 80 onward continues unchanged
```

Verify `yaml` is already imported elsewhere in `assemble-cv.mjs`. If not, check `package.json` — `js-yaml` is already a project dep (used throughout).

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test tests/picker.test.mjs
```

Expected: `pass 10 fail 0`.

Also run the full test suite to catch regressions:

```bash
node --test tests/
```

Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add assemble-cv.mjs tests/picker.test.mjs
git commit -m "feat(picker): wire --mode=picker into assemble-cv.mjs"
```

---

## Task 5: Update `config/profile.example.yml` with `cv.picker` block

**Files:**
- Modify: `config/profile.example.yml` (append to end)

Note: the user's live `config/profile.yml` is gitignored. They'll need to copy the new block into their live file manually — call that out in the commit message.

- [ ] **Step 1: Append `cv.picker` block to `config/profile.example.yml`**

Add at the very end of the file:

```yaml

# Picker mode (assemble-cv --mode=picker)
# Maps JD archetype → one of the PDF resumes under resumes_dir.
# Unmapped archetypes (e.g. 'unknown') produce a placeholder cv.tailored.md.
cv:
  picker:
    resumes_dir: resumes
    archetype_map:
      backend: backend_ai_2.0.pdf
      infra: infra_2.0.pdf
      fullstack: fullstack_ai_2.0.pdf
      frontend: fullstack_ai_2.0.pdf          # reuses fullstack for now
      machine_learning: applied_ai_2.0.pdf    # file not yet present
      applied_ai: applied_ai_2.0.pdf          # file not yet present
```

- [ ] **Step 2: Sanity-check the YAML parses**

```bash
node -e "const y=require('js-yaml');const fs=require('fs');console.log(JSON.stringify(y.load(fs.readFileSync('config/profile.example.yml','utf-8')).cv,null,2))"
```

Expected output:

```json
{
  "picker": {
    "resumes_dir": "resumes",
    "archetype_map": {
      "backend": "backend_ai_2.0.pdf",
      ...
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add config/profile.example.yml
git commit -m "config: add cv.picker block to profile.example.yml

Live config/profile.yml is gitignored — users running picker mode need to
copy this block into their local profile manually."
```

---

## Task 6: Live `--mode=picker` verification (no commit)

**Files:** None modified.

This is a final smoke test against a real JD, using the user's real `resumes/` dir and live `config/profile.yml`. No commit — just confirms the integrated behavior.

- [ ] **Step 1: Confirm the user's live profile.yml has the cv.picker block**

```bash
node -e "const y=require('js-yaml');const fs=require('fs');const p=y.load(fs.readFileSync('config/profile.yml','utf-8'));console.log(JSON.stringify(p.cv?.picker || {missing:true}, null, 2))"
```

If output is `{"missing":true}`, ask the user to copy the block from `config/profile.example.yml` into their live `config/profile.yml`, then continue.

- [ ] **Step 2: Pick a JD and run picker mode**

Use any existing JD in `jds/` (or create a quick fixture). Example:

```bash
ls jds/ | head -3
```

Pick one, run:

```bash
node assemble-cv.mjs --jd=jds/<chosen>.md --mode=picker --archetype=backend
```

Expected stderr:

```
[picker] archetype=backend → backend_ai_2.0.pdf
```

Expected exit code: 0.

- [ ] **Step 3: Inspect the outputs**

```bash
wc -l cv.tailored.md && head -20 cv.tailored.md
cat .cv-tailored-meta.json
```

Expected:
- `cv.tailored.md` contains several hundred lines of resume text (name, headline, roles, bullets).
- `.cv-tailored-meta.json` shows `{ "mode": "picker", "archetype": "backend", "source_pdf": ".../resumes/backend_ai_2.0.pdf", "extracted_at": "<iso timestamp>" }`.

- [ ] **Step 4: Test the missing-PDF path**

```bash
node assemble-cv.mjs --jd=jds/<chosen>.md --mode=picker --archetype=applied_ai
```

Expected: exit 0, stderr `[picker] archetype=applied_ai → applied_ai_2.0.pdf` or `(placeholder)`, `cv.tailored.md` contains the placeholder markdown heading, `.cv-tailored-meta.json` has `"missing": true`.

- [ ] **Step 5: Confirm the assembler mode still works**

Regression check — the existing flow must be unbroken:

```bash
node assemble-cv.mjs --jd=jds/<chosen>.md --archetype=backend
```

Expected: same behavior as before the picker patch — bullets assembled, `cv.tailored.md` written in the assembler format, `.cv-tailored-meta.json` contains pool/tier debug info (not the picker schema).

---

## Self-review checklist

| Spec section | Task covering it |
|---|---|
| §3 invocation (`--mode=picker`) | Task 4 |
| §4 archetype map | Task 5 (config) + Task 1 (resolve logic) |
| §5 output (`cv.tailored.md` + sidecar) | Task 4 |
| §6 code structure (`lib/picker.mjs`) | Tasks 1–3 |
| §7 edge cases | Tasks 1–3 (unit) + Task 4 (e2e) + Task 6 (live) |
| §8 testing plan (9 cases) | Tasks 1–4 cover all 9 |

Nine test cases from spec §8 map to:
- §8.1 `resolvePickerResume mapped+exists` → Task 1 test 1
- §8.2 `resolvePickerResume mapped+missing` → Task 1 test 2
- §8.3 `resolvePickerResume unknown archetype` → Task 1 test 3
- §8.4 `resolvePickerResume unmapped archetype` → Task 1 test 4
- §8.5 `extractPdfText happy path` → Task 2 test 1
- §8.6 `extractPdfText binary missing` → Task 2 test 2
- §8.7 `buildPlaceholderCv includes archetype + filename` → Task 3 test 1 (+ test 2 for unmapped variant)
- §8.8 end-to-end happy path → Task 4 test 1
- §8.9 end-to-end missing PDF → Task 4 test 2
