import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Run } from './types.ts';
import { check, isRecord, isText } from './validate.ts';

const errorCode = (error: unknown): unknown => (isRecord(error) ? error.code : undefined);

export async function readJson(filename: string | URL): Promise<unknown> {
  return JSON.parse(await readFile(filename, 'utf8'));
}

export function resolveRunFile(filename: unknown, base?: string | null): string {
  check(isText(filename), 'Supply the run file path');
  check(
    base || path.isAbsolute(filename),
    'Use an absolute run_file path inside the task workspace, or configure the workspace base directory',
  );
  const resolved = base ? path.resolve(base, filename) : path.resolve(filename);
  check(path.extname(resolved).toLowerCase() === '.json', 'Run files use the .json extension');
  return resolved;
}

// Structural recognition only; event application revalidates everything it relies on.
const isPersistedRun = (value: unknown): value is Run =>
  isRecord(value) &&
  typeof value.run_id === 'string' &&
  Number.isInteger(value.revision) &&
  isRecord(value.packets) &&
  Array.isArray(value.journal);

export async function readRun(filename: string): Promise<Run> {
  const run = await readJson(filename);
  check(isPersistedRun(run), `Not a persisted Hakengaisya run: ${filename}`);
  return run;
}

export async function createRunFile(filename: string, run: Run): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    await writeFile(filename, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(`Run file already exists; create refuses to overwrite a run: ${filename}`);
    }
    throw error;
  }
}

async function lockHolder(lock: string): Promise<string> {
  try {
    const holder: unknown = JSON.parse(await readFile(lock, 'utf8'));
    return isRecord(holder) && Number.isInteger(holder.pid)
      ? ` (held by pid ${holder.pid} since ${holder.started_at})`
      : '';
  } catch {
    // An unreadable or half-written lock is still a lock; report it without metadata.
    return '';
  }
}

// The lock file records its writer so a crash leaves something to inspect. A stale lock is
// never removed automatically: the helper cannot tell a crashed writer from a slow one.
async function acquireLock(lock: string, filename: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(lock, 'wx');
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    throw new Error(
      `Another writer holds the run lock${await lockHolder(lock)}; retry after it finishes. Inspect a crash before removing a stale lock.`,
    );
  }
  const holder = { pid: process.pid, started_at: new Date().toISOString(), run_file: filename };
  await handle.writeFile(`${JSON.stringify(holder)}\n`);
  return handle;
}

async function removeIfPresent(filename: string): Promise<void> {
  try {
    await unlink(filename);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

// Read, transform and atomically replace a run under the single-writer lock. If update throws,
// the persisted file is untouched and the lock is released.
export async function updateRun(
  filename: string,
  update: (run: Run) => Run | Promise<Run>,
): Promise<Run> {
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
