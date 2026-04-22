# Intent Extraction & Scoring Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Instacart Pixel SDK regression — harden `extractJdIntent` (retry + deterministic fallback), improve `scoreBullet` (plural stemming + skills-list bonus), loosen pool truncation, expand synonym vocabulary, and add `applied_ai` archetype.

**Architecture:** Three layers of change. Scoring gains plural stemming and a per-file skills-list bonus. A deterministic 16-signal detector runs unconditionally and feeds both the LLM intent prompt (as raw material) and a fallback synthesizer (for when the LLM fails). Rules-based deprioritize is disabled (stub returns `[]`) — the LLM picker reads bullet content directly.

**Tech Stack:** Node.js (ES modules, `.mjs`), `node --test`, `@anthropic-ai/sdk`, `js-yaml`. LLM backend: MiniMax-M2.7 via Anthropic-compat endpoint (or Claude Haiku/Sonnet if `LLM_MODEL` overridden).

**Spec reference:** `docs/superpowers/specs/2026-04-22-intent-scoring-hardening-design.md` (commit `a4f8969`).

---

## File Structure

### Modified
- `assemble-core.mjs` — add `SIGNAL_TABLE`, `SIGNAL_TO_PHRASE`, `deriveSignals`, `deriveDeprioritize` (stub), `computeSkillsBonus`; modify `scoreBullet` for plural stemming.
- `assemble-llm.mjs` — rewrite `extractJdIntent` (retry + fallback + archetype-narrative prompt); add `applied_ai` to `VALID_ARCHETYPES` and `ARCHETYPE_ALIASES`; update `classifyArchetype` system prompt; update `pickBullets` prompt-builder to omit empty DEPRIORITIZE line.
- `assemble-cv.mjs` — compute per-file skills bonus in pool loop; pass `firedSignals` into extractJdIntent; record richer telemetry; loosen truncation.
- `config/synonyms.yml` — add 7 new/expanded groups.
- `config/profile.yml` — add `archetype_defaults.applied_ai`.
- `tests/assemble.scoring.test.mjs` — +5 tests (plural stem ×2, skills bonus ×3).
- `tests/e2e.assemble.test.mjs` — +1 regression-lock test (Pixel SDK).

### Created
- `tests/assemble.intent.test.mjs` — signal detection tests + extractJdIntent retry/fallback tests.
- `jds/komodo-senior-applied-ai.md` — JD fixture for manual applied_ai verification.

---

## Phase A — Scoring improvements

No network. Deterministic. Each task independently testable.

### Task A1: Expand `config/synonyms.yml`

**Files:**
- Modify: `config/synonyms.yml`

- [ ] **Step 1: Replace the existing `observability` and `mlops` groups, and append 6 new groups**

Open `config/synonyms.yml`. It currently has groups through line 34. Replace the `observability` group (currently line 28-29) and the `mlops` group (currently line 12-13) with richer versions, and append new groups at the end.

Full target file contents:

```yaml
# Synonyms for keyword scoring in assemble-cv.mjs
# Format: each entry maps a canonical term to a list of equivalent surface forms.
# Matching is case-insensitive, whole-word.

groups:
  - canonical: rag
    aliases: [rag pipeline, rag pipelines, retrieval-augmented generation, retrieval augmented generation, retrieval over embeddings]
  - canonical: llm
    aliases: [llms, large language model, large language models, foundation model, foundation models]
  - canonical: vector_db
    aliases: [vector database, vector store, embeddings store, semantic search index, pinecone, weaviate, qdrant, chroma]
  - canonical: mlops
    aliases: [ml ops, ml-ops, ml platform, ml infra, ml infrastructure, model ops, mlflow, kubeflow, sagemaker, model registry, model versioning, pipeline orchestration, experiment tracking, model monitoring, feature registry]
  - canonical: feature_store
    aliases: [feature store, feature platform, online feature serving]
  - canonical: kubernetes
    aliases: [k8s, kube]
  - canonical: ci_cd
    aliases: [ci/cd, ci cd, continuous integration, continuous delivery, continuous deployment]
  - canonical: react
    aliases: [react.js, reactjs]
  - canonical: nextjs
    aliases: [next.js, next js]
  - canonical: typescript
    aliases: [ts]
  - canonical: postgres
    aliases: [postgresql, pg]
  - canonical: observability
    aliases: [opentelemetry, grafana, prometheus, datadog, monitoring, metrics, tracing, distributed tracing, logging, alerting, slo, sli, apm, dashboard, incident response]
  - canonical: distributed_systems
    aliases: [distributed system, distributed compute, distributed training]
  - canonical: design_system
    aliases: [design systems, component library, ui library]
  - canonical: sdk
    aliases: [sdks, software development kit, client library, developer api, api client, shared library, toolkit, internal sdk, platform sdk, developer tooling]
  - canonical: platform_engineering
    aliases: [platform, internal platform, developer platform, internal tooling, shared infrastructure, self-serve platform, core infrastructure, platform team, common services, shared services, service platform, enablement]
  - canonical: training_infrastructure
    aliases: [training platform, training infra, training pipeline, training workflow, training orchestration, distributed training, gpu training, multi-gpu, multi-node training, hyperparameter tuning, hpo, fine-tuning, fine tuning]
  - canonical: model_serving
    aliases: [model serving, online inference, real-time inference, batch inference, prediction service, scoring service, serving layer, model endpoint, deployment endpoint, ray serve, torchserve, tensorflow serving, triton, vllm, seldon, bentoml]
  - canonical: experimentation
    aliases: [a/b test, a/b testing, experimentation, online experiment, offline evaluation, model evaluation, canary, shadow testing, feature flag, holdout, lift, statistical significance]
  - canonical: ai_agents
    aliases: [langchain, langgraph, rag, agentic, llm agent, tool calling, multi-agent, retrieval augmented generation, llamaindex, agent orchestration]
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `node --test tests/assemble.scoring.test.mjs`
Expected: all existing tests pass (they inject their own synonym fixtures, so they're unaffected).

- [ ] **Step 3: Commit**

```bash
git add config/synonyms.yml
git commit -m "feat(synonyms): expand with platform/SDK/serving/agent vocab"
```

---

### Task A2: Plural/singular stemming in `scoreBullet`

**Files:**
- Modify: `assemble-core.mjs:196-204`
- Test: `tests/assemble.scoring.test.mjs`

- [ ] **Step 1: Add two failing tests**

Append to `tests/assemble.scoring.test.mjs`:

```js
test('scoreBullet: plural keyword matches singular bullet token', () => {
  const bullet = 'Built a TypeScript SDK for web event tracking';
  const keywords = new Set(['sdks']);
  assert.equal(scoreBullet(bullet, keywords), 1);
});

test('scoreBullet: singular keyword matches plural bullet token', () => {
  const bullet = 'Developed APIs for payment processing';
  const keywords = new Set(['api']);
  assert.equal(scoreBullet(bullet, keywords), 1);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/assemble.scoring.test.mjs`
Expected: the two new tests FAIL with `AssertionError: 0 === 1`.

- [ ] **Step 3: Update `scoreBullet` to try plural/singular variants**

In `assemble-core.mjs`, replace the current `scoreBullet` function (lines 196-204) with:

```js
/**
 * Count the number of distinct keywords that appear in the bullet text
 * (case-insensitive, whole-phrase, with a simple plural/singular fallback).
 * If an exact match fails, try the variant with/without trailing 's'.
 * Words of length ≤ 3 do not get the variant attempt (avoids matching "is"/"as").
 */
export function scoreBullet(bulletText, keywords) {
  const lc = bulletText.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    const base = kw.toLowerCase();
    if (new RegExp(`\\b${escapeRegex(base)}\\b`).test(lc)) {
      hits++;
      continue;
    }
    let variant;
    if (base.endsWith('s') && base.length > 3) variant = base.slice(0, -1);
    else variant = base + 's';
    if (new RegExp(`\\b${escapeRegex(variant)}\\b`).test(lc)) hits++;
  }
  return hits;
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `node --test tests/assemble.scoring.test.mjs`
Expected: all tests pass (including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add assemble-core.mjs tests/assemble.scoring.test.mjs
git commit -m "feat(scoring): plural/singular stemming in scoreBullet"
```

---

### Task A3: `computeSkillsBonus` helper + wire into `assemble-cv.mjs`

**Files:**
- Modify: `assemble-core.mjs` (add `computeSkillsBonus` export)
- Modify: `assemble-cv.mjs` (import helper, apply in pool loop, record telemetry)
- Test: `tests/assemble.scoring.test.mjs`

- [ ] **Step 1: Add failing tests for `computeSkillsBonus`**

Append to `tests/assemble.scoring.test.mjs`:

```js
import { computeSkillsBonus } from '../assemble-core.mjs';

test('computeSkillsBonus: counts case-insensitive overlap capped at 3', () => {
  const skills = ['TypeScript', 'React', 'SDK design', 'Puppeteer', 'Lighthouse', 'Redis'];
  const keywords = new Set(['typescript', 'react', 'sdk design', 'puppeteer']);
  assert.equal(computeSkillsBonus(skills, keywords), 3);
});

test('computeSkillsBonus: returns 0 for empty skills list', () => {
  assert.equal(computeSkillsBonus([], new Set(['typescript'])), 0);
});

test('computeSkillsBonus: returns 0 when no overlap', () => {
  const skills = ['Go', 'Kubernetes'];
  const keywords = new Set(['typescript', 'react']);
  assert.equal(computeSkillsBonus(skills, keywords), 0);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/assemble.scoring.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../assemble-core.mjs' does not provide an export named 'computeSkillsBonus'`.

- [ ] **Step 3: Add `computeSkillsBonus` to `assemble-core.mjs`**

Append after `scoreBullet` (after the `escapeRegex` helper) in `assemble-core.mjs`:

```js
/**
 * Count the overlap between a file's `## Skills used` list and a JD keyword
 * set, capped at `cap`. Used in assemble-cv.mjs to add a per-file topical
 * bonus to every bullet from that file, so a file whose skills clearly match
 * the JD lifts all its bullets even when individual bullets lexically miss.
 */
export function computeSkillsBonus(skills, keywords, cap = 3) {
  if (!Array.isArray(skills) || skills.length === 0) return 0;
  let overlap = 0;
  for (const s of skills) {
    if (keywords.has(String(s).toLowerCase())) overlap++;
  }
  return Math.min(overlap, cap);
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `node --test tests/assemble.scoring.test.mjs`
Expected: all three new tests pass.

- [ ] **Step 5: Wire `computeSkillsBonus` into `assemble-cv.mjs`**

In `assemble-cv.mjs`, update the imports block (lines 17-21) to include `computeSkillsBonus`:

```js
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
  loadArticleDigest, computeSkillsBonus,
} from './assemble-core.mjs';
```

Then replace the per-company pool-building loop (lines 102-127 in the current file) with:

```js
  for (const dir of sortedDirs) {
    const facetFiles = sources[dir];   // ALL facets — no archetype filter
    const pool = [];
    const skillsBonusesForCompany = {};
    for (const f of facetFiles) {
      const skillsBonus = computeSkillsBonus(f.skills, keywords);
      const facetFileName = f._sourcePath.split('/').pop();
      skillsBonusesForCompany[facetFileName] = skillsBonus;
      for (const b of f.bullets) {
        const baseScore = scoreBullet(b.text, keywords);
        const score = baseScore + skillsBonus;
        if (score >= SCORE_THRESHOLD) {
          pool.push({
            text: b.text,
            sourcePath: f._sourcePath,
            sourceLine: b.lineNumber,
            facet: f.frontmatter.facet,
            score,
            _baseScore: baseScore,
            _skillsBonus: skillsBonus,
          });
        }
      }
      for (const p of f.projects) {
        allProjects.push({
          text: p.text,
          sourcePath: f._sourcePath,
          sourceLine: p.lineNumber,
          score: scoreBullet(p.text, keywords),
        });
      }
      for (const s of f.skills) allSkills.add(s);
    }
    pool.sort((a, b) => b.score - a.score);
```

Then update the `meta.companies.push(...)` call lower in the loop (currently around line 155) to include `skills_bonuses` and `top_pool_scores`:

```js
    meta.companies.push({
      dir,
      tier,
      pool_size: pool.length,
      picked: co.bullets?.length || (co.stub ? 1 : 0),
      skills_bonuses: skillsBonusesForCompany,
      top_pool_scores: pool.slice(0, 10).map(p => p.score),
    });
```

- [ ] **Step 6: Run all tests**

Run: `node --test`
Expected: all tests pass (scoreBullet signature unchanged; telemetry fields are additive; e2e tests that don't set skills on fixture files just get `skills_bonuses: {...: 0}`).

- [ ] **Step 7: Commit**

```bash
git add assemble-core.mjs assemble-cv.mjs tests/assemble.scoring.test.mjs
git commit -m "feat(scoring): per-file skills-list bonus (cap +3) with telemetry"
```

---

### Task A4: Loosen truncation

**Files:**
- Modify: `assemble-cv.mjs:150`

- [ ] **Step 1: Update the truncation constant**

In `assemble-cv.mjs`, find the line:

```js
const truncated = pool.slice(0, Math.max(n * 2, n + 2));
```

and replace with:

```js
const truncated = pool.slice(0, Math.max(n * 4, 15));
```

- [ ] **Step 2: Run all tests**

Run: `node --test`
Expected: all pass. E2E tests may now pass more bullets to the mock LLM, but the mock just takes the first N and is unaffected.

- [ ] **Step 3: Commit**

```bash
git add assemble-cv.mjs
git commit -m "feat(scoring): loosen truncation to max(n*4, 15) so LLM sees more pool"
```

---

## Phase B — Signal detection

Deterministic, no network.

### Task B1: Add `SIGNAL_TABLE`, `SIGNAL_TO_PHRASE`, `deriveSignals`, `deriveDeprioritize`

**Files:**
- Modify: `assemble-core.mjs` (append new exports)
- Create: `tests/assemble.intent.test.mjs`

- [ ] **Step 1: Create `tests/assemble.intent.test.mjs` with signal-detection tests**

Create `tests/assemble.intent.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSignals, deriveDeprioritize, SIGNAL_TABLE, SIGNAL_TO_PHRASE } from '../assemble-core.mjs';

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
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/assemble.intent.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../assemble-core.mjs' does not provide an export named 'deriveSignals'`.

- [ ] **Step 3: Append signal table + functions to `assemble-core.mjs`**

Append to `assemble-core.mjs` (after `loadArticleDigest`):

```js
// ── Signal detection ────────────────────────────────────────────────

/**
 * Signal detection table — deterministic regex over a curated vocabulary.
 * Used by extractJdIntent (as raw material for the LLM prompt and as a
 * fallback source when the LLM call fails twice), and by
 * .cv-tailored-meta.json telemetry.
 *
 * Each entry maps a signal name to a list of case-insensitive aliases.
 * Aliases are matched with word-boundary regex. Signals fire independently.
 *
 * Design note: "library" and "framework" were intentionally excluded from
 * `sdk` to avoid false positives on "PyTorch framework" / "React library".
 * A genuine SDK JD uses "SDK", "client library", "platform SDK" etc.
 */
export const SIGNAL_TABLE = {
  sdk:            ['sdk', 'sdks', 'software development kit', 'client library', 'developer api', 'api client', 'shared library', 'toolkit', 'internal sdk', 'service sdk', 'platform sdk', 'developer tooling'],
  platform:       ['platform', 'internal tooling', 'developer platform', 'infra', 'infrastructure', 'shared infrastructure', 'self-serve platform', 'internal platform', 'enablement', 'foundational', 'core infrastructure', 'platform team', 'common services', 'shared services', 'service platform'],
  feature_store:  ['feature store', 'feature platform', 'online feature serving', 'offline feature store', 'feature pipeline', 'feature computation', 'feature generation', 'feature materialization', 'feature registry', 'feature retrieval', 'feature serving', 'feature freshness', 'tecton', 'feast'],
  training_infra: ['training platform', 'training infra', 'distributed training', 'fine-tuning', 'fine tuning', 'model training', 'training pipeline', 'training workflow', 'training orchestration', 'ml training', 'pytorch lightning', 'horovod', 'kubeflow', 'airflow', 'sagemaker training', 'gpu training', 'multi-gpu', 'multi-node training', 'distributed optimizer', 'hyperparameter tuning', 'hpo'],
  serving:        ['model serving', 'inference', 'batch inference', 'online inference', 'real-time inference', 'prediction service', 'scoring service', 'serving layer', 'model endpoint', 'deployment endpoint', 'ray', 'ray serve', 'torchserve', 'tensorflow serving', 'triton', 'vllm', 'seldon', 'bentoml'],
  distributed:    ['distributed systems', 'high throughput', 'large-scale systems', 'stream processing', 'real-time pipeline', 'kafka', 'flink', 'spark', 'beam', 'mapreduce', 'pub/sub', 'kinesis', 'distributed queue', 'event-driven', 'message queue', 'streaming', 'backpressure', 'partitioning', 'sharding', 'replication', 'concurrency'],
  applied_ml:     ['train models', 'model development', 'feature engineering', 'ml engineer', 'machine learning engineer', 'applied scientist', 'research engineer', 'research', 'model experimentation', 'offline evaluation', 'precision', 'recall', 'auc', 'f1', 'ranking model', 'classification model', 'fraud model', 'recommendation model', 'xgboost', 'lightgbm', 'catboost', 'scikit-learn', 'pytorch', 'tensorflow'],
  frontend:       ['react', 'vue', 'ui', 'frontend', 'component library', 'design system', 'next.js', 'redux', 'zustand', 'pinia', 'tailwind', 'ant design', 'material ui', 'storybook', 'web app', 'dashboard', 'internal tools ui', 'operator console'],
  agents:         ['langchain', 'langgraph', 'rag', 'agentic', 'llm agent', 'tool calling', 'multi-agent', 'retrieval augmented generation', 'vector search', 'vector database', 'prompt engineering', 'openai', 'anthropic', 'gemini', 'llamaindex', 'pinecone', 'weaviate', 'faiss', 'milvus'],
  backend:        ['go', 'golang', 'java', 'spring boot', 'python', 'node.js', 'rest api', 'grpc', 'rpc', 'microservices', 'service-oriented architecture', 'backend services', 'api design', 'distributed backend'],
  data_storage:   ['mysql', 'postgresql', 'redis', 'cassandra', 'dynamodb', 'bigtable', 'elasticsearch', 'mongodb', 'data warehouse', 'hive', 'snowflake', 'bigquery', 'delta lake', 'iceberg', 'hbase', 'oltp', 'olap'],
  cloud_infra:    ['aws', 'ec2', 'eks', 's3', 'emr', 'lambda', 'gcp', 'gke', 'azure', 'kubernetes', 'docker', 'containerization', 'terraform', 'helm', 'infrastructure as code', 'cloud infrastructure'],
  observability:  ['opentelemetry', 'grafana', 'prometheus', 'datadog', 'monitoring', 'metrics', 'tracing', 'distributed tracing', 'logging', 'alerting', 'slo', 'sli', 'apm', 'incident response'],
  cicd:           ['ci/cd', 'continuous integration', 'continuous deployment', 'github actions', 'jenkins', 'build pipeline', 'deployment pipeline', 'release pipeline', 'argocd', 'circleci', 'gitlab ci'],
  experimentation:['a/b test', 'a/b testing', 'experimentation', 'online experiment', 'offline evaluation', 'model evaluation', 'canary', 'shadow testing', 'feature flag', 'holdout', 'lift', 'statistical significance'],
  mlops:          ['mlops', 'ml platform', 'model registry', 'model versioning', 'pipeline orchestration', 'mlflow', 'kubeflow', 'sagemaker', 'feature registry', 'experiment tracking', 'model monitoring'],
};

/**
 * Signal-to-phrase mapping — used by the deterministic fallback path in
 * extractJdIntent when the LLM call fails twice. Produces prefer_patterns
 * entries from fired signals (lower quality than LLM-generated narratives,
 * but keeps the pipeline producing real intent).
 */
export const SIGNAL_TO_PHRASE = {
  sdk: 'SDK / client library design',
  platform: 'internal platform ownership',
  feature_store: 'feature store / feature platform',
  training_infra: 'distributed training infrastructure',
  serving: 'model serving / inference platform',
  distributed: 'distributed systems at scale',
  applied_ml: 'ML modeling and training',
  frontend: 'UI / design system work',
  agents: 'LLM agent / RAG systems',
  backend: 'backend services and APIs',
  data_storage: 'data storage and warehousing',
  cloud_infra: 'cloud infrastructure',
  observability: 'observability and monitoring',
  cicd: 'CI/CD and release infrastructure',
  experimentation: 'experimentation and A/B testing',
  mlops: 'MLOps and pipeline orchestration',
};

/**
 * Detect which signals fire in a JD.
 * @param {string} jdText
 * @returns {Set<string>} names of fired signals from SIGNAL_TABLE
 */
export function deriveSignals(jdText) {
  const lc = (jdText || '').toLowerCase();
  const fired = new Set();
  for (const [name, aliases] of Object.entries(SIGNAL_TABLE)) {
    for (const alias of aliases) {
      const re = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (re.test(lc)) {
        fired.add(name);
        break; // one alias is enough
      }
    }
  }
  return fired;
}

/**
 * Build deprioritize_patterns from role_type + fired signals. Currently
 * returns [] — rules-based deprioritize was disabled because it blocks
 * bullets on narrative framing (e.g. "compliance theme") while ignoring
 * the actual skill content inside (Airflow, Spark, distributed processing).
 * The LLM picker reads bullet content + JD directly and makes better
 * judgments without this layer. See spec §4.4.
 *
 * Reference rules (uncomment to activate for a specific role_type if the
 * picker keeps off-target bullets for that archetype):
 *
 *   if (role_type === 'ml_platform') {
 *     if (!firedSignals.has('applied_ml')) d.push('applied ML modeling', 'research-style ML work');
 *     if (!firedSignals.has('frontend'))   d.push('pure frontend');
 *   }
 *   if (role_type === 'infra') {
 *     if (!firedSignals.has('applied_ml')) d.push('applied ML modeling');
 *     if (!firedSignals.has('agents'))     d.push('agent / LangChain prototypes');
 *     if (!firedSignals.has('frontend'))   d.push('pure frontend');
 *   }
 *   if (role_type === 'backend') {
 *     if (!firedSignals.has('applied_ml')) d.push('applied ML modeling');
 *     if (!firedSignals.has('frontend'))   d.push('pure frontend');
 *     if (!firedSignals.has('agents'))     d.push('agent / LangChain prototypes');
 *   }
 *   if (role_type === 'frontend') {
 *     if (!firedSignals.has('distributed')) d.push('distributed systems work');
 *     if (!firedSignals.has('applied_ml'))  d.push('applied ML modeling');
 *   }
 */
export function deriveDeprioritize(role_type, firedSignals) {
  void role_type; void firedSignals;
  return [];
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `node --test tests/assemble.intent.test.mjs`
Expected: all 6 tests pass.

- [ ] **Step 5: Run full test suite to catch any regressions**

Run: `node --test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add assemble-core.mjs tests/assemble.intent.test.mjs
git commit -m "feat(intent): deriveSignals + 16-signal table + deriveDeprioritize stub"
```

---

## Phase C — Intent extraction overhaul

### Task C1: Update `pickBullets` prompt-builder to omit empty DEPRIORITIZE

**Files:**
- Modify: `assemble-llm.mjs:215-224`

- [ ] **Step 1: Replace the `intentBlock` construction**

In `assemble-llm.mjs`, find the `intentBlock` assignment inside `pickBullets` (currently around lines 215-224) and replace:

```js
  const intentBlock = intent && (intent.primary_focus || intent.prefer_patterns?.length || intent.deprioritize_patterns?.length)
    ? `\n\nROLE INTENT (use this to filter the pool):
- Role type: ${intent.role_type || 'unknown'}
- What they actually want: ${intent.primary_focus || '(not extracted)'}
- PREFER bullets about: ${(intent.prefer_patterns || []).join(', ') || '(none specified)'}
- DEPRIORITIZE bullets about: ${(intent.deprioritize_patterns || []).join(', ') || '(none specified)'}

When picking, favor bullets in the PREFER list even if their raw keyword match is slightly lower. Avoid bullets in the DEPRIORITIZE list unless no alternative exists.\n`
    : '';
```

with:

```js
  let intentBlock = '';
  if (intent && (intent.primary_focus || intent.prefer_patterns?.length || intent.deprioritize_patterns?.length)) {
    const lines = [
      '',
      '',
      'ROLE INTENT (use this to filter the pool):',
      `- Role type: ${intent.role_type || 'unknown'}`,
      `- What they actually want: ${intent.primary_focus || '(not extracted)'}`,
      `- PREFER bullets about: ${(intent.prefer_patterns || []).join(', ') || '(none specified)'}`,
    ];
    const hasDeprio = Array.isArray(intent.deprioritize_patterns) && intent.deprioritize_patterns.length > 0;
    if (hasDeprio) {
      lines.push(`- DEPRIORITIZE bullets about: ${intent.deprioritize_patterns.join(', ')}`);
    }
    lines.push('');
    lines.push(hasDeprio
      ? 'When picking, favor bullets in the PREFER list even if their raw keyword match is slightly lower. Avoid bullets in the DEPRIORITIZE list unless no alternative exists.'
      : 'When picking, favor bullets in the PREFER list even if their raw keyword match is slightly lower.');
    lines.push('');
    intentBlock = lines.join('\n');
  }
```

- [ ] **Step 2: Run the full test suite**

Run: `node --test`
Expected: all tests pass. (`pickBullets` has no direct unit test, but the e2e tests exercise it.)

- [ ] **Step 3: Commit**

```bash
git add assemble-llm.mjs
git commit -m "refactor(pickBullets): omit DEPRIORITIZE line when list is empty"
```

---

### Task C2: Rewrite `extractJdIntent` with retry + deterministic fallback

**Files:**
- Modify: `assemble-llm.mjs:105-159`
- Test: `tests/assemble.intent.test.mjs` (append)

- [ ] **Step 1: Add failing tests for the new extractJdIntent behavior**

Append to `tests/assemble.intent.test.mjs`:

```js
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
  // Sanity check: fallback phrases should include at least one signal-derived phrase
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
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/assemble.intent.test.mjs`
Expected: FAIL. The current `extractJdIntent` doesn't return `_source`, doesn't retry, and returns `{role_type: 'unknown', ...}` on failure.

- [ ] **Step 3: Replace `extractJdIntent` in `assemble-llm.mjs`**

First, update the imports at the top of `assemble-llm.mjs` (line 14) to also import from core:

```js
import { Anthropic } from '@anthropic-ai/sdk';
import { deriveSignals, SIGNAL_TO_PHRASE } from './assemble-core.mjs';
```

Then replace the entire `extractJdIntent` function (currently lines 105-159, including the JSDoc block) with:

```js
// ── LLM-facing functions ────────────────────────────────────────────

/**
 * Extract structured role intent from a JD. Returns engineer-archetype
 * narratives in prefer_patterns (e.g. "Backend engineer with ML-platform
 * adjacency"), not topic tags.
 *
 * Hardened with retry + deterministic fallback:
 *   1. First LLM attempt with the standard prompt.
 *   2. On parse failure OR thrown error, retry once with a stricter
 *      JSON-only reprompt.
 *   3. On second failure, synthesize prefer_patterns from fired signals
 *      (never silently returns empty).
 *
 * The `_source` field records which path produced the result
 * ("llm" | "llm-retry" | "deterministic-fallback") and is logged in
 * .cv-tailored-meta.json for debuggability.
 *
 * @returns {Promise<{primary_focus, prefer_patterns, deprioritize_patterns, _source}>}
 */
export async function extractJdIntent(jdText, client = defaultClient()) {
  const firedSignals = deriveSignals(jdText);
  const firedList = [...firedSignals].join(', ') || '(none detected)';

  const basePrompt = `Given this JD, describe the engineer archetype the team is actually hunting for.

Output EXACTLY this JSON, no prose, no markdown fences:

{
  "primary_focus": "<one sentence: what they actually want>",
  "prefer_patterns": [
    "<engineer archetype description #1>",
    "<engineer archetype description #2>",
    "<engineer archetype description #3>"
  ]
}

Each prefer_patterns entry describes a WHOLE engineer profile in one phrase —
not a topic tag. Three entries, no more, no less.

Good examples:
- "Backend / Infra engineer with strong ML-platform adjacency"
- "Platform-minded engineer who has built data pipelines, experimentation, and production systems for intelligent decisioning"
- "ML infrastructure engineer focused on distributed training and serving at scale"

Bad examples (do NOT emit — too narrow):
- "SDK design"
- "Kubernetes"
- "Python experience"

FIRED SIGNALS: ${firedList}

JD:
${jdText.slice(0, 4000)}`;

  // Attempt 1
  try {
    const response = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 600,
      system: 'You analyze job descriptions to extract the role\'s true nature. Output a single valid JSON object and nothing else. No prose, no markdown fences.',
      messages: [{ role: 'user', content: basePrompt }],
    });
    const raw = extractResponseText(response);
    const parsed = extractJson(raw);
    if (parsed && parsed.primary_focus && Array.isArray(parsed.prefer_patterns) && parsed.prefer_patterns.length > 0) {
      return {
        primary_focus: parsed.primary_focus,
        prefer_patterns: parsed.prefer_patterns,
        deprioritize_patterns: [],
        _source: 'llm',
      };
    }
    console.error('[extractJdIntent] parse failure, retrying with strict reprompt');
  } catch (err) {
    console.error(`[extractJdIntent] first attempt threw: ${err.message}; retrying`);
  }

  // Attempt 2 (strict reprompt)
  try {
    const response = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 600,
      system: 'You analyze job descriptions. Output ONLY a single valid JSON object. No markdown. No prose. No explanation.',
      messages: [{
        role: 'user',
        content: basePrompt + '\n\nYour previous response did not parse as JSON. Output ONLY the JSON object. No markdown, no prose, no explanation.',
      }],
    });
    const raw = extractResponseText(response);
    const parsed = extractJson(raw);
    if (parsed && parsed.primary_focus && Array.isArray(parsed.prefer_patterns) && parsed.prefer_patterns.length > 0) {
      return {
        primary_focus: parsed.primary_focus,
        prefer_patterns: parsed.prefer_patterns,
        deprioritize_patterns: [],
        _source: 'llm-retry',
      };
    }
  } catch (err) {
    console.error(`[extractJdIntent] retry threw: ${err.message}`);
  }

  // Deterministic fallback
  console.error('[extractJdIntent] LLM failed twice, using deterministic fallback');
  const phrases = [...firedSignals].map(s => SIGNAL_TO_PHRASE[s]).filter(Boolean);
  const preferPatterns = phrases.length > 0 ? phrases : ['general software engineering work'];
  const primary = phrases.length > 0
    ? `Role focused on ${phrases.slice(0, 2).join(' and ')}`
    : 'General software engineering role';
  return {
    primary_focus: primary,
    prefer_patterns: preferPatterns,
    deprioritize_patterns: [],
    _source: 'deterministic-fallback',
  };
}
```

- [ ] **Step 4: Run intent tests and verify they pass**

Run: `node --test tests/assemble.intent.test.mjs`
Expected: all 11 tests pass (6 signal + 5 intent).

- [ ] **Step 5: Run full test suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add assemble-llm.mjs tests/assemble.intent.test.mjs
git commit -m "feat(intent): hardened extractJdIntent — retry + deterministic fallback"
```

---

## Phase D — `applied_ai` archetype

### Task D1: Save Komodo JD as fixture

**Files:**
- Create: `jds/komodo-senior-applied-ai.md`

- [ ] **Step 1: Create the JD fixture file**

Create `jds/komodo-senior-applied-ai.md` with the following content:

```markdown
# Senior Applied AI Engineer

Company: Komodo Health
Location: NYC or SF hybrid, and remote
Source: LinkedIn
Compensation: $230,000-$270,000 USD (Bay Area/NYC) / $200,000-$235,000 USD (other US)

## About the Role

At Komodo Health, we're building AI-native infrastructure — systems that make AI reliable, scalable, and deeply embedded into how products are built and used. We're hiring Senior Applied AI Engineers to join a newly formed AI Platform / Observability team focused on building the foundation that makes AI systems trustworthy at scale. This is a backend-heavy, systems-focused role in a greenfield environment.

Your starting point will be AI observability, evaluation, and production reliability. From there, your scope expands into broader platform ownership: agent systems, orchestration layers, and shared infrastructure.

## What You'll Build (First 12 Months)

- Build the observability and reliability foundation for AI systems across Komodo (logging, tracing, evaluation pipelines, feedback loops)
- Define how the organization measures LLM performance and quality in production (hallucinations, drift, latency, failure modes)
- Ship production-grade AI systems that improve platform reliability, scalability, and performance
- Lead design and architecture for complex applied AI systems (multi-agent workflows, tool-calling systems, model pipelines)
- Establish evaluation frameworks and experimentation practices (A/B testing, offline + online evaluation)
- Contribute to reusable infrastructure, patterns, and standards adopted across teams

## What You'll Own

### AI Observability & Reliability (Initial Focus)

Design and implement:
- Logging, tracing, and request visibility for LLM systems
- Evaluation pipelines and benchmarking frameworks
- Feedback loops for continuous system improvement

Define metrics for:
- Output quality and correctness
- Latency and system performance
- Tool usage and agent behavior

Detect and debug: hallucinations, model drift and system degradation, failure modes.

### Applied AI Systems & Platform (Expanded Scope)

- Architect and deploy end-to-end AI systems: agent-based workflows, prompt chains and tool integrations, and scalable LLM-powered services
- Transition prototypes into reliable, production-grade systems
- Contribute to shared AI infrastructure and orchestration patterns
- Partner with product, data, and platform teams to shape AI-driven solutions

## Required

- Experience building production AI systems end-to-end (not just prototypes)
- Strong expertise with LLMs and prompt systems and agent orchestration and tool/function calling
- Hands-on experience with: AI observability, evaluation, or monitoring systems; debugging and improving production AI behavior
- Strong backend engineering skills: Python, APIs, distributed systems, or platform architecture
- Experience designing evaluation frameworks and experiments (A/B testing, benchmarking)
- Ability to operate in ambiguous, fast-moving environments

## Nice to Have

- Healthcare data expertise
- Experience with distributed computing frameworks (e.g., Spark, Snowflake, Databricks) for large-scale data processing
- Experience building internal observability platforms and LLM evaluation or monitoring systems
- Familiarity with request tracing, replay systems, or model diagnostics
```

- [ ] **Step 2: Commit**

```bash
git add jds/komodo-senior-applied-ai.md
git commit -m "fixture: Komodo Senior Applied AI Engineer JD"
```

---

### Task D2: Add `applied_ai` to archetype list and aliases

**Files:**
- Modify: `assemble-llm.mjs:24-33` (VALID_ARCHETYPES + ARCHETYPE_ALIASES)

- [ ] **Step 1: Update `VALID_ARCHETYPES` and `ARCHETYPE_ALIASES`**

In `assemble-llm.mjs`, find the `VALID_ARCHETYPES` constant (line 24) and replace:

```js
const VALID_ARCHETYPES = ['frontend', 'backend', 'infra', 'machine_learning', 'ml_platform', 'fullstack'];
```

with:

```js
const VALID_ARCHETYPES = ['frontend', 'backend', 'infra', 'machine_learning', 'ml_platform', 'applied_ai', 'fullstack'];
```

Then find `ARCHETYPE_ALIASES` (lines 26-33) and add an `applied_ai` entry. Full updated constant:

```js
const ARCHETYPE_ALIASES = {
  ml_platform:      ['ml platform', 'ml/ai platform', 'ml infra', 'mlops', 'ml infrastructure', 'ai platform', 'model serving', 'feature store', 'training platform', 'ml platform engineer'],
  applied_ai:       ['applied ai', 'applied ai engineer', 'ai engineer', 'ai systems engineer', 'llm engineer', 'ai platform engineer', 'production ai', 'agent engineer', 'applied llm'],
  machine_learning: ['machine_learning', 'machine learning', 'machine-learning', 'ml/ai', 'ai/ml', 'ml engineer', 'ml engineering', 'applied ml', 'ml researcher', 'ai researcher'],
  frontend:         ['frontend', 'front-end', 'front end', 'ui engineer', 'client-side'],
  backend:          ['backend', 'back-end', 'back end', 'server-side'],
  infra:            ['infra', 'infrastructure', 'devops', 'sre', 'platform engineer', 'site reliability', 'data platform', 'data infrastructure'],
  fullstack:        ['fullstack', 'full-stack', 'full stack'],
};
```

- [ ] **Step 2: Run tests**

Run: `node --test`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-llm.mjs
git commit -m "feat(archetype): add applied_ai to valid archetypes and aliases"
```

---

### Task D3: Update `classifyArchetype` system prompt to include `applied_ai`

**Files:**
- Modify: `assemble-llm.mjs:161-175` (classifyArchetype function)

- [ ] **Step 1: Update the system prompt and user prompt of `classifyArchetype`**

In `assemble-llm.mjs`, find the `classifyArchetype` function (currently lines 161-193) and replace the `system` and `user` content (the parts inside `client.messages.create(...)` through the user message template):

Replace:

```js
export async function classifyArchetype(jdText, client = defaultClient()) {
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 50,
    system: 'You are a strict classifier. Output EXACTLY one word from this list and NOTHING ELSE: frontend, backend, infra, machine_learning, fullstack. No explanation, no reasoning, no punctuation, no quotes, no markdown.',
    messages: [{
      role: 'user',
      content: `Classify this JD into exactly one of: frontend, backend, infra, machine_learning, fullstack.

Output ONLY the single word. Do not explain.

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
```

with:

```js
export async function classifyArchetype(jdText, client = defaultClient()) {
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 50,
    system: 'You are a strict classifier. Output EXACTLY one word from this list and NOTHING ELSE: frontend, backend, infra, machine_learning, ml_platform, applied_ai, fullstack. No explanation, no reasoning, no punctuation, no quotes, no markdown.',
    messages: [{
      role: 'user',
      content: `Classify this JD into exactly one of:

- frontend — UI, web, design systems
- backend — product-side APIs, services, distributed systems
- infra — platform engineering, SRE, devops, data platform
- machine_learning — builds/trains ML models, applied ML, research
- ml_platform — builds infra/SDKs/tooling FOR ML teams (not models)
- applied_ai — builds production AI/LLM/agent SYSTEMS end-to-end (ships AI products, not models)
- fullstack — balanced FE+BE product engineering

Key distinctions:
- machine_learning = trains models
- ml_platform = builds the platform ML teams use to train/serve models
- applied_ai = ships LLM/agent products with observability, evaluation, tool-calling

Output ONLY the single word. Do not explain.

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
```

- [ ] **Step 2: Run tests**

Run: `node --test`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add assemble-llm.mjs
git commit -m "feat(archetype): distinguish machine_learning / ml_platform / applied_ai in classifier prompt"
```

---

### Task D4: Add `applied_ai` to `archetype_defaults`

**Files:**
- Modify: `config/profile.yml:89-93` (archetype_defaults)

- [ ] **Step 1: Add `applied_ai` entry**

In `config/profile.yml`, find the `archetype_defaults` block (currently lines 88-93) and update it to:

```yaml
archetype_defaults:
  frontend:         { top_bullets_full: 4, top_projects: 3 }
  backend:          { top_bullets_full: 5, top_projects: 4 }
  infra:            { top_bullets_full: 5, top_projects: 4 }
  machine_learning: { top_bullets_full: 4, top_projects: 3 }
  ml_platform:      { top_bullets_full: 5, top_projects: 4 }
  applied_ai:       { top_bullets_full: 4, top_projects: 3 }
  fullstack:        { top_bullets_full: 5, top_projects: 4 }
```

(Also add `ml_platform` if missing — it's referenced in `assemble-cv.mjs` line 148 but wasn't in the defaults map; the fallback of 4 is what gets used today.)

- [ ] **Step 2: Verify assemble still runs on a sample JD**

Run: `node --test`
Expected: all tests pass. The test fixture `__fixtures__/profile.yml` is separate from `config/profile.yml` and unaffected by this change.

- [ ] **Step 3: Commit**

```bash
git add config/profile.yml
git commit -m "feat(archetype): add applied_ai and ml_platform to archetype_defaults"
```

---

## Phase E — Integration: wire new intent into `assemble-cv.mjs` + telemetry

### Task E1: Wire `deriveSignals` + new `extractJdIntent` into `assemble-cv.mjs`

**Files:**
- Modify: `assemble-cv.mjs` (imports + orchestration + telemetry)

- [ ] **Step 1: Update imports**

In `assemble-cv.mjs`, update the imports block (lines 17-24):

```js
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
  loadArticleDigest, computeSkillsBonus, deriveSignals,
} from './assemble-core.mjs';
import {
  defaultClient, classifyArchetype, pickBullets, extractJdIntent,
} from './assemble-llm.mjs';
```

- [ ] **Step 2: Update the intent-extraction call and logging**

In `assemble-cv.mjs`, find the intent-extraction section (currently lines 75-79) which reads:

```js
  // 1b. Extract JD intent — used to steer bullet picking beyond keyword scoring
  const intent = await extractJdIntent(jdText);
  meta.intent = intent;
  console.error(`[assemble-cv] JD intent: role_type=${intent.role_type}, focus="${intent.primary_focus}"`);
  if (intent.prefer_patterns?.length) console.error(`  PREFER: ${intent.prefer_patterns.join(' | ')}`);
  if (intent.deprioritize_patterns?.length) console.error(`  DEPRIORITIZE: ${intent.deprioritize_patterns.join(' | ')}`);
```

and replace with:

```js
  // 1b. Detect signals deterministically (always runs, used as raw material
  //     for the LLM intent prompt AND as the fallback source on LLM failure)
  const firedSignals = deriveSignals(jdText);
  meta.fired_signals = [...firedSignals];
  console.error(`[assemble-cv] Fired signals: ${[...firedSignals].join(', ') || '(none)'}`);

  // 1c. Extract JD intent — engineer-archetype narratives via LLM with retry
  //     and deterministic fallback. role_type is filled from classifyArchetype
  //     below since this call focuses on narrative quality, not classification.
  const intentRaw = await extractJdIntent(jdText);
  const intent = { ...intentRaw, role_type: archetype };
  meta.intent = intent;
  console.error(`[assemble-cv] Intent source: ${intent._source}; role_type=${intent.role_type}`);
  console.error(`  focus: "${intent.primary_focus}"`);
  if (intent.prefer_patterns?.length) console.error(`  PREFER: ${intent.prefer_patterns.join(' | ')}`);
  if (intent.deprioritize_patterns?.length) console.error(`  DEPRIORITIZE: ${intent.deprioritize_patterns.join(' | ')}`);
```

- [ ] **Step 3: Run all tests**

Run: `node --test`
Expected: all tests pass. (The e2e test uses a mock client that returns JSON for the intent call — see Task E2 for the fixture update.)

- [ ] **Step 4: Commit**

```bash
git add assemble-cv.mjs
git commit -m "feat(assemble-cv): wire deriveSignals + hardened extractJdIntent + telemetry"
```

---

### Task E2: Update the e2e mock client to handle the new intent prompt

**Files:**
- Modify: `tests/e2e.assemble.test.mjs:14-40` (mockClient)

- [ ] **Step 1: Update `mockClient` to recognize the new intent prompt**

In `tests/e2e.assemble.test.mjs`, update the `mockClient` function (lines 14-40) to also handle the new intent-extraction prompt:

```js
function mockClient(archetypeAnswer) {
  return {
    messages: {
      create: async ({ messages }) => {
        const userText = messages[0].content;
        if (/Classify this JD/.test(userText)) {
          return { content: [{ text: archetypeAnswer }] };
        }
        if (/describe the engineer archetype/.test(userText)) {
          return { content: [{ text: JSON.stringify({
            primary_focus: 'Test role focused on mock work',
            prefer_patterns: [
              'Test engineer with general skills',
              'Generalist engineer for testing',
              'Engineer comfortable with test fixtures',
            ],
          }) }] };
        }
        if (/Pick the (\d+) bullets/.test(userText)) {
          const n = Number(userText.match(/Pick the (\d+) bullets/)[1]);
          const bulletsBlock = userText.split('BULLETS:')[1].trim();
          const lines = bulletsBlock.split('\n').filter(l => /^\d+(?:\s+\[[^\]]+\])?:/.test(l));
          const selected = lines.slice(0, n).map(l => {
            const match = l.match(/^(\d+)(?:\s+\[[^\]]+\])?:\s*(.*)$/);
            return { index: Number(match[1]), text: match[2].trim() };
          });
          return { content: [{ text: JSON.stringify({ selected }) }] };
        }
        if (/Professional Summary/.test(userText)) {
          return { content: [{ text: 'Mock summary for testing.' }] };
        }
        throw new Error(`mockClient: unrecognized prompt: ${userText.slice(0, 120)}`);
      },
    },
  };
}
```

- [ ] **Step 2: Run e2e tests**

Run: `node --test tests/e2e.assemble.test.mjs`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.assemble.test.mjs
git commit -m "test(e2e): mockClient handles new intent prompt + facet-tagged bullets"
```

---

### Task E3: Regression-lock the Instacart Pixel SDK fix

**Files:**
- Create: `jds/instacart-senior-engineer-ml-ai-platform.md` (may already exist — verify)
- Modify: `tests/e2e.assemble.test.mjs` (append new test)

- [ ] **Step 1: Verify the Instacart JD exists, or create it**

Check if `jds/instacart-senior-engineer-ml-ai-platform.md` exists. Run:

```bash
ls jds/instacart-senior-engineer-ml-ai-platform.md
```

If it exists, skip to Step 2. If not, create it with:

```markdown
# Senior Engineer, ML/AI Platform

Company: Instacart
Location: Remote (Flex First, US)
Source: LinkedIn
Compensation: $192,000 – $242,000 USD (location-dependent)

## About the Role

As a Senior Engineer on the ML/AI platform team, you will play a key role in building the internal platform which supports training and deploying AI models across the entire organization. You'll take ownership of defining the platform to enable AI model fine-tuning and batch inference by building the SDKs and supporting the infra to support these unique workloads.

## About the Team

At Instacart, the ML/AI Platform team is a critical part of enabling the business across all areas. From owning the online/offline feature store to the serving and training layer, our team enables the entire business to succeed.

## About the Job

- Excited to build platform-level tools, SDKs
- Ability to manage cross-cutting stakeholder relationships

## Minimum Qualifications

- Bachelor's degree in Computer Science
- 3 years of experience with software development
- 2 years of experience in designing, analyzing, and troubleshooting large-scale distributed systems
- Experience with high scale throughput and distributed systems problems

## Preferred Qualifications

- Expertise building platforms and high scale infrastructure
- Prior experience working with AI Platforms like Ray is a plus
```

- [ ] **Step 2: Add a regression-lock test to `tests/e2e.assemble.test.mjs`**

First, expand the top-level import block in `tests/e2e.assemble.test.mjs` to include the two new functions:

```js
import {
  loadConfig, loadAllSources, validateConsistency, sortCompanies,
  extractKeywords, expandSynonyms, scoreBullet, assignTier, renderTailored,
  computeSkillsBonus, deriveSignals,
} from '../assemble-core.mjs';
```

Then append to the same file:

```js
test('e2e regression: Instacart ML/AI Platform JD surfaces Pixel SDK bullet', async () => {
  // This test locks the fix for the Pixel SDK regression — on the Instacart
  // ML/AI Platform JD, the TikTok Pixel SDK bullet (score 3 on exact match)
  // was being truncated out of the pool before the LLM saw it. Fix combines:
  // plural stemming, per-file skills bonus, looser truncation, expanded synonyms.
  //
  // Uses the REAL config + experience_source (not fixtures) because the bug
  // depends on the actual bullet counts and frontmatter structure. LLM is
  // still mocked — we verify the pool contains Pixel SDK and the mock picks it.
  const jdPath = resolve(__dirname, '../jds/instacart-senior-engineer-ml-ai-platform.md');
  const jdText = readFileSync(jdPath, 'utf-8');
  const sourcesRoot = resolve(__dirname, '../experience_source');
  const sources = loadAllSources(sourcesRoot);

  let keywords = extractKeywords(jdText);
  keywords = expandSynonyms(keywords, resolve(__dirname, '../config/synonyms.yml'));

  // Build the TikTok pool with the new scoring logic
  const tiktokFiles = sources['tiktok-us'];
  assert.ok(tiktokFiles, 'experience_source/tiktok-us must exist for this regression test');
  const pool = [];
  for (const f of tiktokFiles) {
    const skillsBonus = computeSkillsBonus(f.skills, keywords);
    for (const b of f.bullets) {
      const baseScore = scoreBullet(b.text, keywords);
      const score = baseScore + skillsBonus;
      if (score >= 1) pool.push({ text: b.text, score });
    }
  }
  pool.sort((a, b) => b.score - a.score);

  // With truncation = max(n*4, 15) and n=4, top 16 bullets go to LLM
  const truncated = pool.slice(0, Math.max(4 * 4, 15));
  const hasPixelSdk = truncated.some(b =>
    /(pixel sdk|signal[- ]collection (platform|sdk))/i.test(b.text)
  );
  assert.ok(hasPixelSdk,
    `Pixel SDK bullet must reach the LLM pool (top 16 of ${pool.length}). Top 5 by score:\n` +
    truncated.slice(0, 5).map(b => `  [${b.score}] ${b.text.slice(0, 80)}`).join('\n')
  );

  // Also verify signal detection fires correctly on this JD
  const signals = deriveSignals(jdText);
  assert.ok(signals.has('sdk'), 'sdk signal must fire on Instacart JD');
  assert.ok(signals.has('platform'), 'platform signal must fire on Instacart JD');
});
```

- [ ] **Step 3: Run the new test**

Run: `node --test tests/e2e.assemble.test.mjs`
Expected: the new test passes. If it fails, the scoring changes did not combine to get Pixel SDK into the top 16. Inspect the "Top 5 by score" output and debug.

- [ ] **Step 4: Run full test suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add jds/instacart-senior-engineer-ml-ai-platform.md tests/e2e.assemble.test.mjs
git commit -m "test(e2e): regression-lock Pixel SDK reaching LLM pool on Instacart JD"
```

---

### Task E4: Manual verification runs (Instacart + Komodo)

**Files:**
- Runtime verification only, no code changes.

This task verifies that the full pipeline (including the live LLM) produces the expected output on two representative JDs. It's not in automated CI but should be run once before calling the work done.

- [ ] **Step 1: Run assemble on Instacart JD**

```bash
node assemble-cv.mjs --jd=jds/instacart-senior-engineer-ml-ai-platform.md
```

Expected stdout (the final JSON summary):
```json
{
  "ok": true,
  "output": "/.../cv.tailored.md",
  "archetype": "ml_platform",
  "companies": [...]
}
```

- [ ] **Step 2: Verify the output CV contains the Pixel SDK bullet**

```bash
grep -i "pixel sdk\|signal collection" cv.tailored.md
```

Expected: at least one matching line (likely in the TikTok section).

- [ ] **Step 3: Verify `.cv-tailored-meta.json` has the new telemetry**

```bash
cat .cv-tailored-meta.json
```

Expected: `fired_signals` includes at least `sdk`, `platform`, `training_infra`, `distributed`, `feature_store`, `serving`. `intent._source` is `"llm"` or `"llm-retry"` (not `"deterministic-fallback"` — if it is, the LLM is failing and needs attention). Per-company entries include `skills_bonuses` and `top_pool_scores`.

- [ ] **Step 4: Run assemble on Komodo JD**

```bash
node assemble-cv.mjs --jd=jds/komodo-senior-applied-ai.md
```

Expected stdout:
```json
{
  "ok": true,
  "archetype": "applied_ai",
  "companies": [...]
}
```

- [ ] **Step 5: Verify the Komodo output surfaces agent work**

```bash
grep -iE "langraph|langchain|agent|evaluation framework|observability" cv.tailored.md | head -5
```

Expected: at least one matching line — most likely from LinkedIn's PrivacyOps Agent work or TikTok's observability work.

- [ ] **Step 6: Run the validator**

```bash
node validate-cv.mjs cv.tailored.md
```

Expected: `{"ok": true, "checks_passed": 3}`.

No commit for this task — it's verification only.

---

## Self-review checklist (implementer runs this at the end)

After completing all tasks, verify:

1. **All tests pass:** `node --test` → green.
2. **No residual references to old behavior:** `grep -rn "role_type: 'unknown'" assemble-*.mjs` returns only comments or the deterministic-fallback path. The old silent `{role_type: 'unknown', ...}` return is gone.
3. **No placeholder code:** `grep -rn "TODO\|FIXME\|XXX" assemble-*.mjs tests/assemble.*.test.mjs` returns nothing new.
4. **Synonym file parses:** `node -e "const y=require('js-yaml');const fs=require('fs');const d=y.load(fs.readFileSync('config/synonyms.yml','utf-8'));console.log(d.groups.length, 'groups')"` prints a count ≥ 20.
5. **Instacart run surfaces Pixel SDK:** manual check per Task E4.
6. **Komodo run classifies as applied_ai:** manual check per Task E4.

---

## Out of scope (do NOT implement)

- Embedding-based semantic scoring.
- Activating `deriveDeprioritize` rules — leave the stub returning `[]`.
- Any changes to `validate-cv.mjs`, `validate-core.mjs`, `generate-pdf.mjs`, `generate-latex.mjs`, or any `modes/*.md`.
- Any changes to the autopilot/scanner layer (`apify-scan.mjs`, `digest-builder.mjs`, `lib/dedup.mjs`, `.launchd/*`).
- Any refactor of `pickBullets` beyond the empty-DEPRIORITIZE handling in Task C1.
