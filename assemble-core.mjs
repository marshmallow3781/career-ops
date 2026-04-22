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
  const bodyOffset = m[1].split('\n').length + 2;  // 1 for opening ---, 1 for closing ---

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
