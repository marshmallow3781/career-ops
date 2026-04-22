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
