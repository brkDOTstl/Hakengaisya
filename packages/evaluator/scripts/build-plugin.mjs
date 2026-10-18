import { copyFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
for (const relative of ['sdk/client.mjs', 'src/contract.mjs']) {
  const target = new URL('plugins/hakengaisya-evaluator/runtime/' + relative, root);
  await mkdir(new URL('./', target), { recursive: true }); await copyFile(new URL(relative, root), target);
}
console.log('Built standalone recorder runtime from the local SDK and validation contract.');
