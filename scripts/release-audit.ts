import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root, runtimeFiles, runtimeRoot, stagedFiles } from './runtime-files.ts';

const files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
if (!files.length) throw new Error('Stage or check out the intended release files before auditing');
const blocked =
  /(?:^|\/)(?:\.data|\.local|\.hakengaisya-evaluator|\.hakengaisya-exchange|\.hakengaisya-learning|__pycache__|node_modules|runs|coverage)(?:\/|$)|^(?:staff\/imported\/|staff\/registry\.json$|wiki\/)|\.(?:sqlite(?:-wal|-shm)?|key|pem|log|pyc)$|(?:^|\/)\.env(?:\.|$)/i;
for (const relative of files) {
  if (blocked.test(relative))
    throw new Error(`Runtime/private file in publication set: ${relative}`);
  const filename = path.join(root, relative);
  if (!lstatSync(filename).isFile())
    throw new Error(`Only ordinary source files may be published: ${relative}`);
  const content = readFileSync(filename, 'utf8');
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(content))
    throw new Error(`Unexpected CJK artifact: ${relative}`);
  if (/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Example\b)[^\s"']+/i.test(content))
    throw new Error(`Personal home path in publication set: ${relative}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/]{24}/.test(content))
    throw new Error(`Private key material in publication set: ${relative}`);
  if (
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,}|sk-[A-Za-z0-9_-]{24,})\b/.test(
      content,
    )
  )
    throw new Error(`Possible credential in publication set: ${relative}`);
}
const expected = runtimeFiles();
for (const file of expected) {
  const source = readFileSync(path.join(root, file));
  const staged = readFileSync(path.join(runtimeRoot, file));
  if (!source.equals(staged)) throw new Error(`Packaged workflow runtime differs: ${file}`);
}
const unexpected = stagedFiles().filter((file: string) => !expected.includes(file));
if (unexpected.length) {
  throw new Error(`Packaged workflow runtime has stale files: ${unexpected.join(', ')}`);
}
console.log(
  'Release audit PASS: ' +
    files.length +
    ' staged source files; local histories, credentials, databases and generated private output are excluded. Pattern checks do not prove semantic de-identification.',
);
