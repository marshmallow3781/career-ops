import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preFilterJob } from '../digest-builder.mjs';

// Fake Anthropic client returning a scripted text response.
// preFilterJob uses the anthropic code path by default when no config is
// passed — that path reads response.content[] and joins text-bearing blocks.
function makeClient(responseText) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: responseText }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    },
  };
}

const job = { title: 'Senior Backend Engineer', company: 'Acme', location: 'SF', description: 'Build things' };
const sys = 'You are a prefilter. Return JSON.';
const summary = '<candidate>test</candidate>';

test('preFilterJob: parses clean JSON', async () => {
  const client = makeClient('{"archetype":"backend","score":8,"reason":"Strong match"}');
  const { archetype, score, reason } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'backend');
  assert.equal(score, 8);
  assert.equal(reason, 'Strong match');
});

test('preFilterJob: tolerates prose prefix before JSON', async () => {
  // Anthropic extended-thinking models and MiniMax sometimes emit a short
  // narrator sentence before the JSON. The brace scanner starts at the
  // first `{` so this should still parse.
  const client = makeClient('Here is my assessment:\n{"archetype":"infra","score":6,"reason":"OK"}');
  const { archetype, score } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'infra');
  assert.equal(score, 6);
});

test('preFilterJob: brace-counter handles nested objects', async () => {
  // The old /\{[^}]+\}/ regex would match only `{"inner":"x"}` and drop
  // the outer frame. The new scanner tracks depth so it captures the full
  // outer object.
  const client = makeClient(
    '{"archetype":"backend","score":7,"reason":"solid","details":{"inner":"x"}}'
  );
  const { archetype, score } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'backend');
  assert.equal(score, 7);
});

test('preFilterJob: brace-counter handles closing brace inside string', async () => {
  // This is the real-world failure mode from the NVIDIA job. The old
  // regex would stop at the first `}` inside the reason string and
  // produce invalid JSON. The scanner tracks string state so it skips
  // braces inside quoted strings.
  const client = makeClient(
    '{"archetype":"backend","score":5,"reason":"uses {foo} bar syntax in docs"}'
  );
  const { archetype, score, reason } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'backend');
  assert.equal(score, 5);
  assert.ok(reason.includes('{foo}'));
});

test('preFilterJob: brace-counter handles escaped quotes inside string', async () => {
  const client = makeClient(
    '{"archetype":"backend","score":4,"reason":"a \\"quoted\\" term"}'
  );
  const { archetype, score } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'backend');
  assert.equal(score, 4);
});

test('preFilterJob: truncated JSON returns parse-failed sentinel', async () => {
  // If the model runs out of max_tokens mid-response, the JSON has no
  // closing `}`. The scanner should return end=-1 and preFilterJob should
  // surface archetype='unknown' with a diagnostic reason — not crash.
  const client = makeClient('{"archetype":"backend","score":8,"reason":"strong');
  const { archetype, score, reason } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'unknown');
  assert.equal(score, null);
  assert.equal(reason, 'prefilter parse failed');
});

test('preFilterJob: empty response returns parse-failed sentinel', async () => {
  const client = makeClient('');
  const { archetype, score } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'unknown');
  assert.equal(score, null);
});

test('preFilterJob: network error returns unavailable sentinel', async () => {
  const client = {
    messages: {
      create: async () => { throw new Error('ECONNRESET'); },
    },
  };
  const { archetype, score, reason } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'unknown');
  assert.equal(score, null);
  assert.ok(reason.startsWith('prefilter unavailable'));
});

test('preFilterJob: clamps score out of range', async () => {
  const client = makeClient('{"archetype":"backend","score":15,"reason":"ok"}');
  const { score } = await preFilterJob(job, sys, summary, client);
  assert.equal(score, 10);
});

test('preFilterJob: coerces invalid archetype to unknown', async () => {
  const client = makeClient('{"archetype":"bogus","score":5,"reason":"ok"}');
  const { archetype, score } = await preFilterJob(job, sys, summary, client);
  assert.equal(archetype, 'unknown');
  assert.equal(score, 5);
});
