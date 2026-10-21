import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [directory, tests] of [
  [root, 'tests'],
  [path.join(root, 'packages/evaluator'), 'test'],
]) {
  const files = readdirSync(path.join(directory, tests))
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => path.join(tests, file));
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: directory,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
