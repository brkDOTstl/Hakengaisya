import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { safeText } from '../src/contract.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/local-history.json', import.meta.url), 'utf8'));
for (const example of fixture.examples) for (const key of ['comment', 'example', 'guidance']) safeText(example[key]);
const forbiddenMarkers = ['source_path', 'source_sha256', 'launch_record', 'raw_transcript', 'original_prompt'];
for (const marker of forbiddenMarkers) if (JSON.stringify(fixture).includes(marker)) throw new Error('Private source marker in distributable fixture');
const roots = ['src', 'sdk', 'scripts', 'web', 'fixtures', 'docs', 'test', '.github', 'plugins', '.agents'];
async function filesUnder(directory) { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat(); }
const files = (await Promise.all(roots.map(root => filesUnder(root)))).flat().concat(['README.md', 'package.json', 'Dockerfile', 'compose.yaml']);
for (const filename of files) {
  const content = await readFile(filename, 'utf8');
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(content)) throw new Error('CJK artifact text in ' + filename);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) throw new Error('Private key material in ' + filename);
}
try {
  const tracked = execFileSync('git', ['ls-files', '--cached'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
  if (tracked.some(filename => /^(\.data|\.local)\/|\.(sqlite|key|pem)$|^\.env/.test(filename))) throw new Error('Runtime state or credential file is tracked');
} catch (error) { if (error.status === undefined) throw error; }
console.log('Privacy/artifact audit PASS: sanitized fixture, English artifacts, no tracked runtime state or private keys. Pattern checks do not guarantee semantic de-identification.');
