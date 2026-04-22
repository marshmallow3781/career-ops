/**
 * assemble-llm.mjs — LLM-facing functions (dependency-injected client for testability).
 *
 * Three calls per assembly:
 *   1. classifyArchetype(jd)         → "frontend" | "backend" | ...
 *   2. pickBullets(pool, jd, tier)   → selected bullets (per company)
 *   3. writeSummary(profile, jd)     → Professional Summary text
 *
 * Response parsing is deliberately lenient — some models (MiniMax, open-weight
 * models via OpenAI-compat proxies) prefix their answers with reasoning. We
 * extract the structured answer from whatever prose envelope they wrap it in.
 */

import { Anthropic } from '@anthropic-ai/sdk';

const DEFAULT_MODEL = process.env.LLM_MODEL || process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

export function defaultClient() {
  return new Anthropic();
}

// ── Lenient parsing helpers ─────────────────────────────────────────

const VALID_ARCHETYPES = ['frontend', 'backend', 'infra', 'machine_learning', 'fullstack'];

const ARCHETYPE_ALIASES = {
  machine_learning: ['machine_learning', 'machine learning', 'machine-learning', 'ml/ai', 'ai/ml', 'ml platform', 'ml engineer', 'ml engineering'],
  frontend:         ['frontend', 'front-end', 'front end', 'ui engineer', 'client-side'],
  backend:          ['backend', 'back-end', 'back end', 'server-side'],
  infra:            ['infra', 'infrastructure', 'devops', 'sre', 'platform engineer', 'site reliability'],
  fullstack:        ['fullstack', 'full-stack', 'full stack'],
};

/**
 * Extract text from a model response that may contain extended-thinking blocks.
 * MiniMax-M2.7 (and Anthropic extended-thinking) return:
 *   content: [{type: 'thinking', thinking: '...'}, {type: 'text', text: '...'}]
 * Standard responses return:
 *   content: [{type: 'text', text: '...'}]
 * We pick only the 'text'-bearing blocks and concatenate.
 */
function extractResponseText(response) {
  const content = response?.content || [];
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const block of content) {
    if (block?.text && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts.join('\n').trim();
}

function findArchetypeInText(text) {
  const lc = text.toLowerCase();
  let best = null;
  let bestIndex = Infinity;
  for (const [canonical, aliases] of Object.entries(ARCHETYPE_ALIASES)) {
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`);
      const m = lc.search(re);
      if (m !== -1 && m < bestIndex) {
        best = canonical;
        bestIndex = m;
      }
    }
  }
  return best;
}

/**
 * Extract a JSON object from potentially-wrapped LLM output.
 * Handles: raw JSON, ```json code fences```, JSON after prose prefix.
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  // Try: ```json ... ``` or ``` ... ``` code fence
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* fall through */ }
  }

  // Try: greedy first-brace-to-last-brace
  const greedy = text.match(/\{[\s\S]*\}/);
  if (greedy) {
    try { return JSON.parse(greedy[0]); } catch { /* fall through */ }
  }

  // Try: find all balanced-ish top-level objects and attempt each
  const candidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) { candidates.push(text.slice(start, i + 1)); start = -1; } }
  }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }

  return null;
}

// ── LLM-facing functions ────────────────────────────────────────────

export async function classifyArchetype(jdText, client = defaultClient()) {
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 50,
    system: 'You are a strict classifier. Output EXACTLY one word from this list and NOTHING ELSE: frontend, backend, infra, machine_learning, fullstack. No explanation, no reasoning, no punctuation, no quotes, no markdown.',
    messages: [{
      role: 'user',
      content: `Classify this JD into exactly one of: frontend, backend, infra, machine_learning, fullstack.

Output ONLY the single word. Do not explain.

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
  const raw = extractResponseText(response);
  if (!raw) {
    console.error('[assemble-llm] Empty/unexpected response shape:', JSON.stringify(response).slice(0, 400));
  }
  const trimmed = raw.trim().toLowerCase();

  // Strict path: the whole response is exactly one archetype word
  if (VALID_ARCHETYPES.includes(trimmed)) return trimmed;

  // Lenient path: search the response for the first archetype keyword/alias
  const found = findArchetypeInText(raw);
  if (found) {
    console.error(`[classifyArchetype] Model prose-wrapped answer; extracted "${found}" from response`);
    return found;
  }

  throw new Error(`classifyArchetype: could not extract archetype from response "${raw.slice(0, 200)}"`);
}

/**
 * Given a candidate pool of bullets for ONE company and a JD summary, ask the LLM
 * to pick the top N most relevant. The LLM may make light ATS-friendly rephrasing
 * but cannot invent bullets.
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
    max_tokens: 1500,
    system: 'You pick the most relevant resume bullets for a job description. Your response MUST be a single valid JSON object and NOTHING ELSE. No prose before or after. No markdown code fences. Just raw JSON.',
    messages: [{
      role: 'user',
      content: `Pick the ${n} bullets most relevant to this JD. You may slightly rephrase to inject JD keywords (max 15% length change), but do NOT invent content.${excludeNote}

Output EXACTLY this JSON shape and nothing else:
{"selected": [{"index": <int>, "text": "<original or rephrased>"}, ...]}

Do not add any text before or after the JSON. Do not wrap in markdown.

JD:
${jdText.slice(0, 4000)}

BULLETS:
${numbered}`,
    }],
  });
  const raw = extractResponseText(response);
  if (!raw) {
    console.error('[assemble-llm] Empty/unexpected response shape:', JSON.stringify(response).slice(0, 400));
  }
  const parsed = extractJson(raw);
  if (!parsed) {
    throw new Error(`pickBullets: no JSON in response:\n${raw.slice(0, 500)}`);
  }
  if (!Array.isArray(parsed.selected)) {
    throw new Error(`pickBullets: JSON missing "selected" array: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed.selected.map(s => {
    const idx = typeof s.index === 'number' ? s.index : parseInt(s.index, 10);
    const original = filteredPool[idx];
    if (!original) throw new Error(`pickBullets: invalid index ${s.index} (pool size ${filteredPool.length})`);
    return { ...original, text: s.text || original.text };
  });
}

export async function writeSummary(profile, jdText, client = defaultClient()) {
  const headline = profile.narrative?.headline || 'Engineer';
  const exitStory = profile.narrative?.exit_story || '';
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 300,
    system: 'You write a concise 3-4 sentence Professional Summary for a resume. Output ONLY the summary text. No preamble like "Here is the summary:". No markdown. No quotes wrapping the output.',
    messages: [{
      role: 'user',
      content: `Write a Professional Summary (3-4 sentences, dense with JD keywords) given the candidate's headline and the JD. Do NOT invent skills.

Output ONLY the summary text. No preamble. No markdown.

CANDIDATE HEADLINE: ${headline}
EXIT STORY: ${exitStory}

JD:
${jdText.slice(0, 4000)}`,
    }],
  });
  let text = extractResponseText(response);
  // Strip common wrapper patterns
  text = text.replace(/^(here['']?s? (is )?(the|a|your) (professional )?summary[:\s]*)/i, '');
  text = text.replace(/^```(?:markdown)?\s*/, '').replace(/\s*```$/, '');
  text = text.replace(/^["']|["']$/g, '');  // strip surrounding quotes
  return text.trim();
}
