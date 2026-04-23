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
import { deriveSignals, SIGNAL_TO_PHRASE } from './assemble-core.mjs';

const DEFAULT_MODEL = process.env.LLM_MODEL || process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

export function defaultClient() {
  return new Anthropic();
}

// ── Lenient parsing helpers ─────────────────────────────────────────

const VALID_ARCHETYPES = ['frontend', 'backend', 'infra', 'machine_learning', 'ml_platform', 'applied_ai', 'fullstack'];

const ARCHETYPE_ALIASES = {
  ml_platform:      ['ml platform', 'ml/ai platform', 'ml infra', 'mlops', 'ml infrastructure', 'ai platform', 'model serving', 'feature store', 'training platform', 'ml platform engineer'],
  applied_ai:       ['applied ai', 'applied ai engineer', 'ai engineer', 'ai systems engineer', 'llm engineer', 'ai platform engineer', 'production ai', 'agent engineer', 'applied llm'],
  machine_learning: ['machine_learning', 'machine learning', 'machine-learning', 'ml/ai', 'ai/ml', 'ml engineer', 'ml engineering', 'applied ml', 'ml researcher', 'ai researcher'],
  frontend:         ['frontend', 'front-end', 'front end', 'ui engineer', 'client-side'],
  backend:          ['backend', 'back-end', 'back end', 'server-side'],
  infra:            ['infra', 'infrastructure', 'devops', 'sre', 'platform engineer', 'site reliability', 'data platform', 'data infrastructure'],
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

/**
 * Extract structured role intent from a JD. Returns engineer-archetype
 * narratives in prefer_patterns (e.g. "Backend engineer with ML-platform
 * adjacency"), not topic tags.
 *
 * Hardened with retry + deterministic fallback:
 *   1. First LLM attempt with the standard prompt.
 *   2. On parse failure OR thrown error, retry once with a stricter
 *      JSON-only reprompt.
 *   3. On second failure, synthesize prefer_patterns from fired signals
 *      (never silently returns empty).
 *
 * The `_source` field records which path produced the result
 * ("llm" | "llm-retry" | "deterministic-fallback") and is logged in
 * .cv-tailored-meta.json for debuggability.
 *
 * @returns {Promise<{primary_focus, prefer_patterns, deprioritize_patterns, _source}>}
 */
export async function extractJdIntent(jdText, client = defaultClient()) {
  const firedSignals = deriveSignals(jdText);
  const firedList = [...firedSignals].join(', ') || '(none detected)';

  const basePrompt = `Given this JD, describe the engineer archetype the team is actually hunting for.

Output EXACTLY this JSON, no prose, no markdown fences:

{
  "primary_focus": "<one sentence: what they actually want>",
  "prefer_patterns": [
    "<engineer archetype description #1>",
    "<engineer archetype description #2>",
    "<engineer archetype description #3>"
  ]
}

Each prefer_patterns entry describes a WHOLE engineer profile in one phrase —
not a topic tag. Three entries, no more, no less.

Good examples:
- "Backend / Infra engineer with strong ML-platform adjacency"
- "Platform-minded engineer who has built data pipelines, experimentation, and production systems for intelligent decisioning"
- "ML infrastructure engineer focused on distributed training and serving at scale"

Bad examples (do NOT emit — too narrow):
- "SDK design"
- "Kubernetes"
- "Python experience"

FIRED SIGNALS: ${firedList}

JD:
${jdText.slice(0, 4000)}`;

  // Attempt 1
  try {
    const response = await client.messages.create({
      model: DEFAULT_MODEL,
      // Headroom for thinking-model output budget (see classifyArchetype comment).
      max_tokens: 1500,
      system: 'You analyze job descriptions to extract the role\'s true nature. Output a single valid JSON object and nothing else. No prose, no markdown fences.',
      messages: [{ role: 'user', content: basePrompt }],
    });
    const raw = extractResponseText(response);
    const parsed = extractJson(raw);
    if (parsed && parsed.primary_focus && Array.isArray(parsed.prefer_patterns) && parsed.prefer_patterns.length > 0) {
      return {
        primary_focus: parsed.primary_focus,
        prefer_patterns: parsed.prefer_patterns,
        deprioritize_patterns: [],
        _source: 'llm',
      };
    }
    console.error('[extractJdIntent] parse failure, retrying with strict reprompt');
  } catch (err) {
    console.error(`[extractJdIntent] first attempt threw: ${err.message}; retrying`);
  }

  // Attempt 2 (strict reprompt)
  try {
    const response = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1500,
      system: 'You analyze job descriptions. Output ONLY a single valid JSON object. No markdown. No prose. No explanation.',
      messages: [{
        role: 'user',
        content: basePrompt + '\n\nYour previous response did not parse as JSON. Output ONLY the JSON object. No markdown, no prose, no explanation.',
      }],
    });
    const raw = extractResponseText(response);
    const parsed = extractJson(raw);
    if (parsed && parsed.primary_focus && Array.isArray(parsed.prefer_patterns) && parsed.prefer_patterns.length > 0) {
      return {
        primary_focus: parsed.primary_focus,
        prefer_patterns: parsed.prefer_patterns,
        deprioritize_patterns: [],
        _source: 'llm-retry',
      };
    }
  } catch (err) {
    console.error(`[extractJdIntent] retry threw: ${err.message}`);
  }

  // Deterministic fallback
  console.error('[extractJdIntent] LLM failed twice, using deterministic fallback');
  const phrases = [...firedSignals].map(s => SIGNAL_TO_PHRASE[s]).filter(Boolean);
  const preferPatterns = phrases.length > 0 ? phrases : ['general software engineering work'];
  const primary = phrases.length > 0
    ? `Role focused on ${phrases.slice(0, 2).join(' and ')}`
    : 'General software engineering role';
  return {
    primary_focus: primary,
    prefer_patterns: preferPatterns,
    deprioritize_patterns: [],
    _source: 'deterministic-fallback',
  };
}

export async function classifyArchetype(jdText, client = defaultClient()) {
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    // Extended-thinking models (MiniMax-M2.7, Anthropic w/ thinking on) can
    // consume 500-1000 tokens in the thinking block before emitting any text.
    // If the answer is truncated by max_tokens before the text block, the
    // lenient parser + alias search both fall through to a final throw.
    // 1500 gives thinking enough headroom to actually produce the one-word
    // answer we ask for. Cost impact is negligible since we only bill for
    // tokens used, not the budget.
    max_tokens: 1500,
    system: 'You are a strict classifier. Output EXACTLY one word from this list and NOTHING ELSE: frontend, backend, infra, machine_learning, applied_ai, ml_platform, fullstack. No explanation, no reasoning, no punctuation, no quotes, no markdown.',
    messages: [{
      role: 'user',
      content: `Classify this JD into exactly one of:

- frontend — UI, web, design systems
- backend — product-side APIs, services, distributed systems
- infra — platform engineering, SRE, devops, data platform
- machine_learning — builds/trains ML models, applied ML, research
- ml_platform — builds infra/SDKs/tooling FOR ML teams (not models)
- applied_ai — builds production AI/LLM/agent SYSTEMS end-to-end (ships AI products, not models)
- fullstack — balanced FE+BE product engineering

Key distinctions:
- machine_learning = trains models
- ml_platform = builds the platform ML teams use to train/serve models
- applied_ai = ships LLM/agent products with observability, evaluation, tool-calling

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
export async function pickBullets(pool, jdText, n, client = defaultClient(), exclude = [], intent = null) {
  if (pool.length === 0) return [];
  const filteredPool = pool.filter(p => !exclude.some(ex => ex.includes(p.text.slice(0, 40))));
  if (filteredPool.length <= n) return filteredPool;

  // Annotate each bullet with its facet so the LLM can see cross-facet variety
  const numbered = filteredPool.map((b, i) => {
    const facetTag = b.facet ? ` [${b.facet}]` : '';
    return `${i}${facetTag}: ${b.text}`;
  }).join('\n');

  const excludeNote = exclude.length > 0
    ? `\n\nIMPORTANT: A previous attempt failed validation. Avoid rephrasing too aggressively — keep wording very close to the original bullet text. Bullets that previously failed validation: ${exclude.slice(0, 5).map(e => `"${e.slice(0, 60)}"`).join(', ')}`
    : '';

  // Inject role-intent context if available — steers picks beyond keyword scoring
  let intentBlock = '';
  if (intent && (intent.primary_focus || intent.prefer_patterns?.length || intent.deprioritize_patterns?.length)) {
    const lines = [
      '',
      '',
      'ROLE INTENT (use this to filter the pool):',
      `- Role type: ${intent.role_type || 'unknown'}`,
      `- What they actually want: ${intent.primary_focus || '(not extracted)'}`,
      `- PREFER bullets about: ${(intent.prefer_patterns || []).join(', ') || '(none specified)'}`,
    ];
    const hasDeprio = Array.isArray(intent.deprioritize_patterns) && intent.deprioritize_patterns.length > 0;
    if (hasDeprio) {
      lines.push(`- DEPRIORITIZE bullets about: ${intent.deprioritize_patterns.join(', ')}`);
    }
    lines.push('');
    lines.push(hasDeprio
      ? 'When picking, favor bullets in the PREFER list even if their raw keyword match is slightly lower. Avoid bullets in the DEPRIORITIZE list unless no alternative exists.'
      : 'When picking, favor bullets in the PREFER list even if their raw keyword match is slightly lower.');
    lines.push('');
    intentBlock = lines.join('\n');
  }

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 3000,
    system: 'You pick the most relevant resume bullets for a job description. Your response MUST be a single valid JSON object and NOTHING ELSE. No prose before or after. No markdown code fences. Just raw JSON. If you need to think, think silently — do not print your reasoning.',
    messages: [{
      role: 'user',
      content: `Pick the ${n} bullets most relevant to this JD. You may slightly rephrase to inject JD keywords (max 15% length change), but do NOT invent content.${excludeNote}${intentBlock}

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
