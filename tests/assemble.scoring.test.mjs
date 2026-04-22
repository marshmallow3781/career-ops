import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywords, expandSynonyms, scoreBullet } from '../assemble-core.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYNONYM_YAML = `
groups:
  - canonical: rag
    aliases: [rag pipeline, retrieval-augmented generation]
  - canonical: vector_db
    aliases: [vector database, pinecone]
`;

function withSynonyms(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'syn-'));
  const path = join(dir, 'synonyms.yml');
  writeFileSync(path, SYNONYM_YAML);
  return fn(path);
}

test('extractKeywords: extracts capitalized phrases and tech tokens', () => {
  const jd = 'We are hiring a Senior Backend Engineer with Postgres, Kafka, and Kubernetes experience.';
  const keywords = extractKeywords(jd);
  assert.ok(keywords.has('postgres'));
  assert.ok(keywords.has('kafka'));
  assert.ok(keywords.has('kubernetes'));
});

test('expandSynonyms: expands canonical via synonyms file', () => {
  withSynonyms((path) => {
    const expanded = expandSynonyms(new Set(['rag pipeline']), path);
    assert.ok(expanded.has('rag'));
    assert.ok(expanded.has('rag pipeline'));
    assert.ok(expanded.has('retrieval-augmented generation'));
  });
});

test('scoreBullet: counts unique keyword hits', () => {
  const bullet = 'Built RAG pipeline with Pinecone and OpenAI embeddings';
  const keywords = new Set(['rag pipeline', 'pinecone', 'embeddings']);
  assert.equal(scoreBullet(bullet, keywords), 3);
});

test('scoreBullet: case insensitive, whole-token match', () => {
  const bullet = 'Designed Postgres schema for high write throughput';
  const keywords = new Set(['postgres']);
  assert.equal(scoreBullet(bullet, keywords), 1);
});
