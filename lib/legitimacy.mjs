/**
 * lib/legitimacy.mjs — Playwright headless check for Block G (Posting Legitimacy).
 *
 * No LLM. Pure DOM inspection against positive/negative signal heuristics.
 */
import { chromium } from 'playwright';

const POSITIVE_SIGNALS = {
  has_h1: (text) => text.match(/<h1[^>]*>[^<]{5,200}<\/h1>/i) !== null,
  has_long_description: (text) => {
    const m = text.match(/<(?:section|div)[^>]*(?:description|job-description)[^>]*>([\s\S]{500,})<\/(?:section|div)>/i);
    return m !== null || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length > 800;
  },
  has_apply_button: (text) => /\bapply\s*(now|today|here)?\b/i.test(text) && /<(button|a)[^>]*>[^<]*apply/i.test(text),
};

const NEGATIVE_SIGNALS = {
  no_longer_accepting: /no\s+longer\s+accepting\s+applications?/i,
  job_not_found: /job\s+not\s+found|404|page\s+not\s+found/i,
};

// Hosts that auth-gate job content from unauthenticated visitors, making
// signal-based legitimacy checks unreliable (we see a stripped "join to
// view" page, not the real job). For these, return `unverified` rather
// than misreporting them as `suspicious`.
const AUTH_GATED_HOSTS = new Set([
  'linkedin.com', 'www.linkedin.com',
  'glassdoor.com', 'www.glassdoor.com',
  'indeed.com', 'www.indeed.com',
]);

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * @param {string} jobUrl
 * @param {object} [opts]
 * @param {number} [opts.timeout=15000] page.goto timeout ms
 * @returns {Promise<{tier: 'confirmed'|'likely'|'suspicious'|'unverified', signals: string[], reason?: string}>}
 */
export async function verifyLegitimacy(jobUrl, { timeout = 15000 } = {}) {
  const host = hostOf(jobUrl);
  if (AUTH_GATED_HOSTS.has(host)) {
    return { tier: 'unverified', signals: [], reason: `auth-gated host (${host}) — can't verify without login` };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout });
    const html = await page.content();

    const hits = [];
    for (const [name, check] of Object.entries(POSITIVE_SIGNALS)) {
      if (check(html)) hits.push(name);
    }
    const negatives = [];
    for (const [name, re] of Object.entries(NEGATIVE_SIGNALS)) {
      if (re.test(html)) negatives.push(name);
    }

    if (negatives.length > 0) return { tier: 'suspicious', signals: negatives };
    if (hits.length >= 2) return { tier: 'confirmed', signals: hits };
    if (hits.length >= 1) return { tier: 'likely', signals: hits };
    return { tier: 'suspicious', signals: ['no_positive_signals'] };
  } catch (err) {
    return { tier: 'unverified', signals: [], reason: err.message || String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
