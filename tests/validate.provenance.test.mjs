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
  const rephrased = 'Built RAG pipeline with retrieval of embeddings';
  const r = levenshteinRatio(original, rephrased);
  assert.ok(r >= 0.85, `expected >=0.85 got ${r}`);
});

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
      const tailored = '- Built RAG pipeline with retrieval of embeddings <!-- src:acme/backend.md#L3 -->';
      const errors = checkBulletProvenance(tailored, dir);
      assert.deepEqual(errors, []);
    }
  );
});

test('provenance: _stub sentinel marker passes (intentional config-driven fallback)', () => {
  const tailored = '- Built features on a global commerce platform. <!-- src:_stub -->';
  const errors = checkBulletProvenance(tailored, '/nonexistent');
  assert.deepEqual(errors, []);
});

test('provenance: missing source file → source_not_found error', () => {
  const tailored = '- Some bullet <!-- src:nonexistent/backend.md#L5 -->';
  const errors = checkBulletProvenance(tailored, '/tmp/no-such-dir-xyz123');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'source_not_found');
  assert.equal(errors[0].path, 'nonexistent/backend.md');
});

test('provenance: source file exists but has no ## Bullets section → fabricated_bullet', () => {
  withTempSource(
    (dir) => {
      mkdirSync(join(dir, 'acme'), { recursive: true });
      writeFileSync(join(dir, 'acme', 'backend.md'), '## Projects\n\n- only projects, no bullets\n');
    },
    (dir) => {
      const tailored = '- Some bullet <!-- src:acme/backend.md#L1 -->';
      const errors = checkBulletProvenance(tailored, dir);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].type, 'fabricated_bullet');
    }
  );
});
