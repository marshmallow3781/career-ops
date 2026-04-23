# CV Picker Mode — Design Spec

**Date:** 2026-04-23
**Status:** Draft
**Type:** New feature, parallel to existing bullet-assembler
**Scope:** Single-file flag + small helper library; no changes to downstream modes.

## 1. Problem

The current CV flow (`assemble-cv.mjs`) synthesizes a per-JD `cv.tailored.md` by
picking bullets from `experience_source/{company}/{facet}.md` files through an
LLM-scored tier system. This is the right design when the user wants maximum
customization per JD.

But the user has three pre-made full resumes saved as PDFs:

- `resumes/backend_ai_2.0.pdf`
- `resumes/fullstack_ai_2.0.pdf`
- `resumes/infra_2.0.pdf`

For many applications, those are the answer — one of them is already the right
resume for the role, and per-bullet synthesis is overkill.

We need a **parallel mode** on the same `assemble-cv.mjs` entry point that:
classifies the JD archetype, maps it to one of the PDFs, extracts the PDF text
into `cv.tailored.md`, and lets every downstream mode (`oferta`, `pipeline`,
`contacto`, `deep`) continue to work unchanged.

## 2. Goals and non-goals

**Goals**
- Zero changes to downstream modes — they still read `cv.tailored.md`.
- Zero new npm dependencies — reuse `pdftotext` which is already installed.
- Configurable archetype → PDF mapping (user will add more resumes later).
- Graceful handling of missing/unmapped PDFs.

**Non-goals**
- No PDF generation — the user's resumes are already PDFs, ready to hand to
  recruiters. This flow only produces the text form that downstream modes read.
- No replacement of the bullet-assembler — both modes coexist; the user picks
  per-run.
- No changes to `validate-cv.mjs` — the extracted text goes through the existing
  validator unchanged. (If it flags anything, that's a signal to fix the
  resume PDF.)

## 3. User invocation

```bash
node assemble-cv.mjs --jd=jds/company-role.md --mode=picker
```

Flag semantics:
- `--mode=picker` → new behavior described below.
- `--mode=assembler` or flag omitted → existing bullet-assembler flow (unchanged).
- `--archetype=<name>` → override the LLM classifier (existing flag, reused).

## 4. Archetype → resume mapping

Added under `config/profile.yml`:

```yaml
cv:
  picker:
    resumes_dir: resumes
    archetype_map:
      backend: backend_ai_2.0.pdf
      infra: infra_2.0.pdf
      fullstack: fullstack_ai_2.0.pdf
      frontend: fullstack_ai_2.0.pdf        # reuses fullstack for now
      machine_learning: applied_ai_2.0.pdf  # file not yet present
      applied_ai: applied_ai_2.0.pdf        # file not yet present
      # 'unknown' deliberately absent — produces placeholder CV
```

Resolution rules:
- `resolvePickerResume(archetype, config)` returns `{ path, filename }` when the
  archetype is in the map AND the file exists on disk.
- Returns `{ missing: true, filename }` when the archetype is in the map but the
  file is not yet on disk.
- Returns `{ missing: true, filename: null }` when the archetype is absent from
  the map (including `unknown`).

## 5. Output files

**`cv.tailored.md`** — one of:
- `pdftotext <path> -` stdout, trimmed, no post-processing.
- Or a placeholder when no PDF is resolvable:
  ```markdown
  # No resume for archetype `<archetype>`

  The picker mode could not find a resume to use:
  - Mapped filename: `<filename>` (not found in `resumes/`)
  - OR the archetype is not in `config/profile.yml` → `cv.picker.archetype_map`.

  Add the file to `resumes/` and re-run, or map the archetype to an existing
  resume.
  ```

**`.cv-tailored-meta.json`**:

```json
{
  "mode": "picker",
  "archetype": "backend",
  "source_pdf": "resumes/backend_ai_2.0.pdf",
  "extracted_at": "2026-04-23T22:00:00Z"
}
```

When the PDF is missing, `source_pdf` is the *expected* filename (not a path to
a nonexistent file) and a `missing: true` field is added.

## 6. Code structure

**New file: `lib/picker.mjs`** (≈80 lines)

```js
export function resolvePickerResume(archetype, pickerConfig)
// Returns { path?, filename?, missing?, reason? }.

export async function extractPdfText(pdfPath)
// Spawns `pdftotext <pdfPath> -`, returns stdout as string.
// Throws with install hint if the binary is missing.

export function buildPlaceholderCv(archetype, filename)
// Returns the markdown string for the "no resume" case.
```

**Modified: `assemble-cv.mjs`**

- Parse `--mode` flag (default `assembler` for back-compat).
- Branch at the top of `main()`:
  - `mode === 'picker'` → call new `runPickerMode(args, profile)`, write
    outputs, exit.
  - Otherwise → fall through to existing code path.

**Unchanged:**
- `classifyArchetype` — reused.
- `validate-cv.mjs` — can be run on picker output; no code changes.
- All downstream modes (`oferta`, `pipeline`, `contacto`, `deep`, `pdf`,
  `latex`) — all read `cv.tailored.md` as before.

## 7. Edge cases

| Case | Behavior |
|---|---|
| `pdftotext` binary missing | Hard error, suggest `brew install poppler`. |
| Archetype classifier returns `unknown` | Placeholder CV; sidecar archetype=`unknown`. |
| Mapped PDF file missing on disk | Placeholder CV referencing expected filename; exits 0 so the user sees the placeholder in downstream outputs. |
| Empty PDF (pdftotext returns 0 bytes) | Write whatever pdftotext produced; rely on `validate-cv.mjs` to flag it if structurally empty. |
| `resumes_dir` missing or empty | Same as "mapped PDF missing" — placeholder + sidecar. |
| `profile.yml` has no `cv.picker` block | Default `resumes_dir: resumes`; empty map → every archetype produces placeholder. |
| `--archetype=X --mode=picker` | Use the CLI-supplied archetype, skip the classifier. |

## 8. Testing plan

New file `tests/picker.test.mjs`:

1. `resolvePickerResume: returns path for mapped archetype with existing file` — uses fixture resume in `tests/fixtures/resumes/`.
2. `resolvePickerResume: returns missing=true for mapped archetype with no file on disk`.
3. `resolvePickerResume: returns missing=true + filename=null for unknown archetype`.
4. `resolvePickerResume: returns missing=true + filename=null for unmapped archetype`.
5. `extractPdfText: happy path on a tiny fixture PDF`.
6. `extractPdfText: throws with install hint when binary missing` (mock via PATH manipulation).
7. `buildPlaceholderCv: includes archetype and filename in output`.
8. End-to-end: run `assemble-cv.mjs --mode=picker --jd=<fixture>` via spawn, assert `cv.tailored.md` contains fixture PDF text and sidecar has correct fields.
9. End-to-end: same, with missing mapped PDF → assert placeholder CV.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| PDF extraction loses crucial formatting (tables, columns) | Accept it — resumes are normally single-column. Downstream modes care about content, not layout. |
| User forgets to set up `cv.picker` block | Default to `resumes_dir: resumes` and empty map; graceful placeholder behavior. |
| Archetype classifier produces `unknown` often | Orthogonal — same issue exists in assembler mode. Sidecar records it so the user can see if it's frequent. |
| User's PDF is scanned (images, not text) | `pdftotext` produces empty output. `validate-cv.mjs` will flag. User swaps in a text-searchable PDF. |

## 10. Rollout

- No migration needed — this is additive.
- No changes to data contract, Mongo schema, or existing file formats.
- Existing `assemble-cv.mjs` users are unaffected (default mode preserved).
- User can try picker mode on one JD, compare output to assembler mode, adopt
  selectively.
