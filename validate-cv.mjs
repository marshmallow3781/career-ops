#!/usr/bin/env node
/**
 * validate-cv.mjs — Hard structural gate before PDF generation.
 *
 * Usage:
 *   node validate-cv.mjs <cv.tailored.md> [--sources=experience_source]
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more violations (errors written as JSON to stderr and to .cv-tailored-errors.json)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateCvValidation } from './lib/db.mjs';
import {
  checkCompanyCoverage,
  checkBulletProvenance,
  checkChronologicalOrder,
} from './validate-core.mjs';
import { loadConfig, sortCompanies } from './assemble-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let input = null;
  let sourcesRoot = null;
  for (const arg of argv) {
    if (arg.startsWith('--sources=')) sourcesRoot = arg.split('=')[1];
    else if (!input) input = arg;
  }
  return { input, sourcesRoot };
}

function listCompanyDirs(sourcesRoot) {
  return readdirSync(sourcesRoot)
    .filter(name => statSync(resolve(sourcesRoot, name)).isDirectory())
    .filter(name => !name.startsWith('.') && !name.startsWith('_'))
    .sort();
}

async function main() {
  const { input, sourcesRoot: explicitRoot } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error('Usage: node validate-cv.mjs <cv.tailored.md> [--sources=experience_source]');
    process.exit(1);
  }
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }
  const markdown = readFileSync(inputPath, 'utf-8');

  const config = loadConfig(resolve(__dirname, 'config/profile.yml'));
  const sourcesRoot = resolve(__dirname, explicitRoot || config.experience_sources?.root || 'experience_source');

  const requiredCompanies = listCompanyDirs(sourcesRoot);
  const sortedCompanies = await sortCompanies(sourcesRoot, requiredCompanies);

  const errors = [
    ...checkCompanyCoverage(markdown, requiredCompanies),
    ...checkBulletProvenance(markdown, sourcesRoot),
    ...checkChronologicalOrder(markdown, sortedCompanies),
  ];

  const result = errors.length > 0
    ? { ok: false, errors }
    : { ok: true, checks_passed: 3 };

  if (!result.ok) {
    const errorsPath = resolve(__dirname, '.cv-tailored-errors.json');
    writeFileSync(errorsPath, JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  // Persist validation result to cv_artifacts (if the user ran assemble-cv.mjs,
  // a cv_artifacts doc exists keyed by job_id derived from the same JD).
  if (result.ok !== undefined) {
    const fs = await import('node:fs');
    let job_id = null;
    try {
      const metaRaw = fs.readFileSync('.cv-tailored-meta.json', 'utf-8');
      const meta = JSON.parse(metaRaw);
      if (meta.jd) {
        const jdText = fs.readFileSync(meta.jd, 'utf-8');
        const { deriveJobIdForCv } = await import('./assemble-cv.mjs');
        const jdSlug = meta.jd.replace(/^.*\//, '').replace(/\.md$/, '');
        const derived = await deriveJobIdForCv({ jdText, jdSlug });
        job_id = derived.job_id;
      }
    } catch (err) {
      console.error(`[validate-cv] could not resolve job_id for validation record: ${err.message}`);
    }
    if (job_id) {
      const status = result.ok ? 'ok' : (result.errors?.[0]?.type || 'failed');
      try {
        await updateCvValidation(job_id, status, result.errors || []);
      } catch (err) {
        console.error(`[validate-cv] failed to update cv_artifacts.validation_status: ${err.message}`);
      }
    }
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch(err => {
  console.error('validate-cv.mjs crashed:', err.message);
  process.exit(2);
});
