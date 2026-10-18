import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage or check out the intended release files before auditing');
const blocked = /(?:^|\/)(?:\.data|\.local|\.hakengaisya-evaluator|node_modules|runs|coverage)(?:\/|$)|^(?:staff\/imported\/|staff\/registry\.json$|wiki\/)|\.(?:sqlite(?:-wal|-shm)?|key|pem|log)$|(?:^|\/)\.env(?:\.|$)/i;
for (const relative of files) {
  if (blocked.test(relative)) throw new Error('Runtime/private file in publication set: ' + relative);
  const filename = path.join(root, relative);
  if (!lstatSync(filename).isFile()) throw new Error('Only ordinary source files may be published: ' + relative);
  const content = readFileSync(filename, 'utf8');
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(content)) throw new Error('Unexpected CJK artifact: ' + relative);
  if (/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Example\b)[^\s"']+/i.test(content)) throw new Error('Personal home path in publication set: ' + relative);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/]{24}/.test(content)) throw new Error('Private key material in publication set: ' + relative);
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,}|sk-[A-Za-z0-9_-]{24,})\b/.test(content)) throw new Error('Possible credential in publication set: ' + relative);
}
for (const file of ['lib/workflow.mjs', 'lib/planning.mjs', 'lib/dispatch.mjs', 'lib/supervision.mjs', 'lib/triage.mjs', 'lib/organization.mjs', 'config/organization-modules.json', 'scripts/workflow.mjs']) {
  if (!readFileSync(path.join(root, file)).equals(readFileSync(path.join(root, 'plugins/hakengaisya/runtime', file)))) throw new Error('Packaged workflow runtime differs: ' + file);
}
console.log('Release audit PASS: ' + files.length + ' staged source files; local histories, credentials, databases and generated private output are excluded. Pattern checks do not prove semantic de-identification.');
