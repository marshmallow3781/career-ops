# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `experience_source/*` | Per-company × per-facet structured experience source files |
| `config/profile.yml` | Your identity, targets, comp range |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `article-digest.md` | Non-company proof points (open-source, blog posts, talks, side projects) |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `portals.yml` | Your customized company list |
| `data/applications.md` | Your application tracker |
| `data/pipeline.md` | Your URL inbox |
| `data/scan-history.tsv` | Your scan history |
| `data/follow-ups.md` | Your follow-up history |
| `reports/*` | Your evaluation reports |
| `output/*` | Your generated PDFs |
| `jds/*` | Your saved job descriptions |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/oferta.md` | Evaluation mode instructions |
| `modes/pdf.md` | PDF generation instructions |
| `modes/scan.md` | Portal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/contacto.md` | LinkedIn outreach instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/ofertas.md` | Comparison instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/training.md` | Training evaluation instructions |
| `modes/patterns.md` | Pattern analysis instructions |
| `modes/followup.md` | Follow-up cadence instructions |
| `modes/de/*` | German language modes |
| `CLAUDE.md` | Agent instructions |
| `AGENTS.md` | Codex instructions |
| `*.mjs` | Utility scripts |
| `assemble-cv.mjs` | Tailored CV assembler |
| `assemble-core.mjs` | Pure functions for assembly (parse, score, tier, render) |
| `assemble-llm.mjs` | LLM-facing functions used by assembler |
| `validate-cv.mjs` | Structural validator |
| `validate-core.mjs` | Validation check functions |
| `tests/*` | Unit + E2E test files |
| `__fixtures__/*` | Test fixtures (synthetic experience_source + profile + JDs) |
| `config/synonyms.yml` | Keyword scoring synonyms |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**

## Note on cv.md (removed)

This fork removes `cv.md` as a hand-edited file. All CV content lives in
`experience_source/{company}/{facet}.md`. A per-JD `cv.tailored.md` is
produced by `assemble-cv.mjs --jd=<path>` and consumed by every mode that
has a JD in context. `cv.tailored.md` is gitignored.
