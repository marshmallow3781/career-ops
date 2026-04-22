import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkedInId } from '../lib/dedup.mjs';

test('extractLinkedInId: canonical URL → id string', () => {
  assert.equal(
    extractLinkedInId('https://www.linkedin.com/jobs/view/3847123456/'),
    '3847123456'
  );
});

test('extractLinkedInId: URL without trailing slash', () => {
  assert.equal(
    extractLinkedInId('https://www.linkedin.com/jobs/view/3847123456'),
    '3847123456'
  );
});

test('extractLinkedInId: URL with query params', () => {
  assert.equal(
    extractLinkedInId('https://www.linkedin.com/jobs/view/3847123456/?trk=abc&refId=xyz'),
    '3847123456'
  );
});

test('extractLinkedInId: non-LinkedIn URL → null', () => {
  assert.equal(
    extractLinkedInId('https://job-boards.greenhouse.io/anthropic/jobs/4517823'),
    null
  );
});

test('extractLinkedInId: malformed URL → null', () => {
  assert.equal(extractLinkedInId('not-a-url'), null);
  assert.equal(extractLinkedInId(''), null);
  assert.equal(extractLinkedInId(null), null);
});

import { normalizeCompany, normalizeTitle } from '../lib/dedup.mjs';

test('normalizeCompany: basic kebab-case', () => {
  assert.equal(normalizeCompany('Anthropic'), 'anthropic');
  assert.equal(normalizeCompany('LinkedIn Corporation'), 'linkedin-corporation');
});

test('normalizeCompany: strips trademarks, apostrophes, punctuation', () => {
  assert.equal(normalizeCompany('McDonald\'s, Inc.'), 'mcdonalds-inc');
  assert.equal(normalizeCompany('AT&T™'), 'att');
});

test('normalizeCompany: empty/null returns empty string', () => {
  assert.equal(normalizeCompany(''), '');
  assert.equal(normalizeCompany(null), '');
});

test('normalizeTitle: lowercase + kebab-case', () => {
  assert.equal(
    normalizeTitle('Staff+ Software Engineer, Data Infrastructure'),
    'staff-software-engineer-data-infrastructure'
  );
});

test('normalizeTitle: strips " | Company" and " @ Company" suffixes', () => {
  assert.equal(
    normalizeTitle('Senior Backend Engineer | Anthropic'),
    'senior-backend-engineer'
  );
  assert.equal(
    normalizeTitle('ML Engineer @ Scale AI'),
    'ml-engineer'
  );
});

import { computeJdFingerprint } from '../lib/dedup.mjs';

test('computeJdFingerprint: identical text → identical hash', () => {
  const a = 'We are hiring a Senior Backend Engineer.';
  const b = 'We are hiring a Senior Backend Engineer.';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: whitespace-insensitive', () => {
  const a = 'We are hiring a Senior Engineer.';
  const b = 'We  are\nhiring   a\tSenior\n\nEngineer.';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: case-insensitive', () => {
  const a = 'We Are Hiring';
  const b = 'we are hiring';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: punctuation-insensitive', () => {
  const a = 'Backend Engineer: We are hiring!';
  const b = 'Backend Engineer We are hiring';
  assert.equal(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: different text → different hash', () => {
  const a = 'We are hiring backend engineers';
  const b = 'We are hiring frontend engineers';
  assert.notEqual(computeJdFingerprint(a), computeJdFingerprint(b));
});

test('computeJdFingerprint: empty → stable fixed hash', () => {
  assert.equal(computeJdFingerprint(''), computeJdFingerprint(''));
  assert.equal(typeof computeJdFingerprint(''), 'string');
});

test('computeJdFingerprint: returns 64-char hex string (SHA-256)', () => {
  const fp = computeJdFingerprint('test content');
  assert.equal(fp.length, 64);
  assert.match(fp, /^[0-9a-f]{64}$/);
});
