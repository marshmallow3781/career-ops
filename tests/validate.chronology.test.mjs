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
