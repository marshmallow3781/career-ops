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
