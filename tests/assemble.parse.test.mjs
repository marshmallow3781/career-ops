import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceFile } from '../assemble-core.mjs';

const sample = `---
company: Acme Corp
role: Senior Engineer
location: San Francisco, CA
start: 2023-04
end: 2024-11
facet: backend
---

## Bullets

- Built distributed queue handling 10K rps
- Migrated monolith to microservices over 6 months

## Projects

- **Queue Service** — Kafka-based, 99.99% delivery
  - Handled DLQ replay logic
- **Monolith Migration** — strangler-fig pattern, zero-downtime

## Skills used

Go, Kafka, Postgres, Kubernetes
`;

test('parseSourceFile: extracts frontmatter', () => {
  const parsed = parseSourceFile(sample);
  assert.equal(parsed.frontmatter.company, 'Acme Corp');
  assert.equal(parsed.frontmatter.role, 'Senior Engineer');
  assert.equal(parsed.frontmatter.start, '2023-04');
  assert.equal(parsed.frontmatter.facet, 'backend');
});

test('parseSourceFile: extracts bullets', () => {
  const parsed = parseSourceFile(sample);
  assert.equal(parsed.bullets.length, 2);
  assert.match(parsed.bullets[0].text, /distributed queue/);
  assert.equal(parsed.bullets[0].lineNumber, 11);
});

test('parseSourceFile: extracts projects (top-level only, not indented details)', () => {
  const parsed = parseSourceFile(sample);
  assert.equal(parsed.projects.length, 2);
  assert.match(parsed.projects[0].text, /Queue Service/);
});

test('parseSourceFile: extracts skills as array', () => {
  const parsed = parseSourceFile(sample);
  assert.deepEqual(parsed.skills, ['Go', 'Kafka', 'Postgres', 'Kubernetes']);
});

test('parseSourceFile: missing required frontmatter throws', () => {
  const broken = `---\ncompany: Acme\n---\n## Bullets\n- foo`;
  assert.throws(() => parseSourceFile(broken), /frontmatter/i);
});

import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAllSources, validateConsistency } from '../assemble-core.mjs';

function withFakeSources(setup, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-sources-'));
  try {
    setup(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const facetA = `---
company: Acme Corp
role: Senior Engineer
location: SF
start: 2023-04
end: 2024-11
facet: backend
---
## Bullets
- A1
- A2
`;

const facetB = `---
company: Acme Corp
role: Senior Engineer
location: SF
start: 2023-04
end: 2024-11
facet: frontend
---
## Bullets
- B1
`;

const facetMismatch = `---
company: Acme Corp
role: Staff Engineer
location: SF
start: 2023-04
end: 2024-11
facet: frontend
---
## Bullets
- B1
`;

test('loadAllSources: groups files by company', () => {
  withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'acme'));
      writeFileSync(join(dir, 'acme', 'backend.md'), facetA);
      writeFileSync(join(dir, 'acme', 'frontend.md'), facetB);
    },
    (dir) => {
      const sources = loadAllSources(dir);
      assert.equal(Object.keys(sources).length, 1);
      assert.equal(sources.acme.length, 2);
    }
  );
});

test('validateConsistency: identical role across facets → ok', () => {
  withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'acme'));
      writeFileSync(join(dir, 'acme', 'backend.md'), facetA);
      writeFileSync(join(dir, 'acme', 'frontend.md'), facetB);
    },
    (dir) => {
      const sources = loadAllSources(dir);
      assert.doesNotThrow(() => validateConsistency(sources));
    }
  );
});

test('validateConsistency: mismatched role across facets throws', () => {
  withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'acme'));
      writeFileSync(join(dir, 'acme', 'backend.md'), facetA);
      writeFileSync(join(dir, 'acme', 'frontend.md'), facetMismatch);
    },
    (dir) => {
      const sources = loadAllSources(dir);
      assert.throws(() => validateConsistency(sources), /role/i);
    }
  );
});

import { sortCompanies } from '../assemble-core.mjs';

const _2024 = (facet) => `---
company: A
role: r
location: l
start: 2024-01
end: present
facet: ${facet}
---
## Bullets
- x
`;

const _2020 = (facet) => `---
company: B
role: r
location: l
start: 2020-01
end: 2023-12
facet: ${facet}
---
## Bullets
- x
`;

test('sortCompanies: most recent first by start date', async () => {
  await withFakeSources(
    (dir) => {
      mkdirSync(join(dir, 'older'));
      mkdirSync(join(dir, 'newer'));
      writeFileSync(join(dir, 'older', 'backend.md'), _2020('backend'));
      writeFileSync(join(dir, 'newer', 'backend.md'), _2024('backend'));
    },
    async (dir) => {
      const sorted = await sortCompanies(dir, ['older', 'newer']);
      assert.deepEqual(sorted, ['newer', 'older']);
    }
  );
});
