/**
 * lib/apply-agent.mjs — single-job auto-apply agent loop.
 *
 * Drives a Playwright Chromium instance to fill and (optionally) submit a
 * job application form. Uses MiniMax image-01 for vision + M2.7 for text
 * via the existing initLlm() factory. Ports ApplyPilot's agent loop
 * pattern but runs in-process.
 *
 * Personal fork override of CLAUDE.md's "never auto-submit" rule; see
 * docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyPagePrompt, planActionPrompt,
  parseClassifyResponse, parsePlanResponse,
} from './apply-prompt.mjs';

const DEFAULT_MAX_STEPS = 25;

/**
 * Run the apply agent for a single job.
 *
 * @param {object} p
 * @param {object} p.job - Mongo jobs doc (company, title, url, etc.)
 * @param {object} p.profile - application_form_defaults block from profile.yml
 * @param {object} p.files - { resume_pdf, cover_letter_pdf, cover_letter_text } absolute paths
 * @param {object} p.llmClient - initLlm() client
 * @param {object} p.llmConfig - initLlm() config
 * @param {object} p.browser - Playwright browser instance
 * @param {boolean} p.submit - if true, click real Submit; else stop at submit_final action
 * @param {number} [p.maxSteps=25]
 * @param {string|null} [p.traceDir] - directory for screenshots/actions/dom; null to skip
 * @param {Function} [p.capsolve] - async fn({type,siteKey,pageUrl}) → token; null to mark Failed on captcha
 * @returns {Promise<{status: 'Applied'|'DryRun'|'Failed'|'Skipped', reason?: string, stepCount: number}>}
 */
export async function runApplyAgent({
  job, profile, files, llmClient, llmConfig, browser,
  submit = false, maxSteps = DEFAULT_MAX_STEPS, traceDir = null,
  capsolve = null,
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const stepHistory = [];
  let result = { status: 'Failed', reason: 'loop_exit_without_outcome', stepCount: 0 };

  if (traceDir) mkdirSync(traceDir, { recursive: true });
  const actionsLogPath = traceDir ? join(traceDir, 'actions.jsonl') : null;

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    result = { status: 'Skipped', reason: `nav_error: ${e.message.slice(0, 80)}`, stepCount: 0 };
    await context.close();
    return result;
  }

  for (let step = 1; step <= maxSteps; step++) {
    result.stepCount = step;

    if (traceDir) {
      try { await page.screenshot({ path: join(traceDir, `step_${String(step).padStart(3, '0')}.png`) }); }
      catch { /* ignore */ }
    }

    // page.accessibility was removed in Playwright 1.47+; use ariaSnapshot() instead.
    // ariaSnapshot returns a YAML string; wrap it in an object for the prompt.
    const a11yTree = await page.ariaSnapshot().then(yaml => ({ role: 'page', snapshot: yaml })).catch(() => ({ role: 'page', children: [] }));
    const url = page.url();

    // Classify page
    const classifyText = await _llmCall(llmClient, llmConfig, classifyPagePrompt({ a11yTree, url }));
    const classify = parseClassifyResponse(classifyText);

    if (classify.page_type === 'already_applied') {
      result = { status: 'Skipped', reason: 'already_applied', stepCount: step };
      break;
    }
    if (classify.page_type === 'dead_end') {
      result = { status: 'Skipped', reason: `dead_end: ${classify.evidence || 'no-signal'}`, stepCount: step };
      break;
    }
    if (classify.page_type === 'confirmation') {
      result = { status: submit ? 'Applied' : 'DryRun', reason: 'confirmation_page', stepCount: step };
      break;
    }
    if (classify.page_type === 'captcha') {
      if (!capsolve) {
        result = { status: 'Failed', reason: 'captcha_no_solver', stepCount: step };
        break;
      }
      try {
        const siteKey = _extractCaptchaSiteKey(a11yTree);
        const token = await capsolve({ type: 'HCaptchaTaskProxyless', siteKey, pageUrl: url });
        await page.evaluate((t) => {
          const el = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]');
          if (el) el.value = t;
        }, token);
        stepHistory.push({ type: 'solve_captcha', selector: null });
        continue;
      } catch (e) {
        result = { status: 'Failed', reason: `captcha_solve: ${e.message.slice(0, 80)}`, stepCount: step };
        break;
      }
    }

    // Plan next actions
    const planText = await _llmCall(llmClient, llmConfig, planActionPrompt({
      pageType: classify.page_type, a11yTree, url, profile, job, files, stepHistory,
    }));
    const plan = parsePlanResponse(planText);

    let breakLoop = false;
    for (const action of plan.actions) {
      if (actionsLogPath) appendFileSync(actionsLogPath, JSON.stringify({ t: Date.now(), step, ...action }) + '\n');
      stepHistory.push({ type: action.type, selector: action.selector });

      if (action.type === 'done_success') { result = { status: submit ? 'Applied' : 'DryRun', reason: action.reason || 'done', stepCount: step }; breakLoop = true; break; }
      if (action.type === 'done_failed')  { result = { status: 'Failed', reason: action.reason || 'agent_decided_failed', stepCount: step }; breakLoop = true; break; }

      try {
        const locator = _resolveLocator(page, action.selector);
        if (action.type === 'click')  await locator.click({ timeout: 5000 });
        else if (action.type === 'fill')   await locator.fill(String(action.value ?? ''), { timeout: 5000 });
        else if (action.type === 'upload') await locator.setInputFiles(action.value);
        else if (action.type === 'select') await locator.selectOption(String(action.value ?? ''));
        else if (action.type === 'submit_final') {
          if (submit) {
            await locator.click({ timeout: 5000 });
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            // loop re-classifies on next iteration; we expect confirmation
          } else {
            result = { status: 'DryRun', reason: 'submit_final_skipped', stepCount: step };
            breakLoop = true; break;
          }
        }
      } catch (err) {
        result = { status: 'Failed', reason: `action_error: ${action.type} ${err.message.slice(0, 60)}`, stepCount: step };
        breakLoop = true; break;
      }
    }

    if (breakLoop) break;

    if (step === maxSteps) {
      result = { status: 'Failed', reason: 'step_cap', stepCount: step };
    }
  }

  // Dump final DOM for trace
  if (traceDir) {
    try {
      const dom = await page.content();
      writeFileSync(join(traceDir, 'final_dom.html'), dom);
      writeFileSync(join(traceDir, 'meta.json'), JSON.stringify({
        job_id: job.linkedin_id || job.url, company: job.company, title: job.title,
        mode: submit ? 'submit' : 'dry_run', outcome: result.status,
        stepCount: result.stepCount, reason: result.reason || null,
        ended_at: new Date().toISOString(),
      }, null, 2));
    } catch { /* ignore */ }
  }

  await context.close();
  return result;
}

async function _llmCall(client, config, userMessage) {
  // Uses the anthropic code path (works with MiniMax via ANTHROPIC_BASE_URL).
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 2500,
    temperature: 0,
    messages: [{ role: 'user', content: userMessage }],
  });
  return (response.content || [])
    .filter(b => typeof b?.text === 'string')
    .map(b => b.text).join('\n').trim();
}

/**
 * Resolve a selector string to a Playwright locator. Supports two common
 * formats the LLM emits:
 *   - accessibility role+name:  `button "Apply"` or `link "Apply Now"` →
 *     page.getByRole('button', { name: 'Apply' })
 *   - CSS selector (default): `#foo`, `button[type="submit"]`, etc.
 *
 * Without this, LLM-emitted a11y-style selectors crash Playwright's CSS
 * parser with "Unexpected token" errors.
 */
function _resolveLocator(page, selector) {
  if (typeof selector !== 'string') return page.locator(String(selector));
  // role+name form: single role token followed by a quoted string
  const m = selector.match(/^\s*([a-z]+)\s+"([^"]+)"\s*$/i);
  if (m) {
    const [, role, name] = m;
    return page.getByRole(role, { name });
  }
  return page.locator(selector);
}

function _extractCaptchaSiteKey(a11yTree) {
  // Walk the a11y tree for a node mentioning a sitekey attribute.
  const stack = [a11yTree];
  while (stack.length) {
    const n = stack.pop();
    if (n?.value && typeof n.value === 'string' && n.value.length > 16) return n.value;
    if (n?.children) stack.push(...n.children);
  }
  return '';
}
