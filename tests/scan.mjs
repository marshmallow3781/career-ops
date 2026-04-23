import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationFilter } from '../scan.mjs';

test('buildLocationFilter: empty config → permissive (everything passes)', () => {
  const f = buildLocationFilter(undefined);
  assert.equal(f('San Francisco, CA'), true);
  assert.equal(f('London, UK'), true);
  assert.equal(f(null), true);
});

test('buildLocationFilter: empty allow list → permissive', () => {
  const f = buildLocationFilter({ allow: [], deny: ['Remote - EU'] });
  assert.equal(f('London, UK'), true);
});

test('buildLocationFilter: allow match passes', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: [] });
  assert.equal(f('San Francisco, CA'), true);
});

test('buildLocationFilter: deny wins over allow', () => {
  const f = buildLocationFilter({ allow: ['Remote'], deny: ['Remote - EU'] });
  assert.equal(f('Remote - EU'), false);
  assert.equal(f('Remote'), true);
});

test('buildLocationFilter: case-insensitive', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: [] });
  assert.equal(f('san francisco, ca'), true);
  assert.equal(f('SAN FRANCISCO, CA'), true);
});

test('buildLocationFilter: multi-location pipe-separated string', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: ['London'] });
  assert.equal(f('San Francisco, CA | Paris, France'), true);
  assert.equal(f('San Francisco, CA | London, UK'), false);
});

test('buildLocationFilter: DC carve-out (Washington allow + Washington, DC deny)', () => {
  const f = buildLocationFilter({ allow: ['Washington'], deny: ['Washington, DC'] });
  assert.equal(f('Seattle, Washington'), true);
  assert.equal(f('Washington, DC'), false);
});

test('buildLocationFilter: missing location → drop (fail closed)', () => {
  const f = buildLocationFilter({ allow: [', CA'], deny: [] });
  assert.equal(f(null), false);
  assert.equal(f(undefined), false);
  assert.equal(f(''), false);
});

test('buildLocationFilter: no allow match → drop', () => {
  const f = buildLocationFilter({ allow: [', CA', ', WA'], deny: [] });
  assert.equal(f('Austin, TX'), false);
  assert.equal(f('New York City, NY'), false);
});

import { buildBlacklistFilter } from '../scan.mjs';

test('buildBlacklistFilter: empty list → permissive (never blocks)', () => {
  const f = buildBlacklistFilter([]);
  assert.equal(f('Acme'), false);       // false = not blacklisted = pass
  assert.equal(f('Turing'), false);
  assert.equal(f(null), false);
});

test('buildBlacklistFilter: undefined list → permissive', () => {
  const f = buildBlacklistFilter(undefined);
  assert.equal(f('Anything'), false);
});

test('buildBlacklistFilter: exact match (case-insensitive)', () => {
  const f = buildBlacklistFilter(['Turing', 'Jobs via Dice']);
  assert.equal(f('Turing'), true);
  assert.equal(f('turing'), true);
  assert.equal(f('TURING'), true);
  assert.equal(f('Jobs via Dice'), true);
});

test('buildBlacklistFilter: substring match via normalizeCompany', () => {
  // "Walmart" in the list should also block "Walmart Labs", "Walmart Connect", etc.
  const f = buildBlacklistFilter(['Walmart']);
  assert.equal(f('Walmart Labs'), true);
  assert.equal(f('Walmart Connect'), true);
  assert.equal(f('Intel'), false);
});

test('buildBlacklistFilter: non-matching company passes (returns false)', () => {
  const f = buildBlacklistFilter(['Turing', 'CyberCoders']);
  assert.equal(f('Anthropic'), false);
  assert.equal(f('Stripe'), false);
});

test('buildBlacklistFilter: empty / null company → pass', () => {
  // Can't evaluate a missing company against blacklist — don't silently
  // drop, let downstream filters handle it (location filter fails null
  // anyway, so this is defensive consistency).
  const f = buildBlacklistFilter(['Turing']);
  assert.equal(f(''), false);
  assert.equal(f(null), false);
  assert.equal(f(undefined), false);
});
