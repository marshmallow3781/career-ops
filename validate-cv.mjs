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

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  if (errors.length > 0) {
    const payload = { ok: false, errors };
    const errorsPath = resolve(__dirname, '.cv-tailored-errors.json');
    writeFileSync(errorsPath, JSON.stringify(payload, null, 2));
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, checks_passed: 3 }, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('validate-cv.mjs crashed:', err.message);
  process.exit(2);
});
