/**
 * lib/auto-prep.mjs — pure helpers for auto-prep.mjs.
 * Exports:
 *   - generateEvalBlocks: single LLM call → blocks A+B+E+F+H
 *   - appendStoryBank: dedup + append STAR+R stories (added in Task 3)
 *   - renderReport: combine blocks + legitimacy → final markdown (added in Task 4)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const SYSTEM_PROMPT = `You are writing a job-match evaluation for the candidate.
Return ONLY JSON matching this schema:
{
  "block_a": string,                              // Role Summary: 2-3 sentences on what the role is
  "block_b_rows": [{"req": string, "evidence": string}, ...],  // 3-5 JD requirements mapped to candidate evidence
  "block_e": string,                              // Personalization plan: how to customize the application
  "block_f_stories": [{"scenario": string, "star_prompt": string}, ...],  // 3-5 STAR+R interview stories
  "block_h_answers": [{"prompt": string, "answer": string}, ...],         // 2-3 draft application answers
  "block_cover_letter": string                    // 250-350 word cover letter, first-person, grounded in JD + candidate_summary
}

Ground every claim in either the <job> text or the <candidate_summary>.
Never invent metrics or technologies the candidate didn't cite.
Skip stories already in <existing_story_themes> (they are already in the bank).`;

/**
 * Generate evaluation blocks A, B, E, F, H via a single LLM call.
 *
 * @param {object} params
 * @param {string} params.jdText
 * @param {string} params.candidateSummary
 * @param {string|null} params.tierBreakdown — optional marker from .cv-tailored-meta.json
 * @param {string[]} params.existingStoryThemes — scenarios already in story bank
 * @param {object} params.llmClient — returned by initLlm()
 * @param {object} params.llmConfig — returned by initLlm()
 * @returns {Promise<{block_a, block_b_rows, block_e, block_f_stories, block_h_answers, _parse_failed?}>}
 */
export async function generateEvalBlocks({
  jdText, candidateSummary, tierBreakdown, existingStoryThemes,
  llmClient, llmConfig,
}) {
  const userMessage =
    `<job>\n${jdText.slice(0, 6000)}\n</job>\n\n` +
    `<candidate_summary>\n${candidateSummary}\n</candidate_summary>\n\n` +
    `<tier_breakdown>\n${tierBreakdown || '(none)'}\n</tier_breakdown>\n\n` +
    `<existing_story_themes>\n${(existingStoryThemes || []).join('\n') || '(none)'}\n</existing_story_themes>\n\n` +
    `Return JSON matching the schema in the system prompt.`;

  let text = '';
  try {
    if (llmConfig.provider === 'anthropic') {
      const response = await llmClient.messages.create({
        model: llmConfig.model,
        max_tokens: 4000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });
      text = (response.content || [])
        .filter(b => typeof b?.text === 'string')
        .map(b => b.text).join('\n').trim();
    } else {
      const response = await llmClient.chat.completions.create({
        model: llmConfig.model,
        max_tokens: 4000,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      });
      text = (response.choices?.[0]?.message?.content || '').trim();
    }
  } catch (e) {
    return emptyBlocks({ _parse_failed: true, _reason: `llm: ${(e.message || '').slice(0, 80)}` });
  }

  // Parse — try strict JSON first, then brace-counting scan for JSON embedded in prose.
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const start = text.indexOf('{');
    if (start !== -1) {
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
      if (end !== -1) {
        try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { /* ignore */ }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return emptyBlocks({ _parse_failed: true, _reason: 'parse_failed' });
  }

  return {
    block_a: String(parsed.block_a || ''),
    block_b_rows: Array.isArray(parsed.block_b_rows) ? parsed.block_b_rows : [],
    block_e: String(parsed.block_e || ''),
    block_f_stories: Array.isArray(parsed.block_f_stories) ? parsed.block_f_stories : [],
    block_h_answers: Array.isArray(parsed.block_h_answers) ? parsed.block_h_answers : [],
    block_cover_letter: String(parsed.block_cover_letter || ''),
  };
}

function emptyBlocks(extra = {}) {
  return {
    block_a: '',
    block_b_rows: [],
    block_e: '',
    block_f_stories: [],
    block_h_answers: [],
    block_cover_letter: '',
    ...extra,
  };
}

/**
 * Normalize a scenario for dedup matching.
 */
function normalizeScenario(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract already-stored scenarios from a story-bank markdown body.
 */
function existingScenarios(body) {
  const out = new Set();
  const re = /\*\*Scenario:\*\*\s*(.+)$/gim;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.add(normalizeScenario(m[1]));
  }
  return out;
}

/**
 * Append STAR+R stories to `interview-prep/story-bank.md`, deduplicating
 * against already-stored scenarios (exact normalized match).
 *
 * @param {object} params
 * @param {string} params.storyBankPath
 * @param {Array<{scenario, star_prompt}>} params.newStories
 * @param {string} params.companyTag — label for the "## [Auto-generated · date · company]" header
 * @param {string} params.dateTag — YYYY-MM-DD
 * @returns {number} count of stories actually appended (after dedup)
 */
export function appendStoryBank({ storyBankPath, newStories, companyTag, dateTag }) {
  const body = existsSync(storyBankPath) ? readFileSync(storyBankPath, 'utf-8') : '# Story Bank\n\n';
  const already = existingScenarios(body);
  const toAppend = [];

  for (const s of (newStories || [])) {
    if (!s || typeof s.scenario !== 'string') continue;
    const key = normalizeScenario(s.scenario);
    if (!key || already.has(key)) continue;
    already.add(key);
    toAppend.push(s);
  }

  if (toAppend.length === 0) {
    if (!existsSync(storyBankPath)) writeFileSync(storyBankPath, body);
    return 0;
  }

  const lines = [];
  for (const s of toAppend) {
    lines.push(`## [Auto-generated · ${dateTag} · ${companyTag}]`);
    lines.push(`**Scenario:** ${s.scenario}`);
    lines.push(`**STAR prompt:** ${s.star_prompt || '(missing)'}`);
    lines.push('');
  }

  if (!existsSync(storyBankPath)) writeFileSync(storyBankPath, body);
  appendFileSync(storyBankPath, lines.join('\n') + '\n');
  return toAppend.length;
}

/**
 * Render the 6-block evaluation report markdown.
 *
 * @param {object} params
 * @param {object} params.blocks — from generateEvalBlocks()
 * @param {object} params.legitimacy — from verifyLegitimacy()
 * @param {object} params.job — the Mongo jobs document
 * @param {number} params.score — the X.X/5 tracker score
 * @param {string} params.pdfPath — path to the PDF the tracker row will cite
 * @returns {string} markdown
 */
export function renderReport({ blocks, legitimacy, job, score, pdfPath }) {
  const lines = [];
  lines.push(`# ${job.company} — ${job.title}`);
  lines.push('');
  lines.push(`**Score:** ${score}/5`);
  lines.push(`**URL:** ${job.url || 'n/a'}`);
  lines.push(`**PDF:** \`${pdfPath}\``);
  lines.push(`**Legitimacy:** ${legitimacy.tier}${legitimacy.signals?.length ? ` (${legitimacy.signals.join(', ')})` : ''}`);
  lines.push(`**Archetype:** ${job.prefilter_archetype || '?'} · **Prefilter score:** ${job.prefilter_score ?? '?'}/10`);
  lines.push('');
  lines.push('---');

  lines.push('');
  lines.push('## Block A — Resumen del Rol');
  lines.push('');
  lines.push(blocks.block_a || '_(auto-prep produced no content for this block)_');

  lines.push('');
  lines.push('## Block B — Match con CV');
  lines.push('');
  if (blocks.block_b_rows?.length > 0) {
    lines.push('| JD requirement | Evidence in CV |');
    lines.push('|---|---|');
    for (const row of blocks.block_b_rows) {
      lines.push(`| ${row.req || ''} | ${row.evidence || ''} |`);
    }
  } else {
    lines.push('_(no rows)_');
  }

  lines.push('');
  lines.push('## Block E — Plan de Personalización');
  lines.push('');
  lines.push(blocks.block_e || '_(no content)_');

  lines.push('');
  lines.push('## Block F — Plan de Entrevistas');
  lines.push('');
  if (blocks.block_f_stories?.length > 0) {
    for (const s of blocks.block_f_stories) {
      lines.push(`- **${s.scenario || 'scenario'}** — ${s.star_prompt || ''}`);
    }
  } else {
    lines.push('_(no stories)_');
  }

  lines.push('');
  lines.push('## Block G — Posting Legitimacy');
  lines.push('');
  lines.push(`**Tier:** ${legitimacy.tier}`);
  if (legitimacy.signals?.length) {
    lines.push('');
    lines.push(`Signals: ${legitimacy.signals.join(', ')}`);
  }
  if (legitimacy.reason) {
    lines.push('');
    lines.push(`Reason: ${legitimacy.reason}`);
  }

  lines.push('');
  lines.push('## Block H — Draft Application Answers');
  lines.push('');
  if (blocks.block_h_answers?.length > 0) {
    for (const a of blocks.block_h_answers) {
      lines.push(`**Q: ${a.prompt || ''}**`);
      lines.push('');
      lines.push(a.answer || '_(no answer)_');
      lines.push('');
    }
  } else {
    lines.push('_(no answers)_');
  }

  lines.push('');
  return lines.join('\n') + '\n';
}
