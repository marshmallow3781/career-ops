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
import { generateEvalBlocks, appendStoryBank, renderReport, writeCoverLetterArtifacts } from './lib/auto-prep.mjs';
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
  includeAssembler = false,  // off by default — assembler is ~5-10min/job and its output
                              // (tailored .md) is not consumed by any downstream step.
                              // Opt-in for users who want the tailored .md for manual review.
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

  // Dedup X: build a set of job_ids that already have an application row.
  // (jobs.application_id is never written by upsertApplication — applications
  // are keyed by job_id on the applications collection itself. The prior
  // dedup-X check on jobs.application_id was a no-op that allowed duplicate
  // reports on every re-run → E11000 on reports.job_id_1.)
  const appliedJobIds = new Set(
    (await db.collection('applications').find({}, { projection: { job_id: 1, _id: 0 } }).toArray())
      .map(a => a.job_id)
  );

  const candidates = await db.collection('jobs').find({
    first_seen_at: { $gte: cutoff },
    stage: 'scored',
    prefilter_score: { $gte: minScore },
  }).sort({ prefilter_score: -1 }).toArray();

  const eligible = [];
  for (const j of candidates) {
    const jobKey = j.linkedin_id || j.url || '';
    if (appliedJobIds.has(jobKey)) {
      stats.skipped_already_applied++;
      continue;
    }
    eligible.push(j);
  }

  console.error(`[auto-prep] ${eligible.length} candidate jobs (${stats.skipped_already_applied} skipped_already_applied), min_score=${minScore}`);

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

      // Tailored CV assembly is off by default — each call spends ~5-10 min
      // on LLM (intent extraction + pickBullets per facet with retries) for
      // a .md file no auto-prep step downstream consumes. Opt-in via
      // includeAssembler: true if you want the tailored .md for a specific
      // application's manual review.
      if (includeAssembler) {
        const tailored_paths = {
          dir: `cvs/${company_slug}/${title_slug}`,
          cv_md_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.md`,
          cv_meta_path: `cvs/${company_slug}/${title_slug}/${job_id}_cv_tailored.meta.json`,
        };
        await runAssemblerMode({ jdPath, archetypeOverride: job.prefilter_archetype, outputPaths: tailored_paths });
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

      // Cover letter artifacts — both .md and .pdf for the auto-apply agent.
      const coverMdPath  = resolve(__dirname, `cvs/${company_slug}/${title_slug}/${job_id}_cover_letter.md`);
      const coverPdfPath = resolve(__dirname, `cvs/${company_slug}/${title_slug}/${job_id}_cover_letter.pdf`);
      try {
        await writeCoverLetterArtifacts({
          coverLetterMarkdown: blocks.block_cover_letter || '',
          profile, job,
          mdPath: coverMdPath,
          pdfPath: coverPdfPath,
        });
      } catch (err) {
        console.error(`[auto-prep] cover-letter PDF failed for ${job.company}: ${err.message}`);
        // .md may still have been written; continue with the job
      }

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
