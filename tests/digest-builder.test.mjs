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

import { isCompanyBlacklisted } from '../digest-builder.mjs';

const blacklist = [
  'RemoteHunter', 'Walmart', 'PayPal', 'Jobright.ai', 'Turing',
  'ByteDance', 'TikTok', 'Insight Global', 'CyberCoders',
  'Jobs via Dice', 'Open Talent',
];

test('isCompanyBlacklisted: exact match (case-insensitive)', () => {
  assert.equal(isCompanyBlacklisted('Walmart', blacklist), true);
  assert.equal(isCompanyBlacklisted('WALMART', blacklist), true);
  assert.equal(isCompanyBlacklisted('walmart', blacklist), true);
});

test('isCompanyBlacklisted: substring match (subsidiary names)', () => {
  assert.equal(isCompanyBlacklisted('Walmart Labs', blacklist), true);
  assert.equal(isCompanyBlacklisted('Walmart Connect', blacklist), true);
  assert.equal(isCompanyBlacklisted('PayPal Ventures', blacklist), true);
});

test('isCompanyBlacklisted: multi-word entries with punctuation', () => {
  assert.equal(isCompanyBlacklisted('Insight Global', blacklist), true);
  assert.equal(isCompanyBlacklisted('Jobs via Dice', blacklist), true);
  assert.equal(isCompanyBlacklisted('Open Talent', blacklist), true);
  assert.equal(isCompanyBlacklisted('Jobright.ai', blacklist), true);
});

test('isCompanyBlacklisted: TikTok and ByteDance variants', () => {
  assert.equal(isCompanyBlacklisted('TikTok', blacklist), true);
  assert.equal(isCompanyBlacklisted('ByteDance Inc', blacklist), true);
  assert.equal(isCompanyBlacklisted('Tiktok (ByteDance)', blacklist), true);
});

test('isCompanyBlacklisted: non-blacklisted company passes', () => {
  assert.equal(isCompanyBlacklisted('Anthropic', blacklist), false);
  assert.equal(isCompanyBlacklisted('Databricks', blacklist), false);
  assert.equal(isCompanyBlacklisted('Stripe', blacklist), false);
});

test('isCompanyBlacklisted: empty blacklist → everyone passes', () => {
  assert.equal(isCompanyBlacklisted('Walmart', []), false);
  assert.equal(isCompanyBlacklisted('Walmart', undefined), false);
});

test('isCompanyBlacklisted: empty company name → not blacklisted', () => {
  assert.equal(isCompanyBlacklisted('', blacklist), false);
  assert.equal(isCompanyBlacklisted(null, blacklist), false);
});
