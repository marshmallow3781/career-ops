// lib/picker.mjs
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
