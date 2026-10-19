import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['lib/workflow.mjs', 'lib/planning.mjs', 'lib/triage.mjs', 'lib/dispatch.mjs', 'lib/supervision.mjs', 'lib/organization.mjs', 'lib/federation.mjs', 'lib/participation.mjs', 'config/organization-modules.json', 'scripts/workflow.mjs', 'templates/software-delivery.json', 'templates/product-design.json'];
for (const file of files) {
  const target = path.join(root, 'plugins/hakengaisya/runtime', file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, file), target);
}
console.log('Hakengaisya runtime staged with optional Jev intake; no provider or evaluator credentials bundled.');
const evaluator = path.join(root, 'packages/evaluator');
const result = spawnSync(process.execPath, [path.join(evaluator, 'scripts/build-plugin.mjs')], { cwd: evaluator, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
