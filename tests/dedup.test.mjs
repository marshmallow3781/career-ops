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
