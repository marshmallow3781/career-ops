/**
 * assemble-llm.mjs — LLM-facing functions (dependency-injected client for testability).
 *
 * Three calls per assembly:
 *   1. classifyArchetype(jd)         → "frontend" | "backend" | ...
 *   2. pickBullets(pool, jd, tier)   → selected bullets (per company)
 *   3. writeSummary(profile, jd)     → Professional Summary text
 */

import { Anthropic } from '@anthropic-ai/sdk';

const DEFAULT_MODEL = process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

export function defaultClient() {
  return new Anthropic();
}

export async function classifyArchetype(jdText, client = defaultClient()) {
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 50,
    system: 'You classify job descriptions into one archetype. Return ONLY one word.',
    messages: [{
      role: 'user',
      content: `Classify this JD into exactly one of: frontend, backend, infra, machine_learning, fullstack.
Reply with only the word, no punctuation.

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
  const text = response.content[0].text.trim().toLowerCase();
  const valid = ['frontend', 'backend', 'infra', 'machine_learning', 'fullstack'];
  if (!valid.includes(text)) {
    throw new Error(`classifyArchetype: invalid response "${text}"`);
  }
  return text;
}

/**
 * Given a candidate pool of bullets for ONE company and a JD summary, ask the LLM
 * to pick the top N most relevant. The LLM may make light ATS-friendly rephrasing
 * but cannot invent bullets.
 *
 * @param {Array<{text, sourcePath, sourceLine}>} pool
 * @param {string} jdText
 * @param {number} n — how many to pick
 * @param {object} client — Anthropic client (injectable for tests)
 * @returns {Promise<Array<{text, sourcePath, sourceLine}>>}
 */
export async function pickBullets(pool, jdText, n, client = defaultClient(), exclude = []) {
  if (pool.length === 0) return [];
  const filteredPool = pool.filter(p => !exclude.some(ex => ex.includes(p.text.slice(0, 40))));
  if (filteredPool.length <= n) return filteredPool;

  const numbered = filteredPool.map((b, i) => `${i}: ${b.text}`).join('\n');
  const excludeNote = exclude.length > 0
    ? `\n\nIMPORTANT: A previous attempt failed validation. Avoid rephrasing too aggressively — keep wording very close to the original bullet text. Bullets that previously failed validation: ${exclude.slice(0, 5).map(e => `"${e.slice(0, 60)}"`).join(', ')}`
    : '';

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1000,
    system: 'You pick the most relevant resume bullets for a job description. Return JSON only.',
    messages: [{
      role: 'user',
      content: `Pick the ${n} bullets most relevant to this JD. You may slightly rephrase to inject JD keywords (max 15% length change), but do NOT invent content.${excludeNote}

Return JSON: {"selected": [{"index": <int>, "text": "<original or rephrased>"}, ...]}

JD:
${jdText.slice(0, 4000)}

BULLETS:
${numbered}`,
    }],
  });
  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`pickBullets: no JSON in response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.selected.map(s => {
    const original = filteredPool[s.index];
    if (!original) throw new Error(`pickBullets: invalid index ${s.index}`);
    return { ...original, text: s.text };
  });
}

export async function writeSummary(profile, jdText, client = defaultClient()) {
  const headline = profile.narrative?.headline || 'Engineer';
  const exitStory = profile.narrative?.exit_story || '';
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 200,
    system: 'You write a 3-4 line Professional Summary section for a resume.',
    messages: [{
      role: 'user',
      content: `Write a Professional Summary (3-4 sentences, dense with JD keywords) given the candidate's headline and the JD. Do NOT invent skills.

CANDIDATE HEADLINE: ${headline}
EXIT STORY: ${exitStory}

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
  return response.content[0].text.trim();
}
