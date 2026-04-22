import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTitleFilter } from '../digest-builder.mjs';

const filter = {
  positive: ['Backend', 'Infrastructure', 'Platform', 'Data Engineer', 'ML'],
  negative: ['.NET', 'Java Senior Developer'],
};
const dealBreakers = ['Intern', 'Junior', 'Contract'];

test('applyTitleFilter: positive match passes', () => {
  assert.equal(applyTitleFilter('Senior Backend Engineer', filter, dealBreakers), true);
});

test('applyTitleFilter: no positive match fails', () => {
  assert.equal(applyTitleFilter('Product Manager', filter, dealBreakers), false);
});

test('applyTitleFilter: negative match fails', () => {
  assert.equal(applyTitleFilter('.NET Backend Engineer', filter, dealBreakers), false);
});

test('applyTitleFilter: deal-breaker match fails', () => {
  assert.equal(applyTitleFilter('Junior Backend Engineer', filter, dealBreakers), false);
  assert.equal(applyTitleFilter('Software Engineering Intern, Backend', filter, dealBreakers), false);
});

test('applyTitleFilter: case-insensitive', () => {
  assert.equal(applyTitleFilter('senior backend engineer', filter, dealBreakers), true);
  assert.equal(applyTitleFilter('JUNIOR BACKEND', filter, dealBreakers), false);
});
