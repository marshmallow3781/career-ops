#!/usr/bin/env node
/**
 * digest-builder.mjs — 3-stage filter + digest renderer.
 *
 * Usage:
 *   node digest-builder.mjs                # normal run
 *   node digest-builder.mjs --dry-run      # don't write output
 *
 * Stages:
 *   1. Free title filter (portals.yml.title_filter + profile.deal_breakers)
 *   2. Fingerprint dedup (cross-source, last 30 days)
 *   3. Haiku archetype-aware scoring
 *
 * Outputs:
 *   - data/digest.md (overwritten at 7am, appended otherwise)
 *   - appends score≥6 entries to data/pipeline.md
 *   - macOS notification via osascript
 *   - archives old digests to data/digest-history/
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';
import {
  normalizeCompany,
  normalizeTitle,
  computeJdFingerprint,
  loadSeenJobs,
  appendSeenJobs,
  SEEN_JOBS_HEADER,
} from './lib/dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
const DIGEST_PATH = join(DATA_DIR, 'digest.md');
const HISTORY_DIR = join(DATA_DIR, 'digest-history');
const APIFY_NEW_GLOB = 'apify-new-';
const APIFY_ARCHIVE_DIR = join(DATA_DIR, 'apify-new-archive');
const PIPELINE_PATH = join(DATA_DIR, 'pipeline.md');

const HAIKU_MODEL = process.env.ASSEMBLE_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Apply 3-part title filter: positive-match AND !negative-match AND !deal-breaker.
 * All matches are case-insensitive substring.
 *
 * @param {string} title
 * @param {{positive: string[], negative: string[]}} filter
 * @param {string[]} dealBreakers
 * @returns {boolean} true if job passes filter
 */
export function applyTitleFilter(title, filter, dealBreakers) {
  if (!title || typeof title !== 'string') return false;
  const lc = title.toLowerCase();
  const hasPositive = (filter.positive || []).length === 0 ||
    (filter.positive || []).some(k => lc.includes(k.toLowerCase()));
  const hasNegative = (filter.negative || []).some(k => lc.includes(k.toLowerCase()));
  const hasDealBreaker = (dealBreakers || []).some(k => lc.includes(k.toLowerCase()));
  return hasPositive && !hasNegative && !hasDealBreaker;
}
