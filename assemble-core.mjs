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
