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

import { loadSeenJobs, appendSeenJobs, SEEN_JOBS_HEADER } from '../lib/dedup.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withTempFile(setup, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'seen-jobs-'));
  const path = join(dir, 'seen-jobs.tsv');
  if (setup) setup(path);
  try {
    return await fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadSeenJobs: missing file → empty Sets and Maps', async () => {
  await withTempFile(null, async (path) => {
    const state = await loadSeenJobs(path);
    assert.equal(state.linkedinIds.size, 0);
    assert.equal(state.fingerprints.size, 0);
    assert.equal(state.titleCompanyKeys.size, 0);
  });
});

test('loadSeenJobs: file with 2 rows → populates sets', async () => {
  await withTempFile(
    (path) => {
      writeFileSync(path,
        SEEN_JOBS_HEADER + '\n' +
        '3847123456\thttps://www.linkedin.com/jobs/view/3847123456\tanthropic\tstaff-swe-data-infra\t2026-04-22T14:00Z\t2026-04-22T14:00Z\tapify-linkedin-california\tnew\tabc123\tbackend\t9\tExact stack match\n' +
        '(none)\thttps://job-boards.greenhouse.io/anthropic/jobs/4517823\tanthropic\tstaff-swe-data-infra\t2026-04-22T13:00Z\t2026-04-22T13:00Z\tscan-greenhouse\tnew\tabc123\t(none)\t(none)\t(none)\n'
      );
    },
    async (path) => {
      const state = await loadSeenJobs(path);
      assert.equal(state.linkedinIds.size, 1);  // only LinkedIn entry
      assert.ok(state.linkedinIds.has('3847123456'));
      assert.equal(state.fingerprints.size, 1);  // both map to same fingerprint
      assert.ok(state.fingerprints.has('abc123'));
      assert.equal(state.titleCompanyKeys.size, 1);  // same company+title
    }
  );
});

test('appendSeenJobs: appends rows atomically and preserves existing data', async () => {
  await withTempFile(
    (path) => {
      writeFileSync(path,
        SEEN_JOBS_HEADER + '\n' +
        'existing\thttps://x/1\tacme\tsenior-swe\t2026-04-22T10:00Z\t2026-04-22T10:00Z\tapify-linkedin-california\tnew\tfp1\tbackend\t8\told\n'
      );
    },
    async (path) => {
      await appendSeenJobs(path, [{
        linkedin_id: 'new1',
        url: 'https://www.linkedin.com/jobs/view/new1',
        company_slug: 'globex',
        title_normalized: 'backend-engineer',
        first_seen_utc: '2026-04-22T14:00Z',
        last_seen_utc: '2026-04-22T14:00Z',
        source: 'apify-linkedin-california',
        status: 'new',
        jd_fingerprint: 'fp2',
        prefilter_archetype: '(none)',
        prefilter_score: '(none)',
        prefilter_reason: '(none)',
      }]);
      const content = readFileSync(path, 'utf-8');
      assert.ok(content.includes('existing'), 'existing row preserved');
      assert.ok(content.includes('new1'), 'new row appended');
    }
  );
});

test('appendSeenJobs: creates file with header if missing', async () => {
  await withTempFile(null, async (path) => {
    assert.equal(existsSync(path), false);
    await appendSeenJobs(path, [{
      linkedin_id: 'first',
      url: 'https://www.linkedin.com/jobs/view/first',
      company_slug: 'acme',
      title_normalized: 'swe',
      first_seen_utc: '2026-04-22T14:00Z',
      last_seen_utc: '2026-04-22T14:00Z',
      source: 'apify-linkedin-california',
      status: 'new',
      jd_fingerprint: 'fp1',
      prefilter_archetype: '(none)',
      prefilter_score: '(none)',
      prefilter_reason: '(none)',
    }]);
    const content = readFileSync(path, 'utf-8');
    assert.ok(content.startsWith(SEEN_JOBS_HEADER), 'header present on first write');
    assert.ok(content.includes('first'), 'row appended');
  });
});

test('loadSeenJobs: corrupt file → backed up, empty state returned', async () => {
  await withTempFile(
    (path) => {
      writeFileSync(path, 'not a valid tsv\nsome garbage here\n');
    },
    async (path, dir) => {
      const state = await loadSeenJobs(path);
      assert.equal(state.linkedinIds.size, 0);
      assert.equal(state.fingerprints.size, 0);
      // Verify backup was created
      const files = readdirSync(dir);
      const corrupt = files.find(f => f.includes('.corrupt-'));
      assert.ok(corrupt, 'backup file created');
    }
  );
});
