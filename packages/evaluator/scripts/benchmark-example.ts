import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BenchmarkClaim, validateBenchmark } from '../src/benchmark.ts';
import { openBenchmarkStore } from '../src/benchmark-store.ts';

const directory = fileURLToPath(
  new URL(`../.local/benchmark-demo-${randomUUID()}/`, import.meta.url),
);
await mkdir(directory, { recursive: true });
const database = path.join(directory, 'benchmark.sqlite');
const spec = validateBenchmark(
  JSON.parse(await readFile(new URL('../fixtures/benchmark-smoke.json', import.meta.url), 'utf8')),
);
const store = await openBenchmarkStore(database, 'create');
try {
  store.create('smoke', spec);
  for (;;) {
    const next = store.next('smoke');
    if (next.status !== 'needs-host-execution') break;
    const claim: BenchmarkClaim = {
      run_id: 'smoke',
      attempt_id: next.attempt_id,
      benchmark_hash: next.benchmark_hash,
      binding: {
        model: next.candidate.model,
        route: next.candidate.route,
        effort: next.candidate.effort,
        configuration_ref: next.candidate.configuration_ref,
        environment_id: next.environment.id,
        context_id: `fixture-${next.attempt_id}`,
        identity_evidence: 'Synthetic fixture context; no agent was launched.',
      },
    };
    const claimed = store.claim(claim);
    const fast = next.candidate.id === 'fast';
    store.complete({
      ...claim,
      claim_hash: claimed.claim_hash,
      status: 'completed',
      output: next.task_id === 'ledger' ? { total_cents: 2200 } : { id: 'item-one', active: fast },
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cost_usd: fast ? 0.001 : 0.003,
        wall_seconds: fast ? 1 : 3,
      },
      cost_basis: 'fixture',
      cost_reference: 'Synthetic example values; no billing.',
      evidence_reference: 'Deterministic fixture; no actual model execution or timing.',
      failure_reason: null,
    });
  }
  const report = store.report('smoke');
  const reportFile = path.join(directory, 'report.json');
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(
    JSON.stringify(
      {
        database_file: database,
        report_file: reportFile,
        evidence_kind: report.evidence_kind,
        recorded_attempts: report.recorded_attempts,
        observed_frontier: report.observed_frontier,
        boundary:
          'Fixture execution validates local control and scoring only; no actual AI performance or savings measured.',
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
