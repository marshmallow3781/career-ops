#!/usr/bin/env node
/**
 * auto-prep.mjs — orchestrator producing 6 artifacts per eligible job:
 *   1. JD at jds/<slug>.md
 *   2. Tailored CV PDF at cvs/<slug>/<job_id>_cv_tailored.pdf
 *   3. Picker CV PDF at cvs/<slug>/<job_id>_cv_picker.pdf
 *   4. 6-block evaluation report at reports/<company_slug>/<job_id>_report.md
 *   5. Story bank append to interview-prep/story-bank.md
 *   6. Evaluated-status row in applications collection
 *
 * Usage:
 *   node auto-prep.mjs                         # min-score from profile.yml, default 8
 *   node auto-prep.mjs --min-score=7           # override
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { getDb, closeDb, upsertApplication, getNextApplicationNum } from './lib/db.mjs';
import { runPickerMode, runAssemblerMode, buildCvPaths } from './assemble-cv.mjs';
import { renderPdf } from './generate-pdf.mjs';
import { resolvePickerResume } from './lib/picker.mjs';
import { persistReport } from './lib/reports.mjs';
import { generateEvalBlocks, appendStoryBank, renderReport } from './lib/auto-prep.mjs';
import { verifyLegitimacy } from './lib/legitimacy.mjs';
import { initLlm } from './lib/llm.mjs';
import { loadAllSources } from './assemble-core.mjs';
import { buildCandidateSummary } from './digest-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const STORY_BANK_PATH = resolve(__dirname, 'interview-prep/story-bank.md');
const HTML_TEMPLATE_PATH = resolve(__dirname, 'templates/cv-template.html');

function parseArgs(argv) {
  const out = { minScore: null };
  for (const a of argv) {
    const m = a.match(/^--min-score=(\d+)$/);
    if (m) out.minScore = parseInt(m[1], 10);
  }
  return out;
}

function slugify(company, title) {
  const s = `${company}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return s || 'job';
}

async function materializeJd(job) {
  const slug = slugify(job.company || 'unknown', job.title || 'role');
  const path = resolve(__dirname, 'jds', `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const body = [
    `# ${job.company}: ${job.title}`,
    '',
    `**Location:** ${job.location || 'n/a'}`,
    `**URL:** ${job.url || 'n/a'}`,
    `**Archetype:** ${job.prefilter_archetype || '?'} · **Prefilter:** ${job.prefilter_score ?? '?'}/10`,
    '', '---', '', '## Description', '', job.description || '', '',
  ].join('\n');
  writeFileSync(path, body);
  return { jdPath: path, slug };
}

/**
 * Read tailored cv.md and wrap it in a minimal HTML shell compatible with
 * templates/cv-template.html's styling. Returns the path to the written HTML.
 * Throws if the template lacks a <!-- CV_CONTENT --> placeholder.
 */
async function renderTailoredToHtml(cvMdPath, dir) {
  const htmlTemplate = readFileSync(HTML_TEMPLATE_PATH, 'utf-8');
  const marker = '<!-- CV_CONTENT -->';
  if (!htmlTemplate.includes(marker)) {
    throw new Error(
      `templates/cv-template.html has no '${marker}' placeholder — ` +
      `add one where the CV body should go, or disable tailored PDF rendering.`,
    );
  }
  const md = readFileSync(resolve(__dirname, cvMdPath), 'utf-8');
  const htmlBody = md
    .split('\n')
    .map(line => {
      if (/^# /.test(line)) return `<h1>${line.slice(2)}</h1>`;
      if (/^## /.test(line)) return `<h2>${line.slice(3)}</h2>`;
      if (/^### /.test(line)) return `<h3>${line.slice(4)}</h3>`;
      if (/^- /.test(line)) return `<li>${line.slice(2)}</li>`;
      if (line.trim() === '') return '';
      return `<p>${line}</p>`;
    }).join('\n');
  const html = htmlTemplate.replace(marker, htmlBody);
  mkdirSync(resolve(__dirname, dir), { recursive: true });
  const htmlPath = resolve(__dirname, dir, 'cv_tailored.html');
  writeFileSync(htmlPath, html);
  return htmlPath;
}

/**
 * Core orchestration loop. Exported for testing; main() wraps this.
 *
 * @param {object} params
 * @param {number} [params.minScore]
 * @param {object} [params.mockLlmClient] — test hook
 * @param {object} [params.mockLegitimacy] — test hook
 * @param {Function} [params.mockRenderPdf] — test hook
 */
export async function runAutoPrep({
  minScore: explicitMinScore = null,
  sinceHours = 24,
  mockLlmClient = null,
  mockLegitimacy = null,
  mockRenderPdf = null,
} = {}) {
  const profile = existsSync(PROFILE_PATH) ? yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) : {};
  const minScore = explicitMinScore || profile?.cv?.auto_prep?.min_score || 8;
  const pickerCfg = profile?.cv?.picker || { resumes_dir: 'resumes', archetype_map: {} };
  if (pickerCfg.resumes_dir && !pickerCfg.resumes_dir.startsWith('/')) {
    pickerCfg.resumes_dir = resolve(__dirname, pickerCfg.resumes_dir);
  }

  const db = await getDb();
  const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000);

  const stats = { processed: 0, skipped_no_pdf: 0, skipped_already_applied: 0, errors: 0 };

  // Count already-applied matches separately so tests can verify dedup X
  stats.skipped_already_applied = await db.collection('jobs').countDocuments({
    first_seen_at: { $gte: cutoff },
    stage: 'scored',
    prefilter_score: { $gte: minScore },
    application_id: { $ne: null },
  });

  const eligible = await db.collection('jobs').find({
    first_seen_at: { $gte: cutoff },
    stage: 'scored',
    prefilter_score: { $gte: minScore },
    application_id: null,
  }).sort({ prefilter_score: -1 }).toArray();

  console.error(`[auto-prep] ${eligible.length} candidate jobs, min_score=${minScore}`);

  const { client: llmClient, config: llmConfig } = mockLlmClient
    ? { client: mockLlmClient, config: { provider: 'anthropic', model: 'mock' } }
    : initLlm();

  const sources = existsSync(resolve(__dirname, 'experience_source'))
    ? loadAllSources(resolve(__dirname, 'experience_source')) : {};
  const candidateSummary = buildCandidateSummary(profile, sources);

  for (const job of eligible) {
    const resolved = resolvePickerResume(job.prefilter_archetype, pickerCfg);
    if (resolved.missing) {
      stats.skipped_no_pdf++;
      console.error(`[auto-prep] skip ${job.company}: ${job.title} — no PDF for archetype=${job.prefilter_archetype}`);
      continue;
    }

    try {
      const { jdPath, slug } = await materializeJd(job);

      const title_slug = (job.title_normalized || slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const company_slug = job.company_slug || slug;
      const job_id = job.linkedin_id || slug;
      const tailored_paths = {
        dir: `cvs/${company_slug}/${title_slug}`,
        cv_md_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.md`,
        cv_meta_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.meta.json`,
        cv_pdf_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.pdf`,
      };
      await runAssemblerMode({ jdPath, archetypeOverride: job.prefilter_archetype, outputPaths: tailored_paths });

      const tailoredPdfAbs = resolve(__dirname, tailored_paths.cv_pdf_path);
      let tailoredPdfReady = false;
      if (mockRenderPdf) {
        writeFileSync(tailoredPdfAbs, 'mock PDF content');
        tailoredPdfReady = true;
      } else {
        try {
          const htmlPath = await renderTailoredToHtml(tailored_paths.cv_md_path, tailored_paths.dir);
          await renderPdf({ htmlPath, pdfPath: tailoredPdfAbs, format: 'letter' });
          tailoredPdfReady = true;
        } catch (e) {
          console.error(`[auto-prep] tailored PDF skipped for ${job.company}: ${e.message}`);
        }
      }

      const picker_paths = {
        dir: `cvs/${company_slug}/${title_slug}`,
        cv_md_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_picker.md`,
        cv_meta_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_picker.meta.json`,
      };
      const pickerRes = await runPickerMode({ jdPath, archetypeOverride: job.prefilter_archetype, outputPaths: picker_paths });
      const pickerPdfAbs = resolve(__dirname, `cvs/${company_slug}/${title_slug}/${job_id}_cv_picker.pdf`);
      copyFileSync(pickerRes.source_pdf, pickerPdfAbs);

      const jdText = readFileSync(jdPath, 'utf-8');
      const blocks = await generateEvalBlocks({
        jdText,
        candidateSummary,
        tierBreakdown: null,
        existingStoryThemes: [],
        llmClient, llmConfig,
      });

      const legitimacy = mockLegitimacy || await verifyLegitimacy(job.url || '', { timeout: 12000 });

      const score = Number((job.prefilter_score / 2).toFixed(1));
      const reportBody = renderReport({
        blocks, legitimacy, job, score,
        pdfPath: picker_paths.cv_md_path.replace(/\.md$/, '.pdf'),
      });
      const { num: reportNum, report_path } = await persistReport({
        job_id, company: job.company, company_slug,
        url: job.url || '',
        score,
        block_scores: {},
        body: reportBody,
        legitimacy: legitimacy.tier,
      });

      await appendStoryBank({
        storyBankPath: STORY_BANK_PATH,
        newStories: blocks.block_f_stories,
        companyTag: job.company,
        dateTag: new Date().toISOString().slice(0, 10),
      });

      const num = await getNextApplicationNum();
      await upsertApplication({
        num,
        job_id,
        company: job.company,
        role: job.title,
        status: 'Evaluated',
        url: job.url || '',
        date: new Date().toISOString().split('T')[0],
        score,
        notes: `auto-prep (LLM A+B+E+F+H, Playwright G, ${legitimacy.tier})`,
        pdf_generated: true,
        report_id: String(reportNum),
        cv_artifact_ids: [],
      });

      console.error(`[auto-prep] ✓ ${job.company}: ${job.title} — score=${score}/5, legitimacy=${legitimacy.tier}`);
      stats.processed++;
    } catch (err) {
      stats.errors++;
      console.error(`[auto-prep] ✗ ${job.company}: ${job.title} — ${err.message}`);
    }
  }

  console.error(`[auto-prep] done  processed=${stats.processed}  skipped_no_pdf=${stats.skipped_no_pdf}  skipped_already_applied=${stats.skipped_already_applied}  errors=${stats.errors}`);
  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    await runAutoPrep({ minScore: args.minScore });
  } finally {
    await closeDb().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async err => {
    console.error('auto-prep.mjs crashed:', err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
