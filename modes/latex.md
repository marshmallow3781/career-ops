# Mode: latex — LaTeX/Overleaf CV Export

Export a tailored, ATS-optimized CV as a `.tex` file and compile it to PDF via `pdflatex`.

## Pipeline (this fork)

1. If JD not in context, follow Paso 0 of auto-pipeline.
2. Save JD to `jds/{slug}.md`.
3. Run: `node assemble-cv.mjs --jd=jds/{slug}.md`
4. Run: `node validate-cv.mjs cv.tailored.md` (≤3 retries with `--feedback=.cv-tailored-errors.json` on failure).
5. Read `cv.tailored.md` and `config/profile.yml`. Fill `templates/cv-template.tex` placeholders.
6. Write to `/tmp/cv-{candidate}-{company}-{YYYY-MM-DD}.tex`.
7. Run: `node generate-latex.mjs /tmp/cv-{candidate}-{company}-{YYYY-MM-DD}.tex output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf`
8. Archive: `cp cv.tailored.md output/cv-tailored-{company}-{YYYY-MM-DD}.md`
9. Report: .tex path, .pdf path, file sizes, section count, keyword coverage %.

**Requires:** `pdflatex` on PATH (MiKTeX or TeX Live). First compilation may auto-install missing LaTeX packages via MiKTeX.

## Template Placeholders

The template at `templates/cv-template.tex` uses `{{PLACEHOLDER}}` syntax:

| Placeholder | Source |
|-------------|--------|
| `{{NAME}}` | `profile.yml → candidate.full_name` |
| `{{CONTACT_LINE}}` | Phone / City, State / Visa status — built from profile.yml |
| `{{EMAIL_URL}}` | Raw email for `mailto:` URL — must not be LaTeX-escaped (from profile.yml) |
| `{{EMAIL_DISPLAY}}` | Escaped email for display text — LaTeX-special chars like `_` must be escaped, e.g. `first\_name@example.com` |
| `{{LINKEDIN_URL}}` | Full URL with scheme for `\href{}`: e.g. `https://linkedin.com/in/username`. If `profile.yml` stores a bare host+path (no scheme), prepend `https://` before substitution. |
| `{{LINKEDIN_DISPLAY}}` | Display text only (no scheme): `linkedin.com/in/username` |
| `{{GITHUB_URL}}` | Full URL with scheme for `\href{}`: e.g. `https://github.com/username`. If `profile.yml` stores a bare host+path, prepend `https://`. |
| `{{GITHUB_DISPLAY}}` | Display text only (no scheme): `github.com/username` |
| `{{EDUCATION}}` | LaTeX `\resumeSubheading` blocks from `config/profile.yml` (or `cv.tailored.md` Education section if present) |
| `{{EXPERIENCE}}` | LaTeX `\resumeSubheading` + `\resumeItem` blocks — reordered bullets |
| `{{SKILLS}}` | LaTeX `\textbf{Category}{: items}` lines from `cv.tailored.md` Core Competencies |

**IMPORTANT (user preference):** This template intentionally has NO "Personal Projects"
section. Do NOT synthesize, add, or emit any project-related content — no
`\resumeProjectHeading`, no `{{PROJECTS}}` placeholder, no "Projects" section header,
no standalone project descriptions. Personal work and side projects belong in
`article-digest.md` (which the LLM reads for other modes) but must NOT appear in
the generated `.tex` output.

## LaTeX Content Generation Rules

### Education

Each entry becomes:

```latex
    \resumeSubheading
    {Institution}{City, State}
    {Degree}{Date Range}
```

If coursework exists, add:

```latex
        \resumeItemListStart
            \resumeItem{\textbf{Coursework:} Course1, Course2, ...}
        \resumeItemListEnd
```

### Experience

Each role becomes:

```latex
    \resumeSubheading
      {Company}{Date Range}
      {Role Title}{Location}
      \resumeItemListStart
        \resumeItem{Bullet text with JD keywords injected}
        ...
      \resumeItemListEnd
```

### Skills

```latex
    \textbf{Languages}{: C, C++, Java, ...} \\
    \textbf{Frameworks \& ML}{: PyTorch, LangChain, ...} \\
    \textbf{Tools \& Cloud}{: Docker, Kubernetes, ...}
```

## LaTeX Escaping (CRITICAL)

All text content MUST be escaped for LaTeX before insertion:

| Character | Escape |
|-----------|--------|
| `&` | `\&` |
| `%` | `\%` |
| `$` | `\$` |
| `#` | `\#` |
| `_` | `\_` |
| `{` | `\{` |
| `}` | `\}` |
| `~` | `\textasciitilde{}` |
| `^` | `\textasciicircum{}` |
| `\` | `\textbackslash{}` |
| `±` | `$\pm$` |
| `→` | `$\rightarrow$` |

**Exception:** Do NOT escape LaTeX commands themselves (`\resumeItem`, `\textbf`, etc.) — only user-supplied text content.

**Exception for URLs:** Do NOT escape text inside `\href{URL}{...}` first arguments. The URL must remain raw (or RFC 3986 percent-encoded). Only escape the *display text* (second argument). For example:
```latex
\href{https://example.com/path_with_underscores}{Example\_Display}
```

## ATS Rules (same as pdf mode)

- Single-column layout (enforced by template)
- Standard section headers: Education, Work Experience, Technical Skills (NO Projects section)
- UTF-8, machine-readable via `\pdfgentounicode=1`
- Keywords distributed: first bullet of each role, skills section
- No images, no graphics, no color in body text

## Keyword Injection Strategy

Same ethical rules as `modes/pdf.md`:
- NEVER add skills the candidate doesn't have
- Only reformulate existing experience using JD vocabulary
- Examples:
  - JD says "RAG pipelines" → reword "LLM workflows with retrieval" to "RAG pipeline design"
  - JD says "MLOps" → reword "observability, evals" to "MLOps and observability"

## Overleaf Compatibility

The generated `.tex` file uses only standard CTAN packages (no custom or bundled dependencies):

- `latexsym`, `fullpage`, `titlesec`, `marvosym`, `color`, `verbatim`, `enumitem`
- `hyperref`, `fancyhdr`, `babel`, `tabularx`, `fontawesome5`, `multicol`, `glyphtounicode`

Upload the `.tex` file directly to Overleaf — compiles with no extra configuration.
