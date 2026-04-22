# Intent Extraction & Scoring Hardening — Design

**Date:** 2026-04-22
**Status:** Design approved, ready for implementation plan
**Fork:** `marshmallow3781/career-ops`, branch `feat/experience-source-assembly` (HEAD `81079bc`)

---

## 1. Problem

On the Instacart Senior Engineer ML/AI Platform JD, the TikTok Pixel SDK bullet — a production-quality TypeScript SDK shipping to 3 browser envs, 531M+ events — failed to surface in the tailored CV. A parallel Claude session that read the same `experience_source/` files directly produced a stronger CV that included Pixel SDK. Diagnosis against `.cv-tailored-meta.json` and the scoring pipeline identified four compounding causes:

1. **`extractJdIntent` silently failed.** MiniMax returned unparseable output; `.cv-tailored-meta.json` shows `"intent": {"role_type": "unknown", "prefer_patterns": [], "deprioritize_patterns": []}`. `pickBullets` ran with no role-intent guidance.
2. **Scoring missed singular/plural variants.** JD says "SDKs" (plural); bullet says "SDK" (singular). `scoreBullet`'s exact-word regex counted zero hits.
3. **Pool truncation cut the bullet before the LLM saw it.** `Math.max(n*2, n+2) = 8` truncation on a pool of 30 bullets dropped the Pixel SDK bullet (score 3) below the cutoff. The LLM never had a chance to pick it.
4. **Skills block was unused for scoring.** `frontend.md`'s `## Skills used: SDK design, web performance, TypeScript, Puppeteer, Lighthouse, ...` overlapped the JD by 4+ skills, but this signal didn't lift individual bullets in that file.

A related problem surfaced during design review of a Komodo Health "Senior Applied AI Engineer" JD: the current 6 archetypes don't cleanly represent roles that ship production LLM/agent systems. And rule-based `deprioritize_patterns` is too coarse — it would suppress the LinkedIn PrivacyOps bullets on a "compliance" framing signal while ignoring that those bullets contain Airflow, Spark, and distributed-data-processing skills explicitly listed in Komodo's nice-to-have section.

## 2. Goal

Harden the intent extraction path, improve scoring so topically-relevant bullets rank higher, drop rule-based deprioritize entirely (LLM reads content better than rules read framing), and add one new archetype (`applied_ai`) for end-to-end AI-systems engineering roles.

Success criteria:
- Running `node assemble-cv.mjs --jd=jds/instacart-senior-engineer-ml-ai-platform.md` produces a CV where at least one TikTok bullet mentions "Pixel SDK" or "signal collection SDK".
- Running the same against a Komodo JD classifies as `applied_ai` and surfaces LinkedIn's PrivacyOps Agent (LangGraph/Claude) alongside backend and distributed-systems bullets from TikTok.
- `.cv-tailored-meta.json` includes `fired_signals`, `intent._source` (`llm` | `llm-retry` | `deterministic-fallback`), and per-company `skills_bonuses`.
- When the intent LLM call fails twice, the pipeline still produces meaningful `prefer_patterns` from deterministic signal detection (never silently empty).

## 3. Architecture

```
1. Load JD text

        ├── deriveSignals(jdText)                   [NEW, deterministic]
        │     → Set<string> of fired signal names
        │
        ├── extractKeywords + expandSynonyms         [existing, synonyms.yml expanded]
        │     → keyword Set
        │
        ├── classifyArchetype(jdText)                [LLM, existing + applied_ai added]
        │     → role_type
        │
        └── extractJdIntent(jdText, firedSignals)    [LLM, HARDENED — 1 retry + deterministic fallback]
              → {primary_focus, prefer_patterns}

2. Build intent object
   intent = {
     role_type,
     primary_focus,
     prefer_patterns,
     deprioritize_patterns: [],    // intentionally empty, rules commented out
     _source,                      // "llm" | "llm-retry" | "deterministic-fallback"
   }

3. For each company:
     for each facet file:
       skillsBonus = min(|skills ∩ keywords|, 3)    [NEW]
       for each bullet:
         score = scoreBullet(bullet, keywords) + skillsBonus
           (scoreBullet now does trailing-'s' stemming)
     truncate pool to Math.max(n*4, 15)             [B]
     pickBullets(truncated, jd, n, intent)

4. Render cv.tailored.md + write .cv-tailored-meta.json (richer telemetry)
```

LLM call count: 2-3 fixed + N per company. `classifyArchetype` (1) + `extractJdIntent` (1, up to 2 with retry) + `pickBullets` (N). Today it is 2 + N; worst case after change is 3 + N when the intent retry fires. Other calls unchanged.

## 4. Intent extraction

### 4.1 Signal detection (`deriveSignals`)

New function in `assemble-core.mjs`. Deterministic, always runs, returns `Set<string>` of names from the signal table below that fired in the JD. One regex per alias, word-boundaries, case-insensitive. Signal table lives as a module-level constant.

**Signal table (16 signals):**

| Name | Aliases |
|---|---|
| `sdk` | SDK, SDKs, software development kit, client library, developer API, API client, shared library, toolkit, internal SDK, service SDK, platform SDK, developer tooling |
| `platform` | platform, internal tooling, developer platform, infra, infrastructure, shared infrastructure, self-serve platform, internal platform, enablement, foundational, core infrastructure, platform team, common services, shared services, service platform |
| `feature_store` | feature store, feature platform, online feature serving, offline feature store, feature pipeline, feature computation, feature generation, feature materialization, feature registry, feature retrieval, feature serving, feature freshness, Tecton, Feast |
| `training_infra` | training platform, training infra, distributed training, fine-tuning, fine tuning, model training, training pipeline, training workflow, training orchestration, ML training, PyTorch Lightning, Horovod, Kubeflow, Airflow, SageMaker training, GPU training, multi-GPU, multi-node training, distributed optimizer, hyperparameter tuning, HPO |
| `serving` | model serving, inference, batch inference, online inference, real-time inference, prediction service, scoring service, serving layer, model endpoint, deployment endpoint, Ray, Ray Serve, TorchServe, TensorFlow Serving, Triton, vLLM, Seldon, BentoML |
| `distributed` | distributed systems, high throughput, large-scale systems, stream processing, real-time pipeline, Kafka, Flink, Spark, Beam, MapReduce, Pub/Sub, Kinesis, distributed queue, event-driven, message queue, streaming, backpressure, partitioning, sharding, replication, concurrency |
| `applied_ml` | train models, model development, feature engineering, ML engineer, machine learning engineer, applied scientist, research engineer, research, model experimentation, offline evaluation, precision, recall, AUC, F1, ranking model, classification model, fraud model, recommendation model, XGBoost, LightGBM, CatBoost, scikit-learn, PyTorch, TensorFlow |
| `frontend` | React, Vue, UI, frontend, component library, design system, Next.js, Redux, Zustand, Pinia, Tailwind, Ant Design, Material UI, storybook, web app, dashboard, internal tools UI, operator console |
| `agents` | LangChain, LangGraph, RAG, agentic, LLM agent, tool calling, multi-agent, retrieval augmented generation, vector search, vector database, prompt engineering, OpenAI, Anthropic, Gemini, LlamaIndex, Pinecone, Weaviate, FAISS, Milvus |
| `backend` | Go, Golang, Java, Spring Boot, Python, Node.js, REST API, gRPC, RPC, microservices, service-oriented architecture, backend services, API design, distributed backend |
| `data_storage` | MySQL, PostgreSQL, Redis, Cassandra, DynamoDB, Bigtable, Elasticsearch, MongoDB, data warehouse, Hive, Snowflake, BigQuery, Delta Lake, Iceberg, HBase, OLTP, OLAP |
| `cloud_infra` | AWS, EC2, EKS, S3, EMR, Lambda, GCP, GKE, BigQuery, Azure, Kubernetes, Docker, containerization, Terraform, Helm, infrastructure as code, cloud infrastructure |
| `observability` | OpenTelemetry, Grafana, Prometheus, Datadog, monitoring, metrics, tracing, distributed tracing, logging, alerting, SLO, SLI, APM, dashboard, incident response |
| `cicd` | CI/CD, continuous integration, continuous deployment, GitHub Actions, Jenkins, build pipeline, deployment pipeline, release pipeline, ArgoCD, CircleCI, GitLab CI |
| `experimentation` | A/B test, experimentation, online experiment, offline evaluation, model evaluation, canary, shadow testing, feature flag, holdout, lift, statistical significance |
| `mlops` | MLOps, ML platform, model registry, model versioning, pipeline orchestration, MLflow, Kubeflow, SageMaker, feature registry, experiment tracking, model monitoring |

**Aliases dropped to reduce false positives:**
- From `sdk`: "library" and "framework" (fire on "PyTorch framework", "React library")
- No other adjustments (`frontend`'s "TypeScript"/"JavaScript" stay; `role_type` is LLM-classified, so noise in `prefer_patterns` is acceptable)

### 4.2 LLM intent call (`extractJdIntent`)

Rewritten. Asks for **engineer-archetype narratives**, not topic tags. Fired signals are passed in as raw material to reduce hallucination.

**Prompt:**

```
Given this JD, describe the engineer archetype the team is actually hunting for.

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
- "Platform-minded engineer who has built data pipelines, experimentation, and
   production systems for intelligent decisioning"
- "ML infrastructure engineer focused on distributed training and serving at scale"

Bad examples (do NOT emit — too narrow):
- "SDK design"
- "Kubernetes"
- "Python experience"

FIRED SIGNALS: ${firedSignals.join(', ')}

JD:
${jdText.slice(0, 4000)}
```

### 4.3 Retry + deterministic fallback

```
attempt 1: call LLM with prompt above
  parse success → return {..., _source: "llm"}
  parse failure → log "[extractJdIntent] parse failure, retrying with strict reprompt"

attempt 2: call LLM with reprompt appended:
  "Your last response did not parse as JSON. Output ONLY the JSON object.
   No markdown, no prose, no explanation."
  parse success → return {..., _source: "llm-retry"}
  parse failure → log "[extractJdIntent] LLM failed twice, using deterministic fallback"

fallback: build from fired signals
  prefer_patterns = [signalToPhrase[s] for s in firedSignals]   // up to 16 items
  primary_focus = `${role_type} role — building ${prefer_patterns.slice(0,2).join(' and ')}`
  _source = "deterministic-fallback"
```

**Signal-to-phrase table** (used only by the fallback path):

| Signal | Fallback phrase |
|---|---|
| `sdk` | SDK / client library design |
| `platform` | internal platform ownership |
| `feature_store` | feature store / feature platform |
| `training_infra` | distributed training infrastructure |
| `serving` | model serving / inference platform |
| `distributed` | distributed systems at scale |
| `applied_ml` | ML modeling and training |
| `frontend` | UI / design system work |
| `agents` | LLM agent / RAG systems |
| `backend` | backend services and APIs |
| `data_storage` | data storage and warehousing |
| `cloud_infra` | cloud infrastructure |
| `observability` | observability and monitoring |
| `cicd` | CI/CD and release infrastructure |
| `experimentation` | experimentation and A/B testing |
| `mlops` | MLOps and pipeline orchestration |

### 4.4 `deprioritize_patterns` — intentionally empty

Rules-based deprioritize is too coarse. It operates on narrative framing (e.g. "compliance theme") but ignores the actual skill content inside bullets. Example: LinkedIn's PrivacyOps bullets are framed around compliance but contain Airflow + Spark + distributed-data-processing skills that a healthcare-data JD like Komodo explicitly asks for. A rule hiding "compliance framing" would throw these bullets away.

`deriveDeprioritize(role_type, firedSignals)` gets implemented as a stub returning `[]`, with the reference rules preserved as comments inside the function body for future reactivation if observations suggest it's needed.

`intent.deprioritize_patterns` stays in the schema (empty array) so downstream `pickBullets` code doesn't need restructuring. `pickBullets`'s prompt-builder is updated so the `- DEPRIORITIZE bullets about: ...` line is omitted entirely when the list is empty — rather than emitting "(none specified)" — to avoid planting irrelevant structure in the prompt.

### 4.5 New archetype: `applied_ai`

Captures roles that ship production AI/LLM/agent systems end-to-end — backend + agents + observability/evals. Distinct from `machine_learning` (trains models) and `ml_platform` (builds infra for ML teams).

Changes:
- `VALID_ARCHETYPES` in `assemble-llm.mjs`: add `applied_ai`.
- `ARCHETYPE_ALIASES`: add `applied_ai: ['applied ai', 'applied ai engineer', 'ai engineer', 'ai systems engineer', 'llm engineer', 'ai platform engineer', 'production ai', 'agent engineer']`.
- `classifyArchetype` system prompt: add `applied_ai` to the allowed-word list with definition "applied_ai — builds production AI/LLM/agent systems end-to-end".
- `config/profile.yml` `archetype_defaults`: add `applied_ai: { top_bullets_full: 4, top_projects: 3 }`.

## 5. Scoring changes

### 5.1 Plural stemming in `scoreBullet`

```js
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

Exact-match path unchanged — existing tests pass. Add two new tests: "sdk keyword matches SDKs bullet"; "apis keyword matches API bullet".

### 5.2 Per-file skills-list bonus

Computed once per facet file in `assemble-cv.mjs`:

```js
for (const f of facetFiles) {
  const skillsLc = (f.skills || []).map(s => s.toLowerCase());
  const skillsOverlap = skillsLc.filter(s => keywords.has(s)).length;
  const skillsBonus = Math.min(skillsOverlap, 3);

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
}
```

Cap at 3 prevents any single file from dominating by skill count alone. Files without a `## Skills used` section get `skillsBonus = 0`.

### 5.3 Truncation

```diff
-const truncated = pool.slice(0, Math.max(n * 2, n + 2));
+const truncated = pool.slice(0, Math.max(n * 4, 15));
```

For `n=4` (full tier): 16 bullets to LLM. For `n=2` (light tier): 15. Token cost ~+300 per company call. Negligible.

### 5.4 Synonyms expansion (`config/synonyms.yml`)

Added groups:

```yaml
- canonical: sdk
  aliases: [sdks, software development kit, client library, developer api, api client, shared library, toolkit, internal sdk, platform sdk, developer tooling]
- canonical: platform_engineering
  aliases: [platform, internal platform, developer platform, internal tooling, shared infrastructure, self-serve platform, core infrastructure, platform team, common services, shared services, service platform, enablement]
- canonical: training_infrastructure
  aliases: [training platform, training infra, training pipeline, training workflow, training orchestration, distributed training, gpu training, multi-gpu, multi-node training, hyperparameter tuning, hpo, fine-tuning, fine tuning]
- canonical: model_serving
  aliases: [model serving, online inference, real-time inference, batch inference, prediction service, scoring service, serving layer, model endpoint, deployment endpoint, ray serve, torchserve, tensorflow serving, triton, vllm, seldon, bentoml]
- canonical: observability
  aliases: [opentelemetry, grafana, prometheus, datadog, monitoring, metrics, tracing, distributed tracing, logging, alerting, slo, sli, apm, dashboard, incident response]
- canonical: experimentation
  aliases: [a/b test, a/b testing, experimentation, online experiment, offline evaluation, model evaluation, canary, shadow testing, feature flag, holdout, lift, statistical significance]
- canonical: ai_agents
  aliases: [langchain, langgraph, rag, agentic, llm agent, tool calling, multi-agent, retrieval augmented generation, llamaindex, agent orchestration]
```

The existing `mlops` group is merged with richer vocabulary (no duplicate groups). Existing `feature_store` and `vector_db` groups stay as-is.

### 5.5 Combined effect on Instacart Pixel SDK bullet

| Stage | Before | After |
|---|---|---|
| scoreBullet hits (exact match) | 3 | 3 |
| Plural variants add | 0 | +1 (sdks ↔ SDK) |
| Skills bonus (frontend.md ∩ JD keywords) | 0 | +3 (capped) |
| Synonym-expanded keywords | 0 | +1 (sdk design added) |
| **Total score** | **3** | **~8** |
| Position in TikTok pool (size 30) | rank ~10 | rank 1-3 |
| Truncation window | top 8 | top 15 |
| Reaches LLM? | no | yes |

## 6. Telemetry

`.cv-tailored-meta.json` gains new fields:

```json
{
  "jd": "...",
  "archetype": "ml_platform",
  "fired_signals": ["sdk", "platform", "training_infra", "serving", "distributed", "mlops"],
  "intent": {
    "role_type": "ml_platform",
    "primary_focus": "...",
    "prefer_patterns": ["...", "...", "..."],
    "deprioritize_patterns": [],
    "_source": "llm"
  },
  "keyword_count": 234,
  "companies": [
    {
      "dir": "tiktok-us",
      "tier": "full",
      "pool_size": 30,
      "picked": 4,
      "skills_bonuses": {
        "backend.md": 2,
        "frontend.md": 3,
        "infra.md": 1,
        "machine_learning.md": 2
      },
      "top_pool_scores": [8, 8, 7, 7, 6, 6, 6, 6, 5, 5]
    }
  ]
}
```

## 7. Error handling

| Surface | Behavior |
|---|---|
| `extractJdIntent` LLM failure | Retry once with strict reprompt. On double failure, fall back to deterministic signal-to-phrase synthesis. Always log which path was taken. |
| `classifyArchetype` LLM failure | Already hardened (lenient parsing + alias search). `applied_ai` added to both the valid-word list and aliases. |
| `deriveSignals` | Pure function. Cannot fail. |
| `scoreBullet` + skills bonus | Pure. Defensive guard: `skillsBonus = 0` when `f.skills` is missing/empty. |
| `pickBullets` | Unchanged error behavior. Receives empty `deprioritize_patterns` when rules are disabled — prompt suppresses that block. |

## 8. Testing

**Modified: `tests/assemble.scoring.test.mjs`**
- Add: `scoreBullet` matches singular keyword against plural bullet token.
- Add: `scoreBullet` matches plural keyword against singular bullet token.

**New: `tests/assemble.intent.test.mjs`** (~120 lines)
- `deriveSignals` fires correctly on Instacart JD fixture (expects `sdk`, `platform`, `training_infra`, `mlops`, `serving`, `distributed`).
- `deriveSignals` fires correctly on Komodo JD fixture (expects `agents`, `backend`, `observability`, `experimentation`, `distributed`, `applied_ml`).
- `deriveSignals` does NOT fire `sdk` on a generic Python JD (regression for dropped "library"/"framework" aliases).
- `extractJdIntent` with a rejecting mock client returns `_source === 'deterministic-fallback'` and non-empty `prefer_patterns`.
- `extractJdIntent` with a client that returns garbage then valid JSON returns `_source === 'llm-retry'`.
- `extractJdIntent` with a client that returns valid JSON returns `_source === 'llm'`.

**Modified: `tests/e2e.assemble.test.mjs`**
- Add: Instacart JD fixture produces CV where at least one TikTok bullet text matches `/(Pixel SDK|signal[- ]collection SDK)/i`.

**Manual integration checks (one-off)**
- Run assemble against Instacart JD → verify Pixel SDK bullet in TikTok block and the TikTok bullet mix is not all-ML.
- Save Komodo JD to `jds/komodo-senior-applied-ai.md` and run assemble → verify `classifyArchetype` returns `applied_ai` and LinkedIn block surfaces PrivacyOps Agent work.

## 9. File inventory

| File | Change |
|---|---|
| `assemble-core.mjs` | Add `deriveSignals` (+signal table, ~60 lines). Add `deriveDeprioritize` stub returning `[]` (reference rules in comments). Modify `scoreBullet` for plural stemming. |
| `assemble-llm.mjs` | Rewrite `extractJdIntent` (retry + fallback + new prompt, ~60 lines). Add `applied_ai` to `VALID_ARCHETYPES` and `ARCHETYPE_ALIASES`. Update `classifyArchetype` system prompt to include `applied_ai`. |
| `assemble-cv.mjs` | Compute per-file skills bonus. Update truncation constant. Pass `firedSignals` into `extractJdIntent` call. Record new telemetry fields. |
| `config/synonyms.yml` | Add 7 new groups; merge into existing `mlops` group. |
| `config/profile.yml` | Add `archetype_defaults.applied_ai`. |
| `tests/assemble.scoring.test.mjs` | +2 tests (plural stem matches). |
| `tests/assemble.intent.test.mjs` | NEW file (~120 lines). |
| `tests/e2e.assemble.test.mjs` | +1 test case (Instacart regression). |
| `jds/komodo-senior-applied-ai.md` | NEW fixture. |

## 10. Rollout order

1. Synonyms + plural stemming + skills bonus + truncation (pure scoring, testable in isolation).
2. `deriveSignals` + signal table (deterministic, no network).
3. New `extractJdIntent` with retry + deterministic fallback.
4. `applied_ai` archetype integration (`VALID_ARCHETYPES`, aliases, `classifyArchetype` prompt, `archetype_defaults`).
5. Telemetry fields in `.cv-tailored-meta.json`.
6. Regression tests + manual runs on Instacart and Komodo JDs.
7. Remove old `extractJdIntent` body only after the new one is green on both JDs.

Each step independently reviewable and reversible.

## 11. Out of scope

- Embedding-based semantic scoring (too big a lift for this pass).
- Activating `deriveDeprioritize` rules. Commented reference preserved; revisit only if observed picker behavior requires negative guidance.
- Changes to `validate-cv.mjs`, `generate-pdf.mjs`, `generate-latex.mjs`, or any `modes/*.md`.
- Changes to the autopilot / scanner layer (`apify-scan.mjs`, `digest-builder.mjs`, etc.).
