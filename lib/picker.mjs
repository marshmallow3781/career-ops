// lib/picker.mjs
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Resolve which resume PDF to use for a given archetype.
 *
 * @param {string} archetype — the JD archetype (e.g. 'backend', 'infra', 'unknown')
 * @param {{resumes_dir: string, archetype_map: object}} pickerConfig
 * @returns {{path?: string, filename: string|null, missing?: true}}
 *   - { path, filename } when the archetype is mapped AND the file exists
 *   - { missing: true, filename } when the archetype is mapped but the file is absent
 *   - { missing: true, filename: null } when the archetype is not in the map
 */
export function resolvePickerResume(archetype, pickerConfig) {
  const map = pickerConfig?.archetype_map || {};
  const filename = map[archetype] || null;

  if (!filename) {
    return { missing: true, filename: null };
  }

  const dir = pickerConfig?.resumes_dir || 'resumes';
  const path = resolve(dir, filename);
  if (!existsSync(path)) {
    return { missing: true, filename };
  }
  return { path, filename };
}

/**
 * Shell out to `pdftotext <pdfPath> -` and return stdout as a string.
 * Throws with an install hint if the binary is missing.
 */
export async function extractPdfText(pdfPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pdftotext', [pdfPath, '-']);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', c => { stdout += c.toString(); });
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          `pdftotext binary not found. Install it with: brew install poppler`,
        ));
      } else {
        reject(err);
      }
    });
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`pdftotext exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}
