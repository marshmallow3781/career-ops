import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticleDigest } from '../assemble-core.mjs';

const sample = `# Article Digest — Personal/Non-company Proof Points

## FraudShield — Real-time Fraud Detection (Open Source)
**Type:** open-source
**Archetype:** machine_learning
**Hero metrics:** 99.7% precision, 50ms p99, 500+ GitHub stars

## "Why RAG is not enough" (Blog)
**Type:** article
**Archetype:** machine_learning
`;

test('parseArticleDigest: extracts each H2 entry as a project', () => {
  const projects = parseArticleDigest(sample, 'article-digest.md');
  assert.equal(projects.length, 2);
  assert.match(projects[0].text, /FraudShield/);
  assert.equal(projects[0].sourcePath, 'article-digest.md');
  assert.equal(projects[0].archetype, 'machine_learning');
});

test('parseArticleDigest: missing file or empty content returns []', () => {
  assert.deepEqual(parseArticleDigest('', 'article-digest.md'), []);
});
