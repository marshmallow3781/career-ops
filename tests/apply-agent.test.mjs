import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runApplyAgent } from '../lib/apply-agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, 'fixtures/apply');

function mockLlmClient(sequence) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const text = sequence[i++] || sequence[sequence.length - 1];
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

const profile = {
  personal: { full_name: 'Test User', email: 't@x.com', phone: '555', address: '1 Main', city: 'SF', province_state: 'CA', country: 'US', postal_code: '94102' },
  work_authorization: { legally_authorized_to_work: 'Yes', require_sponsorship: 'No' },
  availability: { earliest_start_date: 'Immediately' },
  compensation: { salary_expectation: '200000', salary_currency: 'USD' },
  experience: { years_of_experience_total: '5', education_level: "Bachelor's Degree" },
  eeo_voluntary: { gender: 'Decline', race_ethnicity: 'Decline', veteran_status: 'Not a protected veteran', disability_status: 'Prefer not' },
};

const job = { company: 'Acme', title: 'Senior Backend Engineer', url: `file://${FIX}/apply_form.html` };
const files = { resume_pdf: '/tmp/resume.pdf', cover_letter_pdf: '/tmp/cl.pdf', cover_letter_text: 'Dear...' };

test('runApplyAgent: apply_form + dry-run → DryRun status', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'apply_form', confidence: 0.95, evidence: 'form present' }),
    JSON.stringify({
      actions: [
        { type: 'fill', selector: 'input[name="name"]', value: 'Test User' },
        { type: 'fill', selector: 'input[name="email"]', value: 't@x.com' },
        { type: 'fill', selector: 'textarea[name="cover"]', value: 'Dear...' },
        { type: 'submit_final', selector: 'button[type="submit"]', reason: 'ready to submit' },
      ],
    }),
    JSON.stringify({ page_type: 'confirmation', confidence: 0.9, evidence: 'thank you' }),
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const result = await runApplyAgent({
      job, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 10, traceDir: null,
    });
    assert.equal(result.status, 'DryRun');
    assert.ok(result.stepCount >= 1);
  } finally {
    await browser.close();
  }
});

test('runApplyAgent: dead_end page → Skipped status', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'dead_end', confidence: 0.95, evidence: 'no longer accepting' }),
  ]);
  const browser = await chromium.launch({ headless: true });
  const deadJob = { ...job, url: `file://${FIX}/dead_end.html` };
  try {
    const result = await runApplyAgent({
      job: deadJob, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 10, traceDir: null,
    });
    assert.equal(result.status, 'Skipped');
    assert.match(result.reason || '', /dead_end/);
  } finally {
    await browser.close();
  }
});

test('runApplyAgent: redirect → follow to form → fill → DryRun', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'redirect', confidence: 0.9, evidence: 'apply button' }),
    JSON.stringify({ actions: [{ type: 'click', selector: 'a#apply-link', reason: 'follow redirect' }] }),
    JSON.stringify({ page_type: 'apply_form', confidence: 0.9, evidence: 'form' }),
    JSON.stringify({
      actions: [
        { type: 'fill', selector: 'input[name="name"]', value: 'Test User' },
        { type: 'submit_final', selector: 'button[type="submit"]', reason: 'ready' },
      ],
    }),
    JSON.stringify({ page_type: 'confirmation', confidence: 0.9, evidence: 'thank you' }),
  ]);
  const browser = await chromium.launch({ headless: true });
  const redirJob = { ...job, url: `file://${FIX}/redirect.html` };
  try {
    const result = await runApplyAgent({
      job: redirJob, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 10, traceDir: null,
    });
    assert.equal(result.status, 'DryRun');
  } finally {
    await browser.close();
  }
});

test('runApplyAgent: step cap reached → Failed status', { timeout: 30000 }, async () => {
  const client = mockLlmClient([
    JSON.stringify({ page_type: 'apply_form', confidence: 0.9, evidence: 'form' }),
    JSON.stringify({ actions: [{ type: 'fill', selector: 'input[name="name"]', value: 'x' }] }),
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const result = await runApplyAgent({
      job, profile, files, llmClient: client, llmConfig: { provider: 'anthropic', model: 'x' },
      browser, submit: false, maxSteps: 2, traceDir: null,  // cap at 2
    });
    assert.equal(result.status, 'Failed');
    assert.match(result.reason || '', /step_cap/);
  } finally {
    await browser.close();
  }
});
