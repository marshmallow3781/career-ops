/**
 * lib/capsolver.mjs — capsolver.com API wrapper for CAPTCHA solving.
 *
 * Used by the auto-apply agent. Personal fork override of CLAUDE.md's
 * "never auto-submit" rule; see docs/superpowers/specs/2026-04-24-auto-apply-agent-design.md §1.
 *
 * Supported types: HCaptchaTaskProxyless, RecaptchaV2TaskProxyless,
 * RecaptchaV3TaskProxyless, TurnstileTaskProxyless, FunCaptchaTaskProxyless.
 */

const API_BASE = 'https://api.capsolver.com';

/**
 * Solve a CAPTCHA challenge. Creates a task, polls until ready, returns token.
 *
 * @param {object} p
 * @param {string} p.type - CapSolver task type
 * @param {string} p.siteKey - website captcha sitekey
 * @param {string} p.pageUrl - the page URL containing the captcha
 * @param {string} p.apiKey - capsolver API key
 * @param {number} [p.pollMs=5000] - polling interval
 * @param {number} [p.maxWaitMs=120000] - give up after this long
 * @returns {Promise<string>} the captcha solution token
 */
export async function solveCaptcha({ type, siteKey, pageUrl, apiKey, pollMs = 5000, maxWaitMs = 120000 }) {
  if (!apiKey) throw new Error('capsolver: missing apiKey');

  const createRes = await fetch(`${API_BASE}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type, websiteURL: pageUrl, websiteKey: siteKey },
    }),
  });
  const createJson = await createRes.json();
  if (createJson.errorId) {
    throw new Error(`capsolver createTask: ${createJson.errorDescription || 'unknown error'}`);
  }
  const taskId = createJson.taskId;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const json = await res.json();
    if (json.errorId) throw new Error(`capsolver getTaskResult: ${json.errorDescription || 'unknown'}`);
    if (json.status === 'ready') {
      const sol = json.solution || {};
      return sol.gRecaptchaResponse || sol.token || sol.text || JSON.stringify(sol);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`capsolver: timed out after ${maxWaitMs}ms`);
}

/**
 * Query the account balance in USD. Returns a number.
 */
export async function getBalance(apiKey) {
  if (!apiKey) throw new Error('capsolver: missing apiKey');
  const res = await fetch(`${API_BASE}/getBalance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey }),
  });
  const json = await res.json();
  if (json.errorId) throw new Error(`capsolver getBalance: ${json.errorDescription || 'unknown'}`);
  return Number(json.balance || 0);
}
