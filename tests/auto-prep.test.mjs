import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEvalBlocks } from '../lib/auto-prep.mjs';

function mockLlmClient(responseText) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: responseText }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    },
  };
}

const goodJson = JSON.stringify({
  block_a: 'Acme is hiring a backend engineer...',
  block_b_rows: [
    { req: 'Go/Java', evidence: 'LinkedIn 531M events/day in Go' },
    { req: 'Kafka', evidence: 'TikTok real-time pipelines' },
  ],
  block_e: 'Lead with the 531M/day scale number...',
  block_f_stories: [
    { scenario: 'Scaling Kafka to 2K QPS', star_prompt: 'STAR: 2021 LinkedIn migration' },
  ],
  block_h_answers: [
    { prompt: 'Why Acme?', answer: 'Your distributed systems investment...' },
  ],
});

test('generateEvalBlocks: parses valid JSON into structured blocks', async () => {
  const client = mockLlmClient(goodJson);
  const result = await generateEvalBlocks({
    jdText: 'JD text',
    candidateSummary: 'candidate summary',
    tierBreakdown: null,
    existingStoryThemes: [],
    llmClient: client,
    llmConfig: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  });
  assert.equal(result.block_a.startsWith('Acme'), true);
  assert.equal(result.block_b_rows.length, 2);
  assert.equal(result.block_f_stories.length, 1);
});

test('generateEvalBlocks: returns empty-stub shape when LLM returns malformed JSON', async () => {
  const client = mockLlmClient('this is not JSON');
  const result = await generateEvalBlocks({
    jdText: 'JD',
    candidateSummary: 'summary',
    tierBreakdown: null,
    existingStoryThemes: [],
    llmClient: client,
    llmConfig: { provider: 'anthropic', model: 'x' },
  });
  assert.equal(result.block_a, '');
  assert.deepEqual(result.block_b_rows, []);
  assert.deepEqual(result.block_f_stories, []);
  assert.deepEqual(result.block_h_answers, []);
  assert.ok(result._parse_failed === true, 'should flag parse failure');
});

import { appendStoryBank } from '../lib/auto-prep.mjs';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('appendStoryBank: new stories write to file; dedup by normalized scenario', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sb-'));
  const path = join(tmp, 'story-bank.md');
  writeFileSync(path, '# Story Bank\n\n');

  try {
    const stories = [
      { scenario: 'Scaling Kafka to 2K QPS', star_prompt: 'STAR prompt A' },
      { scenario: 'Privacy compliance rollout', star_prompt: 'STAR prompt B' },
    ];
    const added = appendStoryBank({ storyBankPath: path, newStories: stories, companyTag: 'Mercor', dateTag: '2026-04-23' });
    assert.equal(added, 2);
    const body = readFileSync(path, 'utf-8');
    assert.ok(body.includes('Scaling Kafka to 2K QPS'));
    assert.ok(body.includes('Mercor'));

    // Second call with one duplicate scenario
    const added2 = appendStoryBank({
      storyBankPath: path,
      newStories: [
        { scenario: 'Scaling Kafka to 2K QPS', star_prompt: 'STAR prompt A duplicate' },
        { scenario: 'New unique scenario', star_prompt: 'STAR prompt C' },
      ],
      companyTag: 'Google',
      dateTag: '2026-04-23',
    });
    assert.equal(added2, 1, 'only new unique story should be appended');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('appendStoryBank: bootstraps file if missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sb-'));
  const path = join(tmp, 'story-bank.md');  // does not exist yet
  try {
    const added = appendStoryBank({
      storyBankPath: path,
      newStories: [{ scenario: 'first story', star_prompt: 'prompt' }],
      companyTag: 'Acme',
      dateTag: '2026-04-23',
    });
    assert.equal(added, 1);
    const body = readFileSync(path, 'utf-8');
    assert.ok(body.startsWith('# Story Bank'));
    assert.ok(body.includes('first story'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetDbForTesting, connectWithClient } from '../lib/db.mjs';
import { runAutoPrep } from '../auto-prep.mjs';

test('runAutoPrep: skips jobs with application_id set (dedup X)', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-auto-prep');
  const db = client.db('test-auto-prep');

  try {
    await db.collection('jobs').insertOne({
      linkedin_id: 'j-applied',
      stage: 'scored',
      prefilter_score: 9,
      prefilter_archetype: 'backend',
      company: 'X', title: 'Backend',
      first_seen_at: new Date(),
      application_id: 42,  // already applied
    });

    const result = await runAutoPrep({
      minScore: 8,
      mockLlmClient: null,
      mockLegitimacy: null,
      mockRenderPdf: null,
    });
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_already_applied, 1);
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});

test('runAutoPrep: skips jobs whose archetype has no PDF (dedup Y)', { timeout: 30000 }, async () => {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  await connectWithClient(client, 'test-auto-prep-y');

  try {
    await client.db('test-auto-prep-y').collection('jobs').insertOne({
      linkedin_id: 'j-no-pdf',
      stage: 'scored',
      prefilter_score: 9,
      prefilter_archetype: 'applied_ai',  // maps to applied_ai_2.0.pdf (not on disk)
      company: 'X', title: 'AI Eng',
      first_seen_at: new Date(),
      application_id: null,
    });
    const result = await runAutoPrep({ minScore: 8 });
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_no_pdf, 1);
  } finally {
    await client.close();
    await mongod.stop();
    _resetDbForTesting();
  }
});

import { renderReport } from '../lib/auto-prep.mjs';
import { renderPdf } from '../generate-pdf.mjs';

test('renderPdf: renders a minimal HTML to a PDF file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pdf-'));
  const htmlPath = join(tmp, 'in.html');
  const pdfPath = join(tmp, 'out.pdf');
  writeFileSync(htmlPath, '<!doctype html><html><body><h1>Hello</h1><p>body text</p></body></html>');
  try {
    const result = await renderPdf({ htmlPath, pdfPath, format: 'letter' });
    assert.ok(existsSync(pdfPath), 'PDF file should exist');
    assert.ok(statSync(pdfPath).size > 500, 'PDF should be non-trivial size');
    assert.equal(result.outputPath, pdfPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderReport: combines blocks + legitimacy into expected markdown', () => {
  const blocks = {
    block_a: 'Acme hiring backend engineer.',
    block_b_rows: [
      { req: 'Go', evidence: 'LinkedIn 531M events' },
      { req: 'Kafka', evidence: 'TikTok pipelines' },
    ],
    block_e: 'Lead with scale.',
    block_f_stories: [
      { scenario: 'Kafka 2K QPS', star_prompt: 'STAR prompt' },
    ],
    block_h_answers: [
      { prompt: 'Why Acme?', answer: 'Their distributed investment.' },
    ],
  };
  const legitimacy = { tier: 'confirmed', signals: ['has_h1', 'has_apply_button'] };
  const job = {
    company: 'Acme',
    title: 'Backend Engineer',
    url: 'https://example.com/job',
    prefilter_archetype: 'backend',
    prefilter_score: 9,
  };

  const md = renderReport({ blocks, legitimacy, job, score: 4.5, pdfPath: 'cvs/acme/be/123_cv_picker.pdf' });
  assert.ok(md.startsWith('# Acme — Backend Engineer'));
  assert.ok(md.includes('**Score:** 4.5/5'));
  assert.ok(md.includes('**Legitimacy:** confirmed'));
  assert.ok(md.includes('## Block A — Resumen del Rol'));
  assert.ok(md.includes('## Block B — Match con CV'));
  assert.ok(md.includes('| Go | LinkedIn 531M events |'));
  assert.ok(md.includes('## Block E — Plan de Personalización'));
  assert.ok(md.includes('## Block F — Plan de Entrevistas'));
  assert.ok(md.includes('## Block G — Posting Legitimacy'));
  assert.ok(md.includes('## Block H — Draft Application Answers'));
});
