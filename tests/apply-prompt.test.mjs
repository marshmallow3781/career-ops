import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPagePrompt, planActionPrompt, parseClassifyResponse, parsePlanResponse } from '../lib/apply-prompt.mjs';

test('classifyPagePrompt: includes a11y tree + instructs JSON output', () => {
  const prompt = classifyPagePrompt({
    a11yTree: { role: 'main', children: [{ role: 'button', name: 'Apply' }] },
    url: 'https://linkedin.com/jobs/view/123',
  });
  assert.ok(prompt.includes('"role": "button"'));
  assert.ok(prompt.includes('page_type'));
  assert.ok(prompt.match(/apply_form|redirect|already_applied|captcha|dead_end|confirmation/));
});

test('parseClassifyResponse: extracts JSON from LLM text', () => {
  const r = parseClassifyResponse('Here is my analysis:\n{"page_type":"apply_form","confidence":0.9,"evidence":"form with name input"}');
  assert.equal(r.page_type, 'apply_form');
  assert.equal(r.confidence, 0.9);
});

test('parsePlanResponse: returns actions array with known types', () => {
  const r = parsePlanResponse(JSON.stringify({
    actions: [
      { type: 'fill', selector: '#email', value: 'x@y.com' },
      { type: 'upload', selector: '#resume', value: '/tmp/r.pdf' },
      { type: 'click', selector: 'button.submit' },
    ],
  }));
  assert.equal(r.actions.length, 3);
  assert.equal(r.actions[0].type, 'fill');
  assert.equal(r.actions[1].type, 'upload');
});
