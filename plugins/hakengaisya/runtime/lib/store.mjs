import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { check, isText } from './validate.mjs';

export async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

export function resolveRunFile(filename, base) {
  check(isText(filename), 'Supply the run file path');
  check(
    base || path.isAbsolute(filename),
    'Use an absolute run_file path inside the task workspace, or configure the workspace base directory',
  );
  const resolved = base ? path.resolve(base, filename) : path.resolve(filename);
  check(path.extname(resolved).toLowerCase() === '.json', 'Run files use the .json extension');
  return resolved;
}

export async function readRun(filename) {
  const run = await readJson(filename);
  check(
    run &&
      typeof run === 'object' &&
      !Array.isArray(run) &&
      typeof run.run_id === 'string' &&
      Number.isInteger(run.revision) &&
      run.packets &&
      typeof run.packets === 'object' &&
      Array.isArray(run.journal),
    `Not a persisted Hakengaisya run: ${filename}`,
  );
  return run;
}

export async function createRunFile(filename, run) {
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    await writeFile(filename, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`Run file already exists; create refuses to overwrite a run: ${filename}`);
    throw error;
  }
}

async function lockHolder(lock) {
  try {
    const holder = JSON.parse(await readFile(lock, 'utf8'));
    return Number.isInteger(holder?.pid)
      ? ` (held by pid ${holder.pid} since ${holder.started_at})`
      : '';
  } catch {
    // An unreadable or half-written lock is still a lock; report it without metadata.
    return '';
  }
}

// The lock file records its writer so a crash leaves something to inspect. A stale lock is
// never removed automatically: the helper cannot tell a crashed writer from a slow one.
async function acquireLock(lock, filename) {
  let handle;
  try {
    handle = await open(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(
      `Another writer holds the run lock${await lockHolder(lock)}; retry after it finishes. Inspect a crash before removing a stale lock.`,
    );
  }
  const holder = { pid: process.pid, started_at: new Date().toISOString(), run_file: filename };
  await handle.writeFile(`${JSON.stringify(holder)}\n`);
  return handle;
}

async function removeIfPresent(filename) {
  try {
    await unlink(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Read, transform and atomically replace a run under the single-writer lock. If update throws,
// the persisted file is untouched and the lock is released.
export async function updateRun(filename, update) {
  const lock = `${filename}.lock`;
  const handle = await acquireLock(lock, filename);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const updated = await update(await readRun(filename));
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, filename);
    return updated;
  } finally {
    await handle.close();
    await unlink(lock);
    await removeIfPresent(temporary);
  }
}
