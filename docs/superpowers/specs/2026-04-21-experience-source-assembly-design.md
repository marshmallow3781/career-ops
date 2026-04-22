# Experience-Source Assembly — Design Spec

**Date:** 2026-04-21
**Status:** Draft, pending user review
**Author:** xiaoxuan (with Claude Code brainstorming session)
**Scope:** Personal fork of `santifer/career-ops`. Not intended for upstream PR.

---

## 1. Context & Problem

`career-ops` currently treats `cv.md` as the single source of truth for the candidate's CV. The PDF generation flow asks the LLM to read `cv.md`, extract JD keywords, reorder bullets, select top projects, and rewrite the summary — all in one prompt-driven step.

This works for a single-axis career (e.g., pure ML engineer) but breaks down for a multi-stack candidate whose work at each company spans several technical facets (frontend, backend, infra, ML). The candidate wants:

1. **Modular source data**: per-company × per-facet markdown files capturing what was done at each company through each technical lens.
2. **JD-driven assembly**: when applying to a specific role, dynamically pull from the relevant facet files.
3. **Hard guarantee that every company appears**: never silently drop a job from the CV; degrade gracefully (fewer bullets) when the JD doesn't match what was done there.
4. **Deterministic enforcement** of structural constraints — not prompt-based "please don't" instructions, which the LLM violates probabilistically.

## 2. Goals

- Replace `cv.md` as the human-edited artifact with a structured `experience_source/{company}/{facet}.md` directory.
- Introduce a deterministic assembler (`assemble-cv.mjs`) that produces a per-JD `cv.tailored.md`, with LLM constrained to **selection** within a deterministic candidate pool.
- Introduce a validator (`validate-cv.mjs`) that hard-blocks PDF generation when structural rules are violated (every company present, no fabricated bullets, chronological order).
- Route every CV-consuming mode (`oferta`, `pdf`, `latex`, `auto-pipeline`, `apply`, `contacto`, `deep`) through `cv.tailored.md`. Per-job context is required.
- Keep changes contained to a personal fork; no concern for upstream merge compatibility, multi-language modes (`modes/de`, `modes/fr`, `modes/ja`), or generic users' archetypes.

## 3. Non-Goals

- Generic `cv.md` artifact (removed entirely). All consumers require a JD.
- Pre-commit hook to refresh a cached CV (removed — nothing to cache).
- Internationalization beyond English.
- Upstream PR or backwards compatibility with vanilla `cv.md` workflows.
- A standalone `fetch-jd.mjs` Node script. JD scraping continues to use career-ops's existing MCP-Playwright path.
- Testing the LLM's *quality* of bullet selection. Tests cover deterministic behavior only.

## 4. Decisions Summary

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Fork scope: personal use only | No generality / upstream compatibility burden. |
| 2 | `cv.md` removed entirely | Every workflow has a JD, so always tailor. Eliminates dual source-of-truth drift. |
| 3 | Deterministic candidate pool → LLM picks → validator gates | LLM owns semantic match; script owns structural correctness. |
| 4 | Tier = candidate pool size + per-company `tier_floor` override | Predictable default + escape hatch for high-importance companies. |
| 5 | Full automation in pipeline, no pre-commit hook | Generic artifact is gone, so nothing to refresh on commit. |
| 6 | English only | Minimize surface area. |
| 7 | LaTeX path retained, fed by `cv.tailored.md` via `--input` flag | User uses LaTeX; cheap to keep aligned with PDF flow. |
| 8 | `article-digest.md` kept, scope narrowed to non-company proof points | Open-source, blog posts, talks, side projects don't fit company directories. |
| 9 | Facets fixed at 4: `frontend`, `backend`, `infra`, `machine_learning` | Matches user's actual stacks. `fullstack` is a JD archetype, not a facet — handled by fallback merge of `frontend.md` + `backend.md`. |

## 5. Architecture

### 5.1 Layer split

```
┌─ USER LAYER (hand-written, never auto-updated) ─────────────────────┐
│                                                                     │
│  experience_source/{company}/{facet}.md   ← new structured source   │
│  article-digest.md                        ← non-company proof points│
│  config/profile.yml                       ← config + identity       │
│  jds/{slug}.md                            ← scraped JDs             │
│  data/applications.md                     ← tracker (existing)      │
│  reports/{###}-{slug}-{date}.md           ← evaluations (existing)  │
│  output/                                  ← PDFs + tailored archives│
│                                                                     │
│  (cv.md does NOT exist)                                             │
└─────────────────────────────────────────────────────────────────────┘

┌─ SYSTEM LAYER (versioned in fork) ──────────────────────────────────┐
│                                                                     │
│  assemble-cv.mjs --jd=<path>              ← new                     │
│  validate-cv.mjs                          ← new                     │
│  generate-pdf.mjs --input=<path>          ← modified (add flag)     │
│  generate-latex.mjs --input=<path>        ← modified (add flag)     │
│  modes/pdf.md                             ← modified (call assemble)│
│  modes/latex.md                           ← modified (call assemble)│
│  modes/auto-pipeline.md                   ← modified (Paso 0.5–0.6) │
│  modes/oferta.md                          ← modified (read tailored)│
│  modes/contacto.md                        ← modified (require JD)   │
│  modes/deep.md                            ← modified (require JD)   │
│  modes/apply.md                           ← modified (read tailored)│
│  DATA_CONTRACT.md                         ← modified (register new) │
│                                                                     │
│  (no .githooks/pre-commit)                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 Mode-to-source routing

| Mode | Source read | Notes |
|------|-------------|-------|
| `oferta`, `auto-pipeline`, `pdf`, `latex`, `apply` | `cv.tailored.md` | Always have JD; assembler runs first. |
| `contacto`, `deep` | `cv.tailored.md` | Require JD or target role URL; error if absent. |
| `patterns` | `reports/**.md` + `data/applications.md` | Aggregate analysis; no single JD. |
| `training`, `project` | `experience_source/**` (raw) | LLM reads source files directly to assess capability gaps. |
| `tracker` | `data/applications.md` | No CV involvement. |

## 6. Data Model

### 6.1 `experience_source/{company}/{facet}.md`

**Directory convention**:

```
experience_source/
├── meta/
│   ├── frontend.md
│   └── machine_learning.md
├── google/
│   └── backend.md
└── linkedin/
    ├── frontend.md
    └── machine_learning.md
```

- `{company}` = kebab-case directory; one directory per company; multiple facets under it.
- `{facet}.md` ∈ {`frontend`, `backend`, `infra`, `machine_learning`}.
- `fullstack` is **not** a facet file. JD archetype `fullstack` triggers a merge of `frontend.md` + `backend.md` per company.

**File format**:

```markdown
---
company: Meta
role: Senior Software Engineer
location: Menlo Park, CA
start: 2023-04
end: 2024-11
facet: machine_learning           # must match filename
---

## Bullets

- Trained 20B MoE on 128 A100 with PyTorch + Ray, throughput 35% above baseline
- Designed Feature Store v2 serving 14 ranking models, p99 read latency 8ms
- Led eval framework rewrite, offline→online metric gap 12% → 3%

## Projects

- **MoE Training Infra** — Ray + PyTorch + FSDP, supports 20B scale, cost -35%
  - (optional indented detail bullets, expanded only when the project is selected)
- **Ranking Feature Store v2** — 14 models, p99 8ms

## Skills used

PyTorch, Ray, FSDP, CUDA, A100, Feature Store, MLflow, Python, Kubernetes
```

**Cross-facet consistency rule**: within the same company directory, every facet file must share identical `role`, `start`, `end`, `location`. The assembler validates this and aborts on mismatch.

### 6.2 `article-digest.md` (narrowed scope)

Purpose: capture non-company proof points (open-source projects, blog posts, conference talks, personal side projects). Content from this file feeds the **Projects pool** during assembly, scored alongside `## Projects` extracted from `experience_source/`.

```markdown
# Article Digest — Non-company Proof Points

## FraudShield — Real-time Fraud Detection (Open Source)
**Type:** open-source
**Archetype:** machine_learning
**Hero metrics:** 99.7% precision, 50ms p99, 500+ GitHub stars
**Proof points:**
- Adopted by 3 fintech companies
- MLConf 2023 talk

## "Why RAG is not enough" (Blog)
**Type:** article
**Archetype:** machine_learning
**URL:** https://you.dev/rag-is-not-enough
**Hero metrics:** 10K+ reads, HN front page
```

### 6.3 `config/profile.yml` additions

```yaml
# (existing fields: candidate, target_roles, narrative, compensation, location, etc.)

experience_sources:
  root: experience_source
  archetypes:                       # facet filename per archetype (4 facets)
    frontend: frontend.md
    backend: backend.md
    infra: infra.md
    machine_learning: machine_learning.md

  # JD archetype → which facet files contribute (5 archetypes, 4 facets)
  jd_archetype_sources:
    frontend:         [frontend]
    backend:          [backend]
    infra:            [infra]
    machine_learning: [machine_learning]
    fullstack:        [frontend, backend]    # merge candidate pools

  overrides:                        # per-company tier floor + stub fallback
    meta:
      tier_floor: full              # always include at least full content
      stub: "Shipped production systems on a high-traffic AI platform."
    linkedin:
      tier_floor: light
      stub: "Built features on a global professional network."
    google:
      stub: "Contributed to infrastructure serving 1B+ users."

archetype_defaults:
  frontend:         { top_bullets_full: 4, top_projects: 3 }
  backend:          { top_bullets_full: 5, top_projects: 4 }
  infra:            { top_bullets_full: 4, top_projects: 3 }
  machine_learning: { top_bullets_full: 5, top_projects: 4 }
  fullstack:        { top_bullets_full: 5, top_projects: 4 }

tier_rules:
  light_bullets: 2                  # how many bullets in the "light" tier

prefer_latex: false                 # if true, auto-pipeline also runs generate-latex.mjs
```

### 6.4 Provenance markers

`cv.tailored.md` embeds source markers as inline HTML comments. The renderer strips them before generating HTML/PDF; the validator reads them.

```markdown
### Meta — Menlo Park, CA
**Senior Software Engineer** | 2023-04 → 2024-11

- Trained 20B MoE on 128 A100... <!-- src:meta/machine_learning.md#L11 -->
- Designed Feature Store v2... <!-- src:meta/machine_learning.md#L12 -->
```

**Marker format**: `<!-- src:{relative-path}#L{line} -->`. The line number is a *hint for humans*; the validator treats it as advisory. Validation requires only that the referenced file exists and that the bullet text fuzzy-matches *some* bullet in that file at Levenshtein ratio ≥ 0.85, accommodating ATS keyword rephrasing and line drift after source edits.

## 7. Components

### 7.1 `assemble-cv.mjs` (new)

**Invocation:**
```bash
node assemble-cv.mjs --jd=jds/{slug}.md [--archetype=<override>] [--feedback=<errors.json>]
```

**Outputs:**
- `cv.tailored.md` — assembled markdown CV with provenance markers.
- `.cv-tailored-meta.json` — sidecar with candidate pools, scores, tier decisions, LLM call log.

**Algorithm:**

```
1. loadConfig(config/profile.yml)
2. loadSources(experience_source/**/*.md) and loadArticleDigest()
3. validateConsistency() — cross-facet date/role consistency per company
4. groupByCompany() and sortByDateDesc() (by min(start) in frontmatter)
5. extractJDKeywords(jd_text) → Set<string>  (terms + simple synonym expansion)
6. classifyArchetype(jd_text) → primary archetype (or use --archetype override)
7. resolveSources(archetype) using jd_archetype_sources
8. for each company:
    a. select facet file(s); for fullstack JD, merge frontend + backend pools
    b. score bullets (keyword/synonym overlap) → candidate pool (filtered by threshold)
    c. assignTier(pool size, overrides[company].tier_floor) → full | light | stub
    d. [LLM call] given pool, JD summary, tier → return selected bullets + minor ATS rephrasing
       (stub tier skips LLM; uses overrides[company].stub literal)
9. Projects pool: union of all `## Projects` (companies + article-digest), scored, top-N per archetype_defaults
10. Skills: union of `## Skills used` ∩ JD keywords → 6–8 Core Competencies
11. [LLM call] Professional Summary: profile.yml.narrative + JD keywords → rewritten summary
12. render(markdown) with provenance markers → cv.tailored.md
13. write .cv-tailored-meta.json
```

**LLM calls per assembly**: O(N companies that aren't stub) + 1 (summary) ≈ 3–5 typical.

**Dependencies**: `js-yaml`, `gray-matter`, `fast-levenshtein`, `@anthropic-ai/sdk`.

### 7.2 `validate-cv.mjs` (new)

**Invocation:**
```bash
node validate-cv.mjs cv.tailored.md
# exit 0 = pass; exit 1 = fail (errors written to stderr as JSON)
```

**Three hard checks:**

1. **CompanyCoverage** — every directory under `experience_source/` must have a corresponding `### Company` header in `cv.tailored.md`.
2. **BulletProvenance** — every bullet must carry an `<!-- src:{path}#L{line} -->` marker; the referenced file must exist; the bullet text must fuzzy-match *some* bullet line in that file (Levenshtein ratio ≥ 0.85). The line-number hint is advisory, not enforced.
3. **ChronologicalOrder** — companies appear in reverse chronological order by `min(start)` from frontmatter.

**Failure output** (machine-readable, consumed by retry loop):

```json
{
  "errors": [
    {
      "type": "missing_company",
      "company": "linkedin",
      "hint": "linkedin company missing. Ensure stub or higher tier is assigned."
    },
    {
      "type": "fabricated_bullet",
      "bullet": "Built RAG pipeline at LinkedIn",
      "expected_sources": ["linkedin/machine_learning.md"],
      "hint": "Bullet not found in candidate pool; only select from provided pool."
    },
    {
      "type": "chronology_violation",
      "found": ["meta", "linkedin", "google"],
      "expected": ["meta", "google", "linkedin"]
    }
  ]
}
```

### 7.3 `generate-pdf.mjs` (modified)

Add CLI flag: `--input=<path>` (default: `cv.tailored.md`).

The HTML rendering step that previously read from `cv.md` now reads from `--input`. No other behavior change.

### 7.4 `generate-latex.mjs` (modified)

Same as 7.3: add `--input=<path>` (default `cv.tailored.md`).

### 7.5 `modes/pdf.md` (modified)

Replace the LLM-driven assembly steps with:

```
1. If JD not provided in plain text, run MCP-Playwright extraction (Paso 0 of auto-pipeline)
2. Save JD to jds/{company-slug}.md
3. Run: node assemble-cv.mjs --jd=jds/{slug}.md
4. Run: node validate-cv.mjs cv.tailored.md
   On failure: read .cv-tailored-errors.json, re-invoke assemble with --feedback flag (≤3 retries), abort if still failing
5. Fill templates/cv-template.html placeholders from cv.tailored.md
6. Run: node generate-pdf.mjs /tmp/cv-xxx.html output/cv-{candidate}-{company}-{date}.pdf --format={letter|a4}
7. Archive: copy cv.tailored.md → output/cv-tailored-{company}-{date}.md
8. Report: PDF path, page count, keyword coverage %, tier breakdown per company
```

### 7.6 `modes/latex.md` (modified)

Same as 7.5 but the final step is `node generate-latex.mjs --input=cv.tailored.md output/cv-xxx.tex`.

### 7.7 `modes/auto-pipeline.md` (modified)

Update the pipeline order:

```
Paso 0:    Extract JD via MCP-Playwright → jds/{slug}.md  (existing behavior)
Paso 0.5:  node assemble-cv.mjs --jd=jds/{slug}.md
Paso 0.6:  node validate-cv.mjs cv.tailored.md  (with retry loop)
Paso 1:    Evaluation A–G (oferta mode reads cv.tailored.md) → reports/{###}-{slug}-{date}.md
Paso 2:    Save report
Paso 3:    generate-pdf.mjs (+ generate-latex.mjs if profile.yml.prefer_latex=true)
Paso 4:    If score ≥ 4.5, draft application answers
Paso 5:    Update tracker (data/applications.md)
Paso 6:    Archive cv.tailored.md → output/
```

### 7.8 `modes/oferta.md`, `modes/contacto.md`, `modes/deep.md`, `modes/apply.md` (modified)

- All references to "read `cv.md`" change to "read `cv.tailored.md`".
- `contacto.md` and `deep.md` add a precondition: error out with "JD or target role required" if no JD context exists.
- `oferta.md` Block B (CV Match) is enriched with tier breakdown info from `.cv-tailored-meta.json`.

### 7.9 `DATA_CONTRACT.md` (modified)

- **Remove** `cv.md` from User Layer.
- **Add** to User Layer: `experience_source/*` ("structured per-company × per-facet experience source data").
- **Update** `article-digest.md` description: "non-company proof points (open-source, blog, talks, side projects)".
- **Add** to System Layer: `assemble-cv.mjs`, `validate-cv.mjs`.
- **Note** removal: pre-commit hook is *not* introduced.

## 8. Data Flow

Single flow (no generic flow exists):

```
User edits experience_source/meta/machine_learning.md
        │
        ▼
git commit  (no pre-commit assembly)
        │
        ▼
Apply to a job: /career-ops + JD URL
        │
        ▼
  Paso 0:   MCP-Playwright extracts JD → jds/{slug}.md
  Paso 0.5: assemble-cv.mjs --jd=jds/{slug}.md
            ├─ extractJDKeywords → keywords set
            ├─ classifyArchetype → e.g. "backend"
            ├─ resolveSources("backend") → [backend.md]
            │   (fullstack JD → [frontend.md, backend.md] merged)
            ├─ for each company:
            │    ├─ load facet file(s)
            │    ├─ score bullets → candidate pool
            │    ├─ assignTier(pool, overrides) → full | light | stub
            │    └─ [LLM] pick top-N from pool, ATS rephrase
            ├─ Projects pool union, top-N
            ├─ Skills ∩ JD keywords → Core Competencies
            ├─ [LLM] Summary from profile.narrative + JD keywords
            └─ render → cv.tailored.md + .cv-tailored-meta.json
  Paso 0.6: validate-cv.mjs cv.tailored.md
            ├─ CompanyCoverage / BulletProvenance / ChronologicalOrder
            └─ on failure: re-invoke assemble with feedback (≤3 retries) → abort
  Paso 1:   oferta evaluation reads cv.tailored.md → report
  Paso 2:   save report
  Paso 3:   generate-pdf.mjs (+ generate-latex.mjs if prefer_latex)
  Paso 4:   if score ≥ 4.5, draft application answers
  Paso 5:   update tracker
  Paso 6:   archive cv.tailored.md → output/cv-tailored-{company}-{date}.md
```

## 9. Tier Rules

Default tier from candidate pool size:

| Pool size | Tier | Output |
|-----------|------|--------|
| ≥ 3 | `full` | LLM picks top-N per `archetype_defaults[archetype].top_bullets_full` |
| 1–2 | `light` | LLM picks `tier_rules.light_bullets` (default 2; capped at pool size) |
| 0 | `stub` | Header only + `overrides[company].stub` literal as a single bullet |

`overrides[company].tier_floor` raises the minimum tier:

- `tier_floor: full` — even if pool is empty, render full structure (with stub bullet as filler) and emit a warning.
- `tier_floor: light` — never rendered as stub; pool of 0 falls back to one stub bullet but inside a "light" frame.

Rationale for floor overrides: recent/high-prestige employers (e.g., current job) should never appear visibly downgraded, even when the JD doesn't match the work done there.

## 10. Validation Rules

(See §7.2 for the schema.)

The validator is a **hard gate** in the pipeline: PDF generation cannot proceed until validation passes. The retry loop:

```
attempt = 1..3:
    cv.tailored.md ← assemble-cv.mjs --jd=X [--feedback=prev errors.json]
    result ← validate-cv.mjs cv.tailored.md
    if result.ok: break
    if attempt == 3: abort with errors
    write errors → .cv-tailored-errors.json (consumed by next assemble call)
```

The LLM, on retry, sees structured human-readable hints (not raw stack traces) explaining what to fix.

## 11. Error Handling

### 11.1 Failure modes and responses

| Failure | Response |
|---------|----------|
| frontmatter missing fields / invalid YAML | abort immediately, stderr points to file/line; user fixes source manually |
| cross-facet date/role inconsistency | abort, list all conflicting files |
| LLM API failure (timeout, rate limit, malformed JSON) | retry same call ×3 with exponential backoff (1s/3s/10s), then abort |
| validator failure | retry loop ×3 (§10) |
| `generate-pdf.mjs` failure (Playwright headless) | retry once, then abort. `cv.tailored.md` is preserved for manual recovery |

### 11.2 Soft failures (warning, no abort)

| Scenario | Behavior |
|----------|----------|
| Pool empty but `tier_floor: full` | Use stub + warn: "Meta forced to full but pool empty; degraded to stub bullet" |
| `overrides` lists a company with no `experience_source/{name}/` directory | Warn and ignore that override |
| Archetype classification confidence low (multiple candidates tied) | Warn + record in `.cv-tailored-meta.json`; proceed with highest-scoring choice |

### 11.3 Sidecar artifacts on abort

Even on abort, the pipeline preserves:
- `cv.tailored.md` (last attempted assembly)
- `.cv-tailored-meta.json` (debug info: pools, scores, tier decisions, LLM trace)
- `.cv-tailored-errors.json` (last validator errors)

Career-ops behavior: when a downstream step fails (e.g., `generate-pdf.mjs` at Paso 3) **after** `oferta` has already produced a report at Paso 1, the report is **not** rolled back — instead, a `**Pipeline-Status:** {failed_step}` line is added to the report header, and the tracker is not updated. (When assembly itself fails at Paso 0.5–0.6, no report exists yet, so nothing to preserve.)

## 12. Testing

### 12.1 Test layers

| Layer | LLM | In CI | Purpose |
|-------|-----|-------|---------|
| Unit | none | yes | Deterministic functions: parse, score, tier, validate checks |
| E2E | mocked Anthropic SDK | yes | Full pipeline against fixture JD; mock returns "first N from pool" |
| Smoke | real API | no | Manual `npm run smoke -- --jd=...` for spot-check |

### 12.2 Test files (added to `test-all.mjs` registry)

```
assemble.parse.test.mjs       — frontmatter parse + cross-facet consistency
assemble.scoring.test.mjs     — keyword overlap scoring + synonym expansion
assemble.tier.test.mjs        — tier assignment + tier_floor overrides
validate.coverage.test.mjs    — missing company detection
validate.provenance.test.mjs  — fabricated bullet detection (incl. fuzzy match boundary)
validate.chronology.test.mjs  — out-of-order detection
e2e.assemble.test.mjs         — full pipeline with mock LLM, diff against expected/
```

### 12.3 Fixtures (committed to repo)

```
__fixtures__/
├── experience_source/
│   ├── meta/
│   │   ├── frontend.md
│   │   └── machine_learning.md
│   └── linkedin/
│       └── frontend.md
├── profile.yml
├── jds/
│   ├── frontend-jd.md
│   └── ml-jd.md
└── expected/
    ├── cv.tailored.frontend.md
    └── cv.tailored.ml.md
```

Fixtures use synthetic but realistic content. Diff against `expected/` is exact-match (mock LLM returns deterministic responses).

## 13. Removed / Deprecated

The following capabilities of vanilla career-ops are intentionally removed in this fork:

- **`cv.md`** (the file) — does not exist; consumers must run assembly first.
- **`assemble-cv.mjs --generic`** — there is no generic mode.
- **Pre-commit hook for CV refresh** — nothing to refresh.
- **JD-less workflows** — `contacto`, `deep`, `pdf`, `latex` all require a JD context. Speculative "send to a recruiter" CV requires creating a synthetic JD file under `jds/` (acknowledged hack).
- **Multi-language modes (`modes/de`, `modes/fr`, `modes/ja`)** — left untouched; they continue to reference `cv.md` and will fail if invoked, but the user does not use them.

## 14. Open Questions for Implementation Plan

- **Synonym table** for keyword scoring: hardcoded list, external YAML config, or rely on basic stemming only? Trade-off: maintenance vs recall.
- **LLM model choice** for bullet selection (Haiku for speed/cost vs Sonnet for nuance). Default suggestion: Sonnet for selection, Haiku for summary; revisit after smoke tests.
- **Archetype classification**: deterministic rules (regex over JD title + body) vs LLM call. Adding an LLM call here adds latency; rules are brittle. Suggest LLM with simple fallback heuristic.
- **Multi-company at the same date** (overlapping employments): currently sorted by `end` then alphabetical. Confirm this is acceptable.
- **Fixture content authenticity**: synthetic bullets that look like the user's real work, or fully neutral placeholders? Affects whether fixtures can be committed publicly without leaking personal details.

These are not blockers for the design but should be resolved during the implementation plan.

## 15. Acceptance Criteria

The fork is considered "design-complete and ready for implementation planning" when:

1. The user has reviewed this spec and either approved it or requested changes that are then incorporated.
2. The implementation plan (next step, generated via `superpowers:writing-plans`) covers each component in §7 with concrete tasks.

---

**Next step:** Invoke `superpowers:writing-plans` to convert this spec into a detailed step-by-step implementation plan.
