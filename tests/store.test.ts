import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunFile, readRun, resolveRunFile, updateRun } from '../lib/store.ts';
import type { WorkItemInput } from '../lib/types.ts';
import { createRun } from '../lib/workflow.ts';

const work = (id: string): WorkItemInput => ({
  id,
  objective: `Deliver ${id}`,
  task_type: 'implementation',
  difficulty: 'routine',
  skills: ['implementation'],
  depends_on: [],
  inputs: ['task_brief'],
  writes: [`src/${id}`],
  outputs: [`${id}_artifact`],
  acceptance: ['Behavior works.'],
});
const run = () =>
  createRun(null, {
    run_id: 'store-fixture',
    lead_context: 'host',
    domain: 'software-engineering',
    evidence_kind: 'simulation',
    objective: 'Persist synthetic state.',
    constraints: [],
    acceptance: ['The run persists.'],
    work_items: [work('only')],
  });
const sandbox = () => mkdtemp(path.join(tmpdir(), 'hakengaisya-store-'));

test('run file paths must be explicit json files inside a known workspace', () => {
  assert.throws(() => resolveRunFile('runs/task.json', null), /absolute/);
  assert.equal(
    resolveRunFile('runs/task.json', '/workspace'),
    path.resolve('/workspace', 'runs/task.json'),
  );
  assert.throws(() => resolveRunFile('/workspace/runs/task.txt', null), /json/);
  assert.throws(() => resolveRunFile('', '/workspace'), /path/);
});

test('create builds missing parent directories and never overwrites an existing run', async () => {
  const filename = path.join(await sandbox(), 'nested', 'runs', 'task.json');
  await createRunFile(filename, run());
  assert.equal((await readRun(filename)).run_id, 'store-fixture');
  await assert.rejects(createRunFile(filename, run()), /already exists/);
  await writeFile(`${filename}.other.json`, JSON.stringify({ not: 'a run' }));
  await assert.rejects(readRun(`${filename}.other.json`), /Not a persisted Hakengaisya run/);
});

test('updates hold an inspectable single-writer lock and replace the file atomically', async () => {
  const filename = path.join(await sandbox(), 'task.json');
  await createRunFile(filename, run());
  let release: ((value: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = updateRun(filename, async (current) => {
    await gate;
    return { ...current, revision: current.revision + 1 };
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lock = JSON.parse(await readFile(`${filename}.lock`, 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.match(lock.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lock.run_file, filename);
  await assert.rejects(
    updateRun(filename, (current) => current),
    new RegExp(`held by pid ${process.pid}`),
  );
  assert.ok(release);
  release(undefined);
  assert.equal((await slow).revision, 1);
  assert.equal((await readRun(filename)).revision, 1);
  assert.deepEqual(await readdir(path.dirname(filename)), ['task.json']);
});

test('a failing update leaves the persisted run and directory untouched', async () => {
  const filename = path.join(await sandbox(), 'task.json');
  await createRunFile(filename, run());
  const before = await readFile(filename, 'utf8');
  await assert.rejects(
    updateRun(filename, () => {
      throw new Error('synthetic failure');
    }),
    /synthetic failure/,
  );
  assert.equal(await readFile(filename, 'utf8'), before);
  assert.deepEqual(await readdir(path.dirname(filename)), ['task.json']);
  assert.equal((await updateRun(filename, (current) => ({ ...current, revision: 5 }))).revision, 5);
});
