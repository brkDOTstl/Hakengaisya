// Single definition of the self-contained workflow plugin runtime. The build copies exactly
// these files and the release audit verifies them, so adding a library module cannot leave the
// packaged plugin silently incomplete.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePreset, validatePresetRegistry } from '../lib/presets.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const runtimeRoot = path.join(root, 'plugins/hakengaisya/runtime');

// The legacy staff algorithm is a separate historical tool; the workflow plugin never loads it.
const LEGACY_LIBRARY = new Set(['staff.ts']);

export function runtimeFiles(): string[] {
  const library = readdirSync(path.join(root, 'lib'))
    .filter((name) => name.endsWith('.ts') && !LEGACY_LIBRARY.has(name))
    .sort()
    .map((name) => `lib/${name}`);
  const project: { active_templates: string[] } = JSON.parse(
    readFileSync(path.join(root, 'config/project.json'), 'utf8'),
  );
  const templates = project.active_templates.map((id) => `templates/${id}.json`);
  const presets = validatePresetRegistry(
    JSON.parse(readFileSync(path.join(root, 'config/workflow-presets.json'), 'utf8')),
  ).map((id) => `presets/${id}.json`);
  const presetExamples = [
    ...new Set(
      presets.flatMap(
        (file) =>
          validatePreset(JSON.parse(readFileSync(path.join(root, file), 'utf8'))).verification
            .examples,
      ),
    ),
  ];
  return [
    ...library,
    'config/organization-modules.json',
    'config/workflow-presets.json',
    ...presets,
    ...presetExamples,
    'scripts/workflow.ts',
    'packages/optimizer/src/adapter.ts',
    'packages/optimizer/src/contract.ts',
    'packages/optimizer/harness2_bridge.py',
    ...templates,
  ];
}

export function stagedFiles(directory = runtimeRoot, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? stagedFiles(path.join(directory, entry.name), relative)
      : [relative];
  });
}
