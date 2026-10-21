import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { root, runtimeFiles, runtimeRoot, stagedFiles } from './runtime-files.ts';

const expected = runtimeFiles();
for (const file of expected) {
  const target = path.join(runtimeRoot, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, file), target);
}
// Remove copies of modules that no longer exist, so the plugin never ships stale code.
const keep = new Set(expected);
for (const file of stagedFiles()) {
  if (!keep.has(file)) await unlink(path.join(runtimeRoot, file));
}
console.log(
  `Hakengaisya runtime staged (${expected.length} files) with optional Jev intake; no provider or evaluator credentials bundled.`,
);
const evaluator = path.join(root, 'packages/evaluator');
const result = spawnSync(process.execPath, [path.join(evaluator, 'scripts/build-plugin.ts')], {
  cwd: evaluator,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
