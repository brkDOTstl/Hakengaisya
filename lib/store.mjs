import { readFile, writeFile, open, rename, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const check = (ok, message) => { if (!ok) throw new Error(message); };

export async function readJson(filename) { return JSON.parse(await readFile(filename, 'utf8')); }

export function resolveRunFile(filename, base) {
  check(typeof filename === 'string' && filename.trim(), 'Supply the run file path');
  check(base || path.isAbsolute(filename), 'Use an absolute run_file path inside the task workspace, or configure the workspace base directory');
  const resolved = base ? path.resolve(base, filename) : path.resolve(filename);
  check(path.extname(resolved).toLowerCase() === '.json', 'Run files use the .json extension');
  return resolved;
}

export async function readRun(filename) {
  const run = await readJson(filename);
  check(run && typeof run === 'object' && !Array.isArray(run) && typeof run.run_id === 'string' && Number.isInteger(run.revision) && run.packets && typeof run.packets === 'object' && Array.isArray(run.journal), 'Not a persisted Hakengaisya run: ' + filename);
  return run;
}

export async function createRunFile(filename, run) {
  await mkdir(path.dirname(filename), { recursive: true });
  try { await writeFile(filename, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Run file already exists; create refuses to overwrite a run: ' + filename); throw error; }
}

export async function updateRun(filename, update) {
  const lock = filename + '.lock';
  let handle;
  try { handle = await open(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let holder = null;
    try { holder = JSON.parse(await readFile(lock, 'utf8')); } catch { /* An unreadable lock is still a lock; report it without metadata. */ }
    const detail = holder && Number.isInteger(holder.pid) ? ' (held by pid ' + holder.pid + ' since ' + holder.started_at + ')' : '';
    throw new Error('Another writer holds the run lock' + detail + '; retry after it finishes. Inspect a crash before removing a stale lock.');
  }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), run_file: filename }) + '\n');
    const updated = await update(await readRun(filename));
    await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, filename);
    return updated;
  } finally {
    await handle.close(); await unlink(lock);
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
