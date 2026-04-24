import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveCaptcha, getBalance } from '../lib/capsolver.mjs';

// Mock fetch for deterministic tests
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    const next = responses.shift();
    return {
      ok: true,
      async json() { return next; },
    };
  };
  return calls;
}

test('solveCaptcha: hCaptcha happy path', async () => {
  const calls = mockFetch([
    { errorId: 0, taskId: 'task-123' },
    { errorId: 0, status: 'processing' },
    { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'TOKEN_XYZ' } },
  ]);
  const token = await solveCaptcha({
    type: 'HCaptchaTaskProxyless',
    siteKey: 'SITE_KEY',
    pageUrl: 'https://example.com/apply',
    apiKey: 'test-key',
    pollMs: 10,
  });
  assert.equal(token, 'TOKEN_XYZ');
  assert.equal(calls[0].url, 'https://api.capsolver.com/createTask');
  assert.equal(calls[0].body.task.type, 'HCaptchaTaskProxyless');
  assert.equal(calls[0].body.task.websiteKey, 'SITE_KEY');
});

test('solveCaptcha: throws on errorId', async () => {
  mockFetch([
    { errorId: 1, errorDescription: 'invalid key' },
  ]);
  await assert.rejects(
    () => solveCaptcha({ type: 'HCaptchaTaskProxyless', siteKey: 'x', pageUrl: 'y', apiKey: 'bad' }),
    /invalid key/,
  );
});
