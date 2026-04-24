/**
 * lib/apply-prompt.mjs — prompts for the auto-apply agent.
 *
 * Ports ApplyPilot's (ApplyPilot/src/applypilot/apply/prompt.py) prompt
 * engineering but uses our own schema. Two prompt functions:
 *   - classifyPagePrompt — asks the LLM to label the current page type
 *   - planActionPrompt   — asks the LLM to propose the next action(s)
 *
 * Personal fork override of CLAUDE.md's "never auto-submit" rule; see
 * docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 */

const PAGE_TYPES = ['apply_form', 'redirect', 'already_applied', 'captcha', 'dead_end', 'confirmation'];

/**
 * Build the prompt for page-type classification.
 *
 * @param {object} p
 * @param {object} p.a11yTree - Playwright page.accessibility.snapshot() output
 * @param {string} p.url - current URL
 * @returns {string} the full user-message prompt
 */
export function classifyPagePrompt({ a11yTree, url }) {
  return `You are classifying the current browser page for a job application agent.

Current URL: ${url}

Accessibility tree (JSON):
${JSON.stringify(a11yTree, null, 2).slice(0, 6000)}

Classify the page. Return ONLY JSON matching this schema:
{
  "page_type": one of ${JSON.stringify(PAGE_TYPES)},
  "confidence": number 0.0-1.0,
  "evidence": "short phrase describing the decisive signal"
}

Definitions:
- apply_form: a form with input fields we should fill (name, email, resume upload, cover letter, etc.)
- redirect: a job-detail page with an "Apply" button we should click to go to the real form
- already_applied: a page stating the user has already submitted an application
- captcha: a CAPTCHA challenge we need to solve before proceeding
- dead_end: 404, "No longer accepting applications", "job not found", or auth wall
- confirmation: a post-submission success page confirming the application was received`;
}

/**
 * Build the prompt for planning the next batch of actions.
 *
 * @param {object} p
 * @param {string} p.pageType - from prior classify step
 * @param {object} p.a11yTree - Playwright accessibility tree
 * @param {string} p.url - current URL
 * @param {object} p.profile - application_form_defaults block
 * @param {object} p.job - { company, title, jd_text }
 * @param {object} p.files - { resume_pdf, cover_letter_pdf, cover_letter_text }
 * @param {Array} p.stepHistory - previous steps (prevents loops)
 * @returns {string} the full user-message prompt
 */
export function planActionPrompt({ pageType, a11yTree, url, profile, job, files, stepHistory }) {
  const profileStr = JSON.stringify(profile, null, 2);
  const jobStr = JSON.stringify({ company: job.company, title: job.title }, null, 2);
  const filesStr = JSON.stringify(files, null, 2);
  const historyStr = stepHistory?.length
    ? stepHistory.slice(-5).map((s, i) => `Step ${stepHistory.length - 5 + i + 1}: ${s.type} ${s.selector || ''}`).join('\n')
    : '(none)';

  return `You are driving a Playwright browser to fill a job application form.

Page type: ${pageType}
Current URL: ${url}
Recent actions:
${historyStr}

Accessibility tree (JSON):
${JSON.stringify(a11yTree, null, 2).slice(0, 10000)}

Applicant profile (use these values verbatim where they match form fields):
${profileStr}

Target job:
${jobStr}

Local files available:
${filesStr}

Return ONLY JSON matching this schema:
{
  "actions": [
    { "type": "fill" | "click" | "upload" | "select" | "solve_captcha" | "submit_final" | "done_success" | "done_failed",
      "selector": string,      // CSS selector or a11y accessibleName
      "value": string,         // for fill/select/upload; path for upload
      "reason": string         // short explanation for the action
    },
    ...
  ]
}

Rules:
- Plan the complete form fill in one batch — 5-20 actions is typical.
- Use file paths from <files> for upload actions.
- For EEO questions, use the "Decline" / "Prefer not to answer" values from profile when present.
- The FINAL action of a successful fill MUST be { "type": "submit_final", "selector": "<the Submit button>", ... }.
- If the page is already_applied or dead_end, return { "actions": [{ "type": "done_failed", "reason": "<why>" }] }.
- If the page is confirmation (post-submit), return { "actions": [{ "type": "done_success", "reason": "confirmed" }] }.
- Never invent profile values. If a required field has no value in profile, return done_failed.
- Never re-submit if a recent action was submit_final.`;
}

/**
 * Extract the classify JSON from an LLM text response (handles prose prefix).
 */
export function parseClassifyResponse(text) {
  return _extractJson(text) || { page_type: 'dead_end', confidence: 0, evidence: 'parse_failed' };
}

/**
 * Extract the plan JSON from an LLM text response.
 */
export function parsePlanResponse(text) {
  const parsed = _extractJson(text);
  if (!parsed || !Array.isArray(parsed.actions)) {
    return { actions: [{ type: 'done_failed', reason: 'parse_failed' }] };
  }
  return parsed;
}

// Same brace-counting extractor as digest-builder.mjs (pattern locked by
// the earlier brace-counter hardening commit 9d5c248).
function _extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end === -1) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
