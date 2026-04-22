import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTailored } from '../assemble-core.mjs';

const profile = {
  candidate: { full_name: 'Test User', email: 't@example.com', location: 'SF', linkedin: 'linkedin.com/in/x' },
  narrative: { headline: 'Backend engineer' },
};

const companies = [
  {
    dir: 'acme',
    frontmatter: { company: 'Acme Corp', role: 'Senior Engineer', location: 'SF', start: '2023-04', end: '2024-11' },
    tier: 'full',
    bullets: [
      { text: 'Built distributed queue', sourcePath: 'acme/backend.md', sourceLine: 11 },
      { text: 'Migrated monolith', sourcePath: 'acme/backend.md', sourceLine: 12 },
    ],
  },
  {
    dir: 'globex',
    frontmatter: { company: 'Globex Inc', role: 'Engineer', location: 'NYC', start: '2020-01', end: '2023-03' },
    tier: 'stub',
    stub: 'Built features on a global commerce platform.',
  },
];

const projects = [
  { text: '**Queue Service** — Kafka-based, 99.99% delivery', sourcePath: 'acme/backend.md', sourceLine: 15 },
];
const competencies = ['Distributed systems', 'Postgres', 'Kafka'];
const summary = 'Backend engineer with 5 years experience building distributed systems.';

test('renderTailored: includes header with name', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /# Test User/);
  assert.match(md, /t@example\.com/);
});

test('renderTailored: each company has H3 header and tier-appropriate bullets', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /### Acme Corp/);
  assert.match(md, /### Globex Inc/);
  assert.match(md, /Built distributed queue.*<!-- src:acme\/backend\.md#L11 -->/);
  assert.match(md, /Built features on a global commerce platform/);
});

test('renderTailored: projects have provenance markers', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /Queue Service.*<!-- src:acme\/backend\.md#L15 -->/);
});

test('renderTailored: competencies and summary present', () => {
  const md = renderTailored({ profile, companies, projects, competencies, summary });
  assert.match(md, /Distributed systems/);
  assert.match(md, /Backend engineer with 5 years/);
});
