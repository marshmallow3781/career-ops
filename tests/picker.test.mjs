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

// ── e2e tests: wire --mode=picker into assemble-cv.mjs ───────────────────────

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
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
