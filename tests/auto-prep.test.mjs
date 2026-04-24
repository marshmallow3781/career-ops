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
