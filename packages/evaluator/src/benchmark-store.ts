import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type BenchmarkClaim,
  type BenchmarkResult,
  benchmarkCells,
  benchmarkHash,
  summarizeBenchmark,
  validateBenchmark,
  validateBenchmarkClaim,
  validateBenchmarkResult,
} from './benchmark.ts';
import { assert, canonical, identifier } from './contract.ts';

const APPLICATION_ID = 0x48424d31;
interface Row {
  hash: string;
  json: string;
}
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

export class BenchmarkStore {
  private db: DatabaseSync;

  constructor(filename: string, create = filename === ':memory:', readOnly = false) {
    this.db = new DatabaseSync(filename, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const id = this.db.prepare('PRAGMA application_id').get()?.application_id;
      if (create) {
        assert(
          id === 0 && !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get(),
          'Refuse to initialize a nonempty database',
        );
        this.db.exec(`
          BEGIN IMMEDIATE;
          PRAGMA application_id=${APPLICATION_ID};
          CREATE TABLE benchmark_runs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE benchmark_claims (run_id TEXT NOT NULL REFERENCES benchmark_runs(id), attempt_id TEXT NOT NULL, context_id TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id,attempt_id), UNIQUE(run_id,context_id));
          CREATE TABLE benchmark_results (run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(run_id,attempt_id), FOREIGN KEY(run_id,attempt_id) REFERENCES benchmark_claims(run_id,attempt_id));
          COMMIT;
        `);
      } else
        assert(
          id === APPLICATION_ID,
          'Use a benchmark database; peer history databases are not accepted',
        );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  private transaction<T>(write: boolean, action: () => T): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private spec(runId: string) {
    identifier(runId);
    const row = this.db
      .prepare('SELECT hash,json FROM benchmark_runs WHERE id=?')
      .get(runId) as unknown as Row | undefined;
    assert(row, 'Unknown benchmark run');
    const spec = validateBenchmark(JSON.parse(row.json));
    assert(benchmarkHash(spec) === row.hash, 'Stored benchmark fingerprint differs');
    return spec;
  }
  create(runId: string, input: unknown) {
    identifier(runId);
    const spec = validateBenchmark(input);
    const hash = benchmarkHash(spec);
    return this.transaction(true, () => {
      const row = this.db.prepare('SELECT hash FROM benchmark_runs WHERE id=?').get(runId);
      if (row) {
        assert(
          row.hash === hash && benchmarkHash(this.spec(runId)) === hash,
          'Run already exists with a different frozen benchmark',
        );
        return {
          status: 'already-created',
          run_id: runId,
          benchmark_hash: hash,
          expected_attempts: benchmarkCells(spec).length,
        };
      }
      this.db
        .prepare('INSERT INTO benchmark_runs VALUES (?,?,?,?)')
        .run(runId, hash, canonical(spec), new Date().toISOString());
      return {
        status: 'created',
        run_id: runId,
        benchmark_hash: hash,
        expected_attempts: benchmarkCells(spec).length,
      };
    });
  }
  next(runId: string) {
    return this.transaction(false, () => {
      const spec = this.spec(runId);
      const claims = this.db
        .prepare('SELECT attempt_id FROM benchmark_claims WHERE run_id=?')
        .all(runId);
      const results = this.db
        .prepare('SELECT attempt_id FROM benchmark_results WHERE run_id=?')
        .all(runId);
      const cell = benchmarkCells(spec).find(
        (item) => !claims.some((claim) => claim.attempt_id === item.attempt_id),
      );
      if (!cell)
        return {
          status:
            results.length === claims.length
              ? ('finished' as const)
              : ('waiting-for-results' as const),
          run_id: runId,
          claimed: claims.length,
          recorded: results.length,
          boundary:
            'Claimed executions are never relaunched automatically; resolve an uncertain attempt explicitly.',
        };
      const task = spec.tasks.find((item) => item.id === cell.task_id);
      const candidate = spec.candidates.find((item) => item.id === cell.candidate_id);
      assert(task && candidate, 'Unknown benchmark task or candidate');
      return {
        status: 'needs-host-execution' as const,
        run_id: runId,
        benchmark_hash: benchmarkHash(spec),
        ...cell,
        evidence_kind: spec.evidence_kind,
        candidate,
        environment: spec.environment,
        limits: spec.limits,
        task: { id: task.id, category: task.category, prompt: task.prompt, input: task.input },
        output_contract:
          'Return one JSON value. Grading criteria and expected answers stay outside this handoff.',
        boundary:
          'Preflight the actual model and independent context, claim before execution, and launch only when dispatch_allowed is true. A handoff does not start a model or authorize external data transfer.',
      };
    });
  }
  claim(input: unknown) {
    const runId = (input as BenchmarkClaim)?.run_id;
    return this.transaction(true, () => {
      const spec = this.spec(runId);
      const claim = validateBenchmarkClaim(input, runId, spec);
      const hash = benchmarkHash(claim);
      const prior = this.db
        .prepare('SELECT hash,json FROM benchmark_claims WHERE run_id=? AND attempt_id=?')
        .get(runId, claim.attempt_id) as unknown as Row | undefined;
      if (prior) {
        assert(
          prior.hash === hash && benchmarkHash(JSON.parse(prior.json)) === hash,
          'Attempt is already claimed with a different context or binding',
        );
        return { status: 'already-claimed', claim_hash: hash, dispatch_allowed: false };
      }
      assert(
        !this.db
          .prepare('SELECT attempt_id FROM benchmark_claims WHERE run_id=? AND context_id=?')
          .get(runId, claim.binding.context_id),
        'Benchmark attempts require distinct actual conversation contexts',
      );
      this.db
        .prepare('INSERT INTO benchmark_claims VALUES (?,?,?,?,?,?)')
        .run(
          runId,
          claim.attempt_id,
          claim.binding.context_id,
          hash,
          canonical(claim),
          new Date().toISOString(),
        );
      return { status: 'claimed', claim_hash: hash, dispatch_allowed: true };
    });
  }
  complete(input: unknown) {
    const runId = (input as BenchmarkResult)?.run_id;
    return this.transaction(true, () => {
      const spec = this.spec(runId);
      const attemptId = (input as BenchmarkResult)?.attempt_id;
      assert(typeof attemptId === 'string', 'Supply a benchmark attempt');
      const claimRow = this.db
        .prepare('SELECT hash,json FROM benchmark_claims WHERE run_id=? AND attempt_id=?')
        .get(runId, attemptId) as unknown as Row | undefined;
      assert(claimRow, 'Claim the actual execution before recording a result');
      const claim = validateBenchmarkClaim(JSON.parse(claimRow.json), runId, spec);
      assert(benchmarkHash(claim) === claimRow.hash, 'Stored claim fingerprint differs');
      const result = validateBenchmarkResult(input, claim, spec);
      const hash = benchmarkHash(result);
      const prior = this.db
        .prepare('SELECT hash,json FROM benchmark_results WHERE run_id=? AND attempt_id=?')
        .get(runId, attemptId) as unknown as Row | undefined;
      if (prior) {
        assert(
          prior.hash === hash && benchmarkHash(JSON.parse(prior.json)) === hash,
          'Attempt already has a different immutable result',
        );
        return { status: 'already-recorded', result_hash: hash };
      }
      this.db
        .prepare('INSERT INTO benchmark_results VALUES (?,?,?,?,?)')
        .run(runId, attemptId, hash, canonical(result), new Date().toISOString());
      return { status: 'recorded', result_hash: hash };
    });
  }
  report(runId: string) {
    return this.transaction(false, () => {
      const spec = this.spec(runId);
      const rows = this.db
        .prepare('SELECT hash,json FROM benchmark_results WHERE run_id=? ORDER BY attempt_id')
        .all(runId) as unknown as Row[];
      const results = rows.map((row) => {
        const input = JSON.parse(row.json) as BenchmarkResult;
        assert(benchmarkHash(input) === row.hash, 'Stored result fingerprint differs');
        const claimRow = this.db
          .prepare('SELECT hash,json FROM benchmark_claims WHERE run_id=? AND attempt_id=?')
          .get(runId, input.attempt_id) as unknown as Row | undefined;
        assert(claimRow, 'Result has no execution claim');
        const claim = validateBenchmarkClaim(JSON.parse(claimRow.json), runId, spec);
        assert(benchmarkHash(claim) === claimRow.hash, 'Stored claim fingerprint differs');
        return validateBenchmarkResult(input, claim, spec);
      });
      const claims = this.db
        .prepare('SELECT attempt_id,context_id FROM benchmark_claims WHERE run_id=?')
        .all(runId);
      return {
        run_id: runId,
        ...summarizeBenchmark(spec, results),
        pending: benchmarkCells(spec)
          .filter((cell) => !results.some((result) => result.attempt_id === cell.attempt_id))
          .map((cell) => ({
            ...cell,
            status: claims.some((claim) => claim.attempt_id === cell.attempt_id)
              ? 'claimed-uncertain'
              : 'not-started',
          })),
      };
    });
  }
}

export async function openBenchmarkStore(filename: string, mode: 'create' | 'write' | 'read') {
  assert(
    typeof filename === 'string' &&
      path.isAbsolute(filename) &&
      path.extname(filename) === '.sqlite',
    'Supply an absolute local benchmark .sqlite file',
  );
  assert(!/^(?:\\\\|\/\/)/.test(filename), 'Benchmark data stays on a local filesystem');
  const resolved = path.resolve(filename);
  let parent = path.parse(resolved).root;
  for (const name of path
    .relative(parent, path.dirname(resolved))
    .split(path.sep)
    .filter(Boolean)) {
    parent = path.join(parent, name);
    try {
      const entry = await lstat(parent);
      assert(
        entry.isDirectory() && !entry.isSymbolicLink(),
        'Benchmark parent paths cannot be links',
      );
    } catch (error) {
      if (code(error) !== 'ENOENT' || mode !== 'create') throw error;
      await mkdir(parent);
    }
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const entry = await lstat(resolved + suffix);
      assert(
        entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1,
        'Benchmark database and sidecars must be regular unlinked files',
      );
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
  }
  let created = false;
  if (mode === 'create') {
    try {
      const handle = await open(
        resolved,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.close();
      created = true;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
  } else await lstat(resolved);
  return new BenchmarkStore(resolved, created, mode === 'read');
}
