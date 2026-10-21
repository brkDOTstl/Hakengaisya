// Single definition of the self-contained workflow plugin runtime. The build copies exactly
// these files and the release audit verifies them, so adding a library module cannot leave the
// packaged plugin silently incomplete.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const runtimeRoot = path.join(root, 'plugins/hakengaisya/runtime');

// The legacy staff algorithm is a separate historical tool; the workflow plugin never loads it.
const LEGACY_LIBRARY = new Set(['staff.mjs']);

export function runtimeFiles() {
  const library = readdirSync(path.join(root, 'lib'))
    .filter((name) => name.endsWith('.mjs') && !LEGACY_LIBRARY.has(name))
    .sort()
    .map((name) => `lib/${name}`);
  const project = JSON.parse(readFileSync(path.join(root, 'config/project.json'), 'utf8'));
  const templates = project.active_templates.map((id) => `templates/${id}.json`);
  return [...library, 'config/organization-modules.json', 'scripts/workflow.mjs', ...templates];
}

export function stagedFiles(directory = runtimeRoot, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? stagedFiles(path.join(directory, entry.name), relative)
      : [relative];
  });
}
