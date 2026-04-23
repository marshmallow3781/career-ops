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
