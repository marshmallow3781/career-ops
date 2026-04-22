import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSignals, deriveDeprioritize, SIGNAL_TABLE, SIGNAL_TO_PHRASE } from '../assemble-core.mjs';
import { extractJdIntent } from '../assemble-llm.mjs';

function mockClient(responses) {
  let callIndex = 0;
  return {
    messages: {
      create: async () => {
        if (callIndex >= responses.length) {
          throw new Error(`mockClient: no response queued for call #${callIndex}`);
        }
        const resp = responses[callIndex++];
        if (resp instanceof Error) throw resp;
        return resp;
      },
    },
  };
}

function textResp(text) {
  return { content: [{ type: 'text', text }] };
}

test('deriveSignals: returns a Set', () => {
  const signals = deriveSignals('Build an SDK for our platform');
  assert.ok(signals instanceof Set);
});

test('deriveSignals: Instacart-shape JD fires sdk, platform, training_infra, feature_store, distributed, serving', () => {
  const jd = `Senior Engineer, ML/AI Platform

  As a Senior Engineer on the ML/AI platform team, you will play a key role in
  building the internal platform which supports training and deploying AI models
  across the entire organization. You'll take ownership of defining the platform
  to enable AI model fine-tuning and batch inference by building the SDKs and
  supporting the infra to support these unique workloads.

  At Instacart, the ML/AI Platform team is a critical part of enabling the
  business across all areas. From owning the online/offline feature store to
  the serving and training layer, our team enables the entire business to
  succeed.

  - Excited to build platform-level tools, SDKs
  - Experience with high scale throughput and distributed systems problems
  - Prior experience working with AI Platforms like Ray is a plus
  `;
  const signals = deriveSignals(jd);
  assert.ok(signals.has('sdk'), `expected sdk to fire; got: ${[...signals].join(', ')}`);
  assert.ok(signals.has('platform'), 'expected platform to fire');
  assert.ok(signals.has('training_infra'), 'expected training_infra to fire');
  assert.ok(signals.has('feature_store'), 'expected feature_store to fire');
  assert.ok(signals.has('distributed'), 'expected distributed to fire');
  assert.ok(signals.has('serving'), 'expected serving to fire (Ray is a serving alias)');
});

test('deriveSignals: Komodo-shape JD fires agents, backend, observability, experimentation, distributed', () => {
  const jd = `Senior Applied AI Engineer

  Build the observability and reliability foundation for AI systems across
  Komodo (logging, tracing, evaluation pipelines, feedback loops).
  Define how the organization measures LLM performance and quality in production.
  Architect and deploy end-to-end AI systems — agent-based workflows, prompt
  chains and tool integrations and scalable LLM-powered services.

  Strong backend engineering skills: Python, APIs, distributed systems.
  Experience designing evaluation frameworks and experiments (A/B testing).
  Strong expertise with LLMs and prompt systems and agent orchestration and
  tool/function calling.
  Experience with distributed computing frameworks (Spark, Snowflake, Databricks).
  `;
  const signals = deriveSignals(jd);
  assert.ok(signals.has('agents'), 'expected agents to fire (tool calling + multi-agent + llm agent)');
  assert.ok(signals.has('backend'), 'expected backend to fire (Python + APIs)');
  assert.ok(signals.has('observability'), 'expected observability to fire (tracing + logging + monitoring)');
  assert.ok(signals.has('experimentation'), 'expected experimentation to fire (A/B testing)');
  assert.ok(signals.has('distributed'), 'expected distributed to fire (Spark + distributed systems)');
});

test('deriveSignals: generic Python JD does NOT fire sdk — "library" and "framework" aliases were intentionally dropped', () => {
  const jd = 'Python developer with experience in Django framework and requests library.';
  const signals = deriveSignals(jd);
  assert.ok(!signals.has('sdk'), `sdk must NOT fire; got: ${[...signals].join(', ')}`);
});

test('SIGNAL_TABLE and SIGNAL_TO_PHRASE cover the same 16 signals', () => {
  const tableKeys = Object.keys(SIGNAL_TABLE).sort();
  const phraseKeys = Object.keys(SIGNAL_TO_PHRASE).sort();
  assert.deepEqual(tableKeys, phraseKeys);
  assert.equal(tableKeys.length, 16);
});

test('deriveDeprioritize: returns empty array (rules intentionally disabled)', () => {
  assert.deepEqual(deriveDeprioritize('ml_platform', new Set(['sdk', 'platform'])), []);
  assert.deepEqual(deriveDeprioritize('backend', new Set()), []);
});

test('extractJdIntent: first-attempt success → _source = "llm"', async () => {
  const client = mockClient([
    textResp(JSON.stringify({
      primary_focus: 'Build platform tooling for ML teams',
      prefer_patterns: [
        'Backend / platform engineer with SDK design chops',
        'Distributed systems generalist with ML-platform adjacency',
        'ML infra engineer comfortable with training and serving',
      ],
    })),
  ]);
  const result = await extractJdIntent('JD mentions SDK and platform', client);
  assert.equal(result._source, 'llm');
  assert.equal(result.primary_focus, 'Build platform tooling for ML teams');
  assert.equal(result.prefer_patterns.length, 3);
  assert.deepEqual(result.deprioritize_patterns, []);
});

test('extractJdIntent: garbage then valid → _source = "llm-retry"', async () => {
  const client = mockClient([
    textResp('I think the role is... let me explain. This is not JSON.'),
    textResp(JSON.stringify({
      primary_focus: 'Build platform tooling',
      prefer_patterns: ['A', 'B', 'C'],
    })),
  ]);
  const result = await extractJdIntent('JD text', client);
  assert.equal(result._source, 'llm-retry');
  assert.equal(result.prefer_patterns.length, 3);
});

test('extractJdIntent: two garbage → _source = "deterministic-fallback" with signal-derived prefer_patterns', async () => {
  const client = mockClient([
    textResp('not json 1'),
    textResp('not json 2'),
  ]);
  const jd = 'Build an SDK for our ML platform with distributed training and model serving on Ray';
  const result = await extractJdIntent(jd, client);
  assert.equal(result._source, 'deterministic-fallback');
  assert.ok(result.prefer_patterns.length > 0, 'fallback must produce non-empty prefer_patterns');
  assert.ok(result.primary_focus.length > 0, 'fallback must produce non-empty primary_focus');
  const hasSignalPhrase = result.prefer_patterns.some(p =>
    p.includes('SDK') || p.includes('platform') || p.includes('training') || p.includes('serving') || p.includes('distributed')
  );
  assert.ok(hasSignalPhrase, `fallback prefer_patterns should include signal-derived phrases; got: ${JSON.stringify(result.prefer_patterns)}`);
});

test('extractJdIntent: thrown client error on first attempt still triggers retry then fallback', async () => {
  const client = mockClient([
    new Error('Network error'),
    new Error('Second network error'),
  ]);
  const result = await extractJdIntent('Build SDK for platform', client);
  assert.equal(result._source, 'deterministic-fallback');
});

test('extractJdIntent: no signals fired → fallback still returns non-empty prefer_patterns', async () => {
  const client = mockClient([
    textResp('garbage'),
    textResp('also garbage'),
  ]);
  const result = await extractJdIntent('A generic JD with no matching keywords', client);
  assert.equal(result._source, 'deterministic-fallback');
  assert.ok(result.prefer_patterns.length >= 1, 'fallback must not produce empty prefer_patterns even when no signals fire');
});
