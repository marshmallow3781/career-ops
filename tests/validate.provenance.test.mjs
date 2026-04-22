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
