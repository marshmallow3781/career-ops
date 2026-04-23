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
