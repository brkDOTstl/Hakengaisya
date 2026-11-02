import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { link, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type BenchmarkClaim,
  type BenchmarkResult,
  type BenchmarkSpec,
  benchmarkCells,
  benchmarkHash,
  gradeBenchmarkResult,
  validateBenchmark,
} from '../src/benchmark.ts';
import { benchmarkCommand } from '../src/benchmark-commands.ts';
import { BenchmarkStore, openBenchmarkStore } from '../src/benchmark-store.ts';
import { Store } from '../src/store.ts';

const fixture = validateBenchmark(
  JSON.parse(await readFile(new URL('../fixtures/benchmark-smoke.json', import.meta.url), 'utf8')),
);
const spec = () => structuredClone(fixture);
function claimFor(
  value: BenchmarkSpec,
  index: number,
  context = `context-${index}`,
): BenchmarkClaim {
  const cell = benchmarkCells(value)[index];
  const candidate = value.candidates.find((item) => item.id === cell.candidate_id);
  assert.ok(candidate);
  return {
    run_id: 'run',
    attempt_id: cell.attempt_id,
    benchmark_hash: benchmarkHash(value),
    binding: {
      model: candidate.model,
      route: candidate.route,
      effort: candidate.effort,
      configuration_ref: candidate.configuration_ref,
      environment_id: value.environment.id,
      context_id: context,
      identity_evidence: 'Synthetic fixture identity.',
    },
  };
}
function resultFor(
  value: BenchmarkSpec,
  claim: BenchmarkClaim,
  overrides: Partial<BenchmarkResult> = {},
): BenchmarkResult {
  const cell = benchmarkCells(value).find((item) => item.attempt_id === claim.attempt_id);
  assert.ok(cell);
  return {
    ...claim,
    claim_hash: benchmarkHash(claim),
    status: 'completed',
    output: cell.task_id === 'ledger' ? { total_cents: 2200 } : { id: 'item-one', active: false },
    usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.002, wall_seconds: 2 },
    cost_basis: 'fixture',
    cost_reference: 'Synthetic price.',
    evidence_reference: 'Synthetic fixture result and usage.',
    failure_reason: null,
    ...overrides,
  };
}

test('freezes a scoped task matrix and withholds grading answers from worker handoffs', () => {
  const value = spec();
  const store = new BenchmarkStore(':memory:');
  try {
    const created = store.create('run', value);
    assert.equal(created.expected_attempts, 4);
    assert.equal(store.create('run', value).status, 'already-created');
    value.tasks[0].criteria[0].expected = 999;
    assert.throws(() => store.create('run', value), /different frozen benchmark/);
    const next = store.next('run');
    assert.ok(next.status === 'needs-host-execution');
    assert.equal(Object.hasOwn(next.task ?? {}, 'criteria'), false);
    assert.equal(JSON.stringify(next).includes('2200'), false);
    assert.equal(store.report('run').benchmark_hash, created.benchmark_hash);
  } finally {
    store.close();
  }
});

test('validates bounded task contracts, unique routes, JSON values and pointers', () => {
  const duplicate = spec();
  duplicate.tasks.push(duplicate.tasks[0]);
  assert.throws(() => validateBenchmark(duplicate), /Duplicate task/);
  const large = spec();
  large.repeats = 6;
  assert.throws(() => validateBenchmark(large), /numeric|repeats/);
  const unknown = { ...spec(), secret: 'not-accepted' };
  assert.throws(() => validateBenchmark(unknown), /Field not accepted/);
  const invalid = spec();
  invalid.tasks[0].criteria[0].pointer = '/bad~2escape';
  assert.throws(() => validateBenchmark(invalid), /pointer escape/);
  const nonfinite = spec();
  nonfinite.tasks[0].input = Number.NaN;
  assert.throws(() => validateBenchmark(nonfinite), /finite/);
});

test('claims exactly once, rejects relabeling and requires different actual conversation contexts', () => {
  const value = spec();
  const store = new BenchmarkStore(':memory:');
  try {
    store.create('run', value);
    const claim = claimFor(value, 0);
    assert.equal(store.claim(claim).dispatch_allowed, true);
    assert.equal(store.claim(claim).dispatch_allowed, false);
    assert.throws(
      () => store.claim({ ...claim, binding: { ...claim.binding, model: 'wrong' } }),
      /Actual model/,
    );
    assert.throws(
      () =>
        store.claim({
          ...claim,
          binding: { ...claim.binding, configuration_ref: 'changed-config' },
        }),
      /Actual configuration/,
    );
    assert.throws(
      () => store.claim({ ...claim, binding: { ...claim.binding, environment_id: 'changed-env' } }),
      /Actual environment/,
    );
    assert.throws(() => store.claim(claimFor(value, 0, 'replacement')), /already claimed/);
    assert.throws(
      () => store.claim(claimFor(value, 1, claim.binding.context_id)),
      /distinct actual conversation/,
    );
    assert.throws(() => store.claim({ ...claim, benchmark_hash: 'changed' }), /fingerprint/);
    assert.equal(store.report('run').pending[0].status, 'claimed-uncertain');
  } finally {
    store.close();
  }
});

test('records immutable attempt results with idempotent retries and exact claim binding', () => {
  const value = spec();
  const store = new BenchmarkStore(':memory:');
  try {
    store.create('run', value);
    const claim = claimFor(value, 0);
    const result = resultFor(value, claim);
    assert.throws(() => store.complete(result), /Claim the actual execution/);
    store.claim(claim);
    assert.equal(store.complete(result).status, 'recorded');
    assert.equal(store.complete(result).status, 'already-recorded');
    assert.throws(
      () => store.complete({ ...result, output: { total_cents: 0 } }),
      /immutable result/,
    );
    assert.throws(() => store.complete({ ...result, claim_hash: 'wrong' }), /claimed execution/);
    assert.throws(() => store.complete({ ...result, score: 1 }), /Field not accepted/);
    assert.equal(store.report('run').candidates[0].mean_score, 1);
    assert.equal(store.report('run').observed_frontier.length, 0);
  } finally {
    store.close();
  }
});

test('objective grading distinguishes false and zero, missing and null, required and optional checks', () => {
  const value = spec();
  const claim = claimFor(value, 2);
  const result = resultFor(value, claim, { output: { id: 'item-one', active: 0 } });
  const grade = gradeBenchmarkResult(value, value.tasks[1], result);
  assert.equal(grade.raw_score, 0.5);
  assert.equal(grade.score, 0);
  assert.equal(grade.passed, false);
  value.tasks[1].criteria[1].required = false;
  assert.equal(gradeBenchmarkResult(value, value.tasks[1], result).score, 0.5);
  value.tasks[1].criteria = [
    { id: 'null-check', pointer: '/value', expected: null, weight: 1, required: true },
  ];
  assert.equal(
    gradeBenchmarkResult(value, value.tasks[1], { ...result, output: {} }).passed,
    false,
  );
  assert.equal(
    gradeBenchmarkResult(value, value.tasks[1], { ...result, output: { value: null } }).passed,
    true,
  );
  value.tasks[1].criteria[0] = {
    id: 'escaped',
    pointer: '/a~1b/~0key',
    expected: [1, false],
    weight: 1,
    required: true,
  };
  assert.equal(
    gradeBenchmarkResult(value, value.tasks[1], {
      ...result,
      output: { 'a/b': { '~key': [1, false] } },
    }).passed,
    true,
  );
});

test('known resource overruns and terminal failures cannot become successful cheap work', () => {
  const value = spec();
  const store = new BenchmarkStore(':memory:');
  try {
    store.create('run', value);
    for (const [index] of benchmarkCells(value).entries()) {
      const claim = claimFor(value, index);
      store.claim(claim);
      store.complete(
        resultFor(
          value,
          claim,
          index === 0
            ? {
                usage: { input_tokens: 100, output_tokens: 1001, cost_usd: 0.001, wall_seconds: 1 },
              }
            : index === 1
              ? { status: 'interrupted', output: null, failure_reason: 'Fixture interruption.' }
              : {},
        ),
      );
    }
    const report = store.report('run');
    assert.equal(report.complete, true);
    assert.equal(report.candidates[0].limit_exceeded, 1);
    assert.equal(report.candidates[1].failed, 1);
    assert.deepEqual(report.observed_frontier, []);
  } finally {
    store.close();
  }
});

test('keeps missing time, missing cost and incomparable pricing bases out of frontier decisions', () => {
  const value = spec();
  value.evidence_kind = 'host-observed';
  const store = new BenchmarkStore(':memory:');
  try {
    store.create('run', value);
    for (const [index] of benchmarkCells(value).entries()) {
      const claim = claimFor(value, index);
      store.claim(claim);
      const basis =
        index === 0 ? 'unknown' : index === 1 ? 'actual-billed' : 'api-equivalent-estimate';
      store.complete(
        resultFor(value, claim, {
          cost_basis: basis,
          cost_reference: basis === 'unknown' ? null : 'Fixture reference for the declared basis.',
          usage: {
            input_tokens: null,
            output_tokens: 5,
            cost_usd: basis === 'unknown' ? null : 0.001,
            wall_seconds: index === 2 ? null : 1,
          },
        }),
      );
    }
    const report = store.report('run');
    assert.equal(report.candidates[0].total_cost_usd, null);
    assert.equal(report.candidates[0].mean_wall_seconds, null);
    assert.equal(report.candidates[1].cost_basis, 'mixed');
    assert.equal(report.candidates[1].mean_cost_usd, null);
    assert.deepEqual(report.observed_frontier, []);
  } finally {
    store.close();
  }
});

test('reports per-category coverage and only same-basis observed quality-cost-time dominance', () => {
  const value = spec();
  const store = new BenchmarkStore(':memory:');
  try {
    store.create('run', value);
    for (const [index] of benchmarkCells(value).entries()) {
      const claim = claimFor(value, index);
      store.claim(claim);
      const cost = index % 2 === 0 ? 0.001 : 0.003;
      store.complete(
        resultFor(value, claim, {
          usage: { input_tokens: 100, output_tokens: 5, cost_usd: cost, wall_seconds: cost * 1000 },
        }),
      );
    }
    const report = store.report('run');
    assert.equal(report.candidates[0].categories.length, 2);
    assert.equal(report.candidates[0].total_cost_usd, 0.002);
    assert.deepEqual(report.observed_frontier, [{ candidate_id: 'fast', cost_basis: 'fixture' }]);
    assert.equal(store.next('run').status, 'finished');
  } finally {
    store.close();
  }
});

test('does not automatically relaunch an uncertain claimed execution', () => {
  const value = spec();
  const store = new BenchmarkStore(':memory:');
  try {
    store.create('run', value);
    for (const [index] of benchmarkCells(value).entries()) store.claim(claimFor(value, index));
    assert.equal(store.next('run').status, 'waiting-for-results');
    assert.equal(store.report('run').complete, false);
    assert.equal(store.report('run').candidates[0].success_rate, null);
  } finally {
    store.close();
  }
});

test('standalone CLI persists a run across processes without loading the workflow or peer database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hkg-benchmark-'));
  const file = path.join(directory, 'benchmark.sqlite');
  const cli = new URL('../scripts/benchmark.ts', import.meta.url);
  const created = spawnSync(
    process.execPath,
    [
      fileURLToPath(cli),
      'create',
      file,
      'run',
      fileURLToPath(new URL('../fixtures/benchmark-smoke.json', import.meta.url)),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(created.status, 0, created.stderr);
  const claim = claimFor(fixture, 0);
  await benchmarkCommand('claim', file, 'run', claim);
  await benchmarkCommand('complete', file, 'run', resultFor(fixture, claim));
  const report = await benchmarkCommand('report', file, 'run');
  assert.ok('recorded_attempts' in report);
  assert.equal(report.recorded_attempts, 1);
  await assert.rejects(benchmarkCommand('claim', file, 'other', claim), /selected benchmark run/);
});

test('concurrent host processes cannot both claim the same execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hkg-benchmark-race-'));
  const file = path.join(directory, 'benchmark.sqlite');
  await benchmarkCommand('create', file, 'run', fixture);
  const module = pathToFileURL(
    path.resolve(import.meta.dirname, '../src/benchmark-commands.ts'),
  ).href;
  const invoke = (context: string) =>
    new Promise<{ status?: string; dispatch_allowed?: boolean; error?: string }>(
      (resolve, reject) => {
        const script = `const {benchmarkCommand}=await import(${JSON.stringify(module)});try{console.log(JSON.stringify(await benchmarkCommand('claim',process.env.BENCHMARK_FILE,'run',JSON.parse(process.env.BENCHMARK_CLAIM))));}catch(error){console.log(JSON.stringify({error:error.message}));}`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          env: {
            ...process.env,
            BENCHMARK_FILE: file,
            BENCHMARK_CLAIM: JSON.stringify(claimFor(fixture, 0, context)),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (part) => {
          output += part;
        });
        child.on('error', reject);
        child.on('exit', () => {
          try {
            resolve(JSON.parse(output));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
  const results = await Promise.all([invoke('first'), invoke('second')]);
  assert.equal(results.filter((result) => result.dispatch_allowed).length, 1);
  assert.equal(results.filter((result) => result.error?.includes('already claimed')).length, 1);
});

test('refuses peer-history databases and linked database paths without modifying peer history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hkg-benchmark-isolation-'));
  const peerFile = path.join(directory, 'peer.sqlite');
  const peer = new Store(peerFile);
  peer.close();
  const before = await readFile(peerFile);
  await assert.rejects(openBenchmarkStore(peerFile, 'create'), /peer history/);
  assert.deepEqual(await readFile(peerFile), before);
  const file = path.join(directory, 'benchmark.sqlite');
  const store = await openBenchmarkStore(file, 'create');
  store.create('run', fixture);
  store.close();
  const alias = path.join(directory, 'alias.sqlite');
  await link(file, alias);
  await assert.rejects(openBenchmarkStore(alias, 'read'), /regular unlinked/);
});
