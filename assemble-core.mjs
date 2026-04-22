/**
 * assemble-core.mjs — Pure (non-LLM) functions for tailored CV assembly.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUIRED_FRONTMATTER = ['company', 'role', 'location', 'start', 'end', 'facet'];

/**
 * Parse one experience_source/{company}/{facet}.md file.
 * Returns { frontmatter, bullets, projects, skills }.
 */
export function parseSourceFile(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('parseSourceFile: file must start with --- frontmatter ---');
  const frontmatter = yaml.load(m[1]);
  for (const key of REQUIRED_FRONTMATTER) {
    if (!(key in frontmatter)) {
      throw new Error(`parseSourceFile: frontmatter missing required key "${key}"`);
    }
  }
  const body = m[2];
  // bodyOffset = 1-based file line where `body` (m[2]) starts.
  // Layout: line 1 = opening `---`, lines 2..(N+1) = N frontmatter lines,
  // line (N+2) = closing `---`, line (N+3) = first body line.
  const bodyOffset = m[1].split('\n').length + 3;

  const bullets = extractSection(body, 'Bullets', bodyOffset);
  const projects = extractSection(body, 'Projects', bodyOffset, true);
  const skills = extractSkills(body);

  return { frontmatter, bullets, projects, skills };
}

/**
 * Extract `## Section` items as bullets. If projectsMode, takes only top-level
 * (non-indented) lines; indented sub-bullets become `details` of the parent.
 */
function extractSection(body, sectionName, lineOffset, projectsMode = false) {
  const sectionRe = new RegExp(`##\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const m = body.match(sectionRe);
  if (!m) return [];
  const sectionStartOffset = body.slice(0, m.index).split('\n').length; // lines before ## header
  const lines = m[1].split('\n');
  const items = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = lineOffset + sectionStartOffset + i + 1; // 1-based
    const top = line.match(/^-\s+(.+?)\s*$/);
    const sub = line.match(/^\s+-\s+(.+?)\s*$/);
    if (top) {
      current = { text: top[1].trim(), lineNumber, details: [] };
      items.push(current);
    } else if (sub && projectsMode && current) {
      current.details.push(sub[1].trim());
    }
  }
  return items;
}

function extractSkills(body) {
  const m = body.match(/##\s+Skills used\s*\n+([^\n]+)/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Walk a sources root and return { [companyDir]: [parsedFacetFile, ...] }.
 */
export function loadAllSources(sourcesRoot) {
  const out = {};
  const dirs = readdirSync(sourcesRoot)
    .filter(name => statSync(join(sourcesRoot, name)).isDirectory())
    .filter(name => !name.startsWith('.') && !name.startsWith('_'));
  for (const company of dirs) {
    const dir = join(sourcesRoot, company);
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    out[company] = [];
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      try {
        const parsed = parseSourceFile(content);
        parsed._sourcePath = join(company, file);
        out[company].push(parsed);
      } catch (err) {
        throw new Error(`${join(company, file)}: ${err.message}`);
      }
    }
  }
  return out;
}

/**
 * Within each company, every facet file must agree on role / start / end / location.
 */
export function validateConsistency(sources) {
  for (const [company, files] of Object.entries(sources)) {
    if (files.length < 2) continue;
    const ref = files[0].frontmatter;
    for (const f of files.slice(1)) {
      for (const key of ['role', 'start', 'end', 'location']) {
        if (f.frontmatter[key] !== ref[key]) {
          throw new Error(
            `Cross-facet mismatch in ${company}: "${key}" differs ` +
            `("${ref[key]}" in ${files[0]._sourcePath} vs "${f.frontmatter[key]}" in ${f._sourcePath})`
          );
        }
      }
    }
  }
}

/**
 * Returns company directory names sorted reverse-chronologically by frontmatter start.
 * Tie-break: end desc, then alphabetical.
 *
 * "present" or empty end is treated as a date past any actual date.
 */
export async function sortCompanies(sourcesRoot, companyDirs) {
  const dated = companyDirs.map(dir => {
    const facetFiles = readdirSync(join(sourcesRoot, dir)).filter(f => f.endsWith('.md'));
    if (facetFiles.length === 0) return { dir, start: '0000-00', end: '0000-00' };
    const first = parseSourceFile(readFileSync(join(sourcesRoot, dir, facetFiles[0]), 'utf-8'));
    const start = String(first.frontmatter.start);
    const endRaw = String(first.frontmatter.end || 'present');
    const end = endRaw.toLowerCase() === 'present' ? '9999-99' : endRaw;
    return { dir, start, end };
  });
  dated.sort((a, b) => {
    if (a.start !== b.start) return b.start.localeCompare(a.start);
    if (a.end !== b.end) return b.end.localeCompare(a.end);
    return a.dir.localeCompare(b.dir);
  });
  return dated.map(d => d.dir);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'with', 'for', 'of', 'to', 'in', 'on', 'at',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must',
  'we', 'our', 'you', 'your', 'their', 'this', 'that', 'these', 'those', 'job', 'role',
  'team', 'company', 'work', 'experience', 'years', 'year', 'looking', 'hiring', 'engineer',
  'engineering', 'senior', 'junior', 'staff', 'lead', 'principal',
]);

/**
 * Cheap keyword extraction: lowercase tokens 3+ chars, drop stopwords.
 * No stemming. Returns Set<string>.
 */
export function extractKeywords(jdText) {
  const tokens = jdText.toLowerCase().match(/[a-z][a-z0-9+#./-]{2,}/g) || [];
  const out = new Set();
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * Given a Set of keywords, expand each by adding all aliases from the synonym table
 * AND the canonical form when an alias matches.
 * @param {Set<string>} keywords
 * @param {string} synonymsPath — path to YAML
 * @returns {Set<string>}
 */
export function expandSynonyms(keywords, synonymsPath) {
  let table;
  try {
    table = yaml.load(readFileSync(synonymsPath, 'utf-8'));
  } catch {
    return new Set(keywords);
  }
  const expanded = new Set(keywords);
  for (const group of table.groups || []) {
    const allForms = [group.canonical, ...(group.aliases || [])];
    const lcForms = allForms.map(f => f.toLowerCase());
    const triggered = lcForms.some(f => expanded.has(f));
    if (triggered) {
      for (const f of lcForms) expanded.add(f);
    }
  }
  return expanded;
}

/**
 * Count the number of distinct keywords that appear in the bullet text
 * (case-insensitive, whole-phrase, with a simple plural/singular fallback).
 * If an exact match fails, try the variant with/without trailing 's'.
 * Words of length ≤ 3 do not get the variant attempt (avoids matching "is"/"as").
 */
export function scoreBullet(bulletText, keywords) {
  const lc = bulletText.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    const base = kw.toLowerCase();
    if (new RegExp(`\\b${escapeRegex(base)}\\b`).test(lc)) {
      hits++;
      continue;
    }
    let variant;
    if (base.endsWith('s') && base.length > 3) variant = base.slice(0, -1);
    else variant = base + 's';
    if (new RegExp(`\\b${escapeRegex(variant)}\\b`).test(lc)) hits++;
  }
  return hits;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide the rendering tier for a company based on candidate pool size and per-company floor.
 * @param {number} poolSize
 * @param {'full'|'light'|'stub'|null} floor
 * @returns {'full'|'light'|'stub'}
 */
export function assignTier(poolSize, floor) {
  let natural;
  if (poolSize >= 3) natural = 'full';
  else if (poolSize >= 1) natural = 'light';
  else natural = 'stub';

  if (!floor) return natural;
  const order = { stub: 0, light: 1, full: 2 };
  return order[natural] >= order[floor] ? natural : floor;
}

/**
 * Render the final cv.tailored.md markdown.
 * @param {object} args
 * @param {object} args.profile — config/profile.yml content
 * @param {Array} args.companies — [{dir, frontmatter, tier, bullets?, stub?}, ...] in render order
 * @param {Array} args.projects — selected projects with sourcePath, sourceLine
 * @param {string[]} args.competencies — Core Competency phrases
 * @param {string} args.summary — Professional Summary text
 * @returns {string} markdown
 */
export function renderTailored({ profile, companies, projects, competencies, summary }) {
  const c = profile.candidate || {};
  const lines = [];
  lines.push(`# ${c.full_name || 'Candidate'}`);
  lines.push('');
  const contact = [c.location, c.email, c.linkedin, c.portfolio_url].filter(Boolean).join(' · ');
  if (contact) lines.push(`*${contact}*`);
  lines.push('');

  // Professional Summary: render only if explicitly provided.
  // User preference: section removed by default.
  if (summary && summary.trim()) {
    lines.push('## Professional Summary');
    lines.push('');
    lines.push(summary);
    lines.push('');
  }

  if (competencies?.length) {
    lines.push('## Core Competencies');
    lines.push('');
    lines.push(competencies.join(' · '));
    lines.push('');
  }

  lines.push('## Work Experience');
  lines.push('');
  for (const co of companies) {
    const fm = co.frontmatter;
    lines.push(`### ${fm.company} — ${fm.location}`);
    lines.push(`**${fm.role}** | ${fm.start} → ${fm.end}`);
    lines.push('');
    const noBullets = !co.bullets || co.bullets.length === 0;
    if (co.tier === 'stub' || noBullets) {
      // Stub fallback: applies to explicit stub tier AND to non-stub tiers where
      // the candidate pool was empty (e.g. tier_floor=light promoted an empty pool).
      const stubText = co.stub || `Worked at ${fm.company} as ${fm.role}.`;
      lines.push(`- ${stubText} <!-- src:_stub -->`);
    } else {
      for (const b of co.bullets) {
        const marker = b.sourcePath ? ` <!-- src:${b.sourcePath}#L${b.sourceLine || 0} -->` : '';
        lines.push(`- ${b.text}${marker}`);
      }
    }
    lines.push('');
  }

  // Education — sourced from profile.yml's `education` array
  const education = profile.education || [];
  if (education.length > 0) {
    lines.push('## Education');
    lines.push('');
    for (const e of education) {
      const instAndLoc = e.location ? `${e.institution} — ${e.location}` : e.institution;
      lines.push(`### ${instAndLoc}`);
      const dates = e.end ? `${e.start} → ${e.end}` : e.start;
      lines.push(`**${e.degree}** | ${dates}`);
      if (e.notes) lines.push(e.notes);
      lines.push('');
    }
  }

  if (projects?.length) {
    lines.push('## Projects');
    lines.push('');
    for (const p of projects) {
      const marker = p.sourcePath ? ` <!-- src:${p.sourcePath}#L${p.sourceLine || 0} -->` : '';
      lines.push(`- ${p.text}${marker}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Load and parse config/profile.yml. Throws if file missing.
 */
export function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Copy config/profile.example.yml.`);
  }
  return yaml.load(readFileSync(path, 'utf-8'));
}

/**
 * Parse article-digest.md into a list of project candidates.
 * Each "## ..." H2 becomes one entry. Captures Hero metrics line as the bullet text.
 */
export function parseArticleDigest(content, sourcePath) {
  if (!content) return [];
  const projects = [];
  const sections = content.split(/^##\s+/m).slice(1);
  let lineCounter = 1;
  for (const sec of sections) {
    const lines = sec.split('\n');
    const titleLine = lines[0].trim();
    const heroLine = lines.find(l => /^\*\*Hero metrics:?\*\*/i.test(l));
    const archetypeLine = lines.find(l => /^\*\*Archetype:?\*\*/i.test(l));
    const heroText = heroLine ? heroLine.replace(/^\*\*Hero metrics:?\*\*\s*/i, '') : '';
    const archetype = archetypeLine ? archetypeLine.replace(/^\*\*Archetype:?\*\*\s*/i, '').trim() : null;
    const text = heroText ? `**${titleLine}** — ${heroText}` : `**${titleLine}**`;
    projects.push({
      text,
      sourcePath,
      sourceLine: lineCounter,
      archetype,
    });
    lineCounter += sec.split('\n').length + 1;
  }
  return projects;
}

/**
 * Convenience: read article-digest.md from the project root if it exists.
 */
export function loadArticleDigest(rootDir) {
  const path = join(rootDir, 'article-digest.md');
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf-8');
  return parseArticleDigest(content, 'article-digest.md');
}
