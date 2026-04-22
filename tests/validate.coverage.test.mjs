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

test('coverage: directory "meta" should NOT match "Metadata Corp" (slug regression)', () => {
  const tailored = `### Metadata Corp — SF\n**Engineer** | 2023 → 2024\n`;
  const required = ['meta'];
  const errors = checkCompanyCoverage(tailored, required);
  assert.equal(errors.length, 1, 'meta directory must require an actual meta header, not metadata');
  assert.equal(errors[0].type, 'missing_company');
});

test('coverage: directory "acme" matches "Acme Corp" (acme-corp slug)', () => {
  const tailored = `### Acme Corp — SF\n`;
  const required = ['acme'];
  const errors = checkCompanyCoverage(tailored, required);
  assert.deepEqual(errors, []);
});
