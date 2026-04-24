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
