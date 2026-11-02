import { assert, canonical, finite, identifier, object, sha256 } from './contract.ts';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type CostBasis = 'actual-billed' | 'api-equivalent-estimate' | 'fixture' | 'unknown';
export interface BenchmarkTask {
  id: string;
  category: string;
  prompt: string;
  input: JsonValue;
  criteria: {
    id: string;
    pointer: string;
    expected: JsonValue;
    weight: number;
    required: boolean;
  }[];
}
export interface BenchmarkCandidate {
  id: string;
  model: string;
  route: string;
  effort: string;
  configuration_ref: string;
}
export interface BenchmarkSpec {
  version: 1;
  benchmark_id: string;
  revision: string;
  title: string;
  evidence_kind: 'simulation' | 'host-observed';
  source: { kind: 'synthetic' | 'user-curated'; reference: string };
  environment: { id: string; description: string };
  repeats: number;
  quality_floor: number;
  limits: { max_wall_seconds: number; max_output_tokens: number };
  tasks: BenchmarkTask[];
  candidates: BenchmarkCandidate[];
}
export interface BenchmarkBinding {
  model: string;
  route: string;
  effort: string;
  configuration_ref: string;
  environment_id: string;
  context_id: string;
  identity_evidence: string;
}
export interface BenchmarkClaim {
  run_id: string;
  attempt_id: string;
  benchmark_hash: string;
  binding: BenchmarkBinding;
}
export interface BenchmarkResult extends BenchmarkClaim {
  claim_hash: string;
  status: 'completed' | 'failed' | 'interrupted';
  output: JsonValue;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd: number | null;
    wall_seconds: number | null;
  };
  cost_basis: CostBasis;
  cost_reference: string | null;
  evidence_reference: string;
  failure_reason: string | null;
}
export interface BenchmarkCell {
  attempt_id: string;
  task_id: string;
  candidate_id: string;
  repeat: number;
}

export const benchmarkHash = (value: unknown) => sha256(canonical(value));

function text(value: unknown, label: string, maximum = 4000): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, label);
}
function json(value: unknown): asserts value is JsonValue {
  let count = 0;
  function visit(item: unknown, depth: number): void {
    assert(depth <= 24 && ++count <= 20000, 'JSON value is too deeply nested or large');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      assert(Number.isFinite(item), 'JSON numbers must be finite');
      return;
    }
    if (typeof item === 'string') {
      assert(item.length <= 100000, 'JSON text is too large');
      return;
    }
    assert(item && typeof item === 'object', 'Expected a JSON value');
    assert(
      Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype,
      'Expected plain JSON',
    );
    for (const child of Object.values(item)) visit(child, depth + 1);
  }
  visit(value, 0);
  assert(Buffer.byteLength(canonical(value)) <= 1000000, 'JSON value exceeds one megabyte');
}
function unique(items: { id: string }[], label: string): void {
  assert(new Set(items.map((item) => item.id)).size === items.length, `Duplicate ${label}`);
}
function pointer(value: unknown): asserts value is string {
  assert(typeof value === 'string' && value.length <= 1000, 'Invalid JSON pointer');
  assert(value === '' || value.startsWith('/'), 'JSON pointers start with a slash or are empty');
  assert(!/~(?:[^01]|$)/.test(value), 'Invalid JSON pointer escape');
}
export function validateBenchmark(input: unknown): BenchmarkSpec {
  json(input);
  object(input, [
    'version',
    'benchmark_id',
    'revision',
    'title',
    'evidence_kind',
    'source',
    'environment',
    'repeats',
    'quality_floor',
    'limits',
    'tasks',
    'candidates',
  ]);
  const spec = input as unknown as BenchmarkSpec;
  assert(spec.version === 1, 'Unsupported benchmark version');
  identifier(spec.benchmark_id);
  identifier(spec.revision);
  text(spec.title, 'Supply a benchmark title');
  assert(
    ['simulation', 'host-observed'].includes(spec.evidence_kind),
    'Unknown benchmark evidence kind',
  );
  object(spec.source, ['kind', 'reference']);
  assert(['synthetic', 'user-curated'].includes(spec.source.kind), 'Unknown task source');
  text(spec.source.reference, 'Supply the task source reference');
  object(spec.environment, ['id', 'description']);
  identifier(spec.environment.id);
  text(spec.environment.description, 'Describe the common execution environment');
  finite(spec.repeats, 5);
  assert(Number.isInteger(spec.repeats) && spec.repeats > 0, 'Use one to five repeats');
  finite(spec.quality_floor, 1);
  object(spec.limits, ['max_wall_seconds', 'max_output_tokens']);
  finite(spec.limits.max_wall_seconds, 86400);
  finite(spec.limits.max_output_tokens, 10000000);
  assert(
    spec.limits.max_wall_seconds > 0 &&
      Number.isInteger(spec.limits.max_output_tokens) &&
      spec.limits.max_output_tokens > 0,
    'Supply positive execution limits',
  );
  assert(
    Array.isArray(spec.tasks) && spec.tasks.length > 0 && spec.tasks.length <= 100,
    'Supply one to 100 tasks',
  );
  for (const task of spec.tasks) {
    object(task, ['id', 'category', 'prompt', 'input', 'criteria']);
    identifier(task.id);
    identifier(task.category);
    text(task.prompt, 'Supply a task prompt', 20000);
    assert(
      Array.isArray(task.criteria) && task.criteria.length > 0 && task.criteria.length <= 32,
      'Supply one to 32 criteria',
    );
    for (const criterion of task.criteria) {
      object(criterion, ['id', 'pointer', 'expected', 'weight', 'required']);
      identifier(criterion.id);
      pointer(criterion.pointer);
      finite(criterion.weight, 1000);
      assert(
        criterion.weight > 0 && typeof criterion.required === 'boolean',
        'Supply positive weights and explicit required flags',
      );
    }
    unique(task.criteria, 'criterion');
  }
  unique(spec.tasks, 'task');
  assert(
    Array.isArray(spec.candidates) && spec.candidates.length > 0 && spec.candidates.length <= 16,
    'Supply one to 16 candidates',
  );
  for (const candidate of spec.candidates) {
    object(candidate, ['id', 'model', 'route', 'effort', 'configuration_ref']);
    for (const key of ['id', 'model', 'route', 'effort'] as const) identifier(candidate[key]);
    text(candidate.configuration_ref, 'Pin each candidate configuration');
  }
  unique(spec.candidates, 'candidate');
  assert(
    spec.tasks.length * spec.candidates.length * spec.repeats <= 500,
    'Benchmark exceeds 500 attempts',
  );
  return structuredClone(spec);
}
export function benchmarkCells(spec: BenchmarkSpec): BenchmarkCell[] {
  return spec.tasks.flatMap((task) =>
    spec.candidates.flatMap((candidate) =>
      Array.from({ length: spec.repeats }, (_, index) => {
        const cell = { task_id: task.id, candidate_id: candidate.id, repeat: index + 1 };
        return { attempt_id: benchmarkHash(cell), ...cell };
      }),
    ),
  );
}
export function validateBenchmarkClaim(
  input: unknown,
  runId: string,
  spec: BenchmarkSpec,
): BenchmarkClaim {
  json(input);
  object(input, ['run_id', 'attempt_id', 'benchmark_hash', 'binding']);
  const claim = input as unknown as BenchmarkClaim;
  assert(
    claim.run_id === runId && claim.benchmark_hash === benchmarkHash(spec),
    'Benchmark run or fingerprint differs',
  );
  const cell = benchmarkCells(spec).find((item) => item.attempt_id === claim.attempt_id);
  assert(cell, 'Unknown benchmark attempt');
  const candidate = spec.candidates.find((item) => item.id === cell.candidate_id);
  assert(candidate, 'Unknown benchmark candidate');
  object(claim.binding, [
    'model',
    'route',
    'effort',
    'configuration_ref',
    'environment_id',
    'context_id',
    'identity_evidence',
  ]);
  for (const key of ['model', 'route', 'effort'] as const)
    assert(claim.binding[key] === candidate[key], `Actual ${key} differs from candidate`);
  assert(
    claim.binding.configuration_ref === candidate.configuration_ref,
    'Actual configuration differs from candidate',
  );
  assert(
    claim.binding.environment_id === spec.environment.id,
    'Actual environment differs from benchmark',
  );
  text(claim.binding.context_id, 'Supply an independent actual context identifier');
  text(claim.binding.identity_evidence, 'Supply host identity evidence');
  return structuredClone(claim);
}
export function validateBenchmarkResult(
  input: unknown,
  claim: BenchmarkClaim,
  spec: BenchmarkSpec,
): BenchmarkResult {
  json(input);
  object(input, [
    'run_id',
    'attempt_id',
    'benchmark_hash',
    'binding',
    'claim_hash',
    'status',
    'output',
    'usage',
    'cost_basis',
    'cost_reference',
    'evidence_reference',
    'failure_reason',
  ]);
  const result = input as unknown as BenchmarkResult;
  const request = Object.fromEntries(
    ['run_id', 'attempt_id', 'benchmark_hash', 'binding'].map((key) => [key, input[key]]),
  );
  validateBenchmarkClaim(request, claim.run_id, spec);
  assert(
    canonical(request) === canonical(claim) && result.claim_hash === benchmarkHash(claim),
    'Result differs from the claimed execution',
  );
  assert(
    ['completed', 'failed', 'interrupted'].includes(result.status),
    'Unknown attempt result status',
  );
  object(result.usage, ['input_tokens', 'output_tokens', 'cost_usd', 'wall_seconds']);
  for (const [key, value] of Object.entries(result.usage)) {
    if (value !== null) finite(value);
    if (key.endsWith('_tokens'))
      assert(value === null || Number.isInteger(value), 'Token counts must be integers');
  }
  assert(
    ['actual-billed', 'api-equivalent-estimate', 'fixture', 'unknown'].includes(result.cost_basis),
    'Unknown cost basis',
  );
  assert(
    (result.usage.cost_usd === null) === (result.cost_basis === 'unknown'),
    'Unknown cost needs null and known cost needs a basis',
  );
  if (result.usage.cost_usd !== null)
    text(result.cost_reference, 'Supply evidence or assumptions for the cost');
  else assert(result.cost_reference === null, 'Unknown cost has no price reference');
  assert(
    spec.evidence_kind === 'simulation'
      ? ['fixture', 'unknown'].includes(result.cost_basis)
      : result.cost_basis !== 'fixture',
    'Cost provenance differs from the run evidence kind',
  );
  text(result.evidence_reference, 'Supply execution and usage evidence');
  if (result.status === 'completed')
    assert(result.failure_reason === null, 'Completed results have no failure reason');
  else {
    text(result.failure_reason, 'Describe the failed or interrupted execution');
    assert(result.output === null, 'Non-completed attempts have no scored output');
  }
  return structuredClone(result);
}

function atPointer(output: JsonValue, location: string): { found: boolean; value?: JsonValue } {
  let value = output;
  for (const token of location === '' ? [] : location.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      return { found: false };
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return { found: false };
    value = (value as Record<string, JsonValue>)[key];
  }
  return { found: true, value };
}
export function gradeBenchmarkResult(
  spec: BenchmarkSpec,
  task: BenchmarkTask,
  result: BenchmarkResult,
) {
  const limitExceeded =
    (result.usage.wall_seconds !== null &&
      result.usage.wall_seconds > spec.limits.max_wall_seconds) ||
    (result.usage.output_tokens !== null &&
      result.usage.output_tokens > spec.limits.max_output_tokens);
  const completed = result.status === 'completed' && !limitExceeded;
  const criteria = task.criteria.map((criterion) => {
    const actual = atPointer(result.output, criterion.pointer);
    return {
      id: criterion.id,
      passed:
        completed && actual.found && canonical(actual.value) === canonical(criterion.expected),
      required: criterion.required,
      weight: criterion.weight,
    };
  });
  const rawScore =
    criteria.filter((item) => item.passed).reduce((total, item) => total + item.weight, 0) /
    criteria.reduce((total, item) => total + item.weight, 0);
  const requiredPassed = completed && criteria.every((item) => !item.required || item.passed);
  const score = requiredPassed ? rawScore : 0;
  return {
    score,
    raw_score: rawScore,
    required_passed: requiredPassed,
    passed: requiredPassed && score >= spec.quality_floor,
    limit_exceeded: limitExceeded,
    criteria,
  };
}

export function summarizeBenchmark(spec: BenchmarkSpec, results: BenchmarkResult[]) {
  const cells = benchmarkCells(spec);
  assert(
    new Set(results.map((result) => result.attempt_id)).size === results.length,
    'Duplicate result attempt',
  );
  const observations = results.map((result) => {
    const cell = cells.find((item) => item.attempt_id === result.attempt_id);
    assert(cell, 'Unknown result attempt');
    const task = spec.tasks.find((item) => item.id === cell.task_id);
    assert(task, 'Unknown benchmark task');
    return {
      ...cell,
      category: task.category,
      result,
      grade: gradeBenchmarkResult(spec, task, result),
    };
  });
  const metrics = (items: typeof observations, expected: number) => {
    const basis = [...new Set(items.map((item) => item.result.cost_basis))];
    const costKnown =
      items.length === expected &&
      basis.length === 1 &&
      basis[0] !== 'unknown' &&
      items.every((item) => item.result.usage.cost_usd !== null);
    const timeKnown =
      items.length === expected && items.every((item) => item.result.usage.wall_seconds !== null);
    const limitsKnown =
      items.length === expected &&
      items.every(
        (item) =>
          item.result.usage.wall_seconds !== null && item.result.usage.output_tokens !== null,
      );
    const meanScore = items.length
      ? items.reduce((total, item) => total + item.grade.score, 0) / items.length
      : null;
    return {
      expected,
      recorded: items.length,
      complete: items.length === expected,
      successful: items.filter((item) => item.grade.passed).length,
      failed: items.filter((item) => item.result.status !== 'completed').length,
      limit_exceeded: items.filter((item) => item.grade.limit_exceeded).length,
      mean_score: meanScore,
      success_rate:
        items.length === expected
          ? items.filter((item) => item.grade.passed).length / expected
          : null,
      cost_basis: basis.length === 1 ? basis[0] : basis.length ? 'mixed' : 'unknown',
      total_cost_usd: costKnown
        ? items.reduce((total, item) => total + Number(item.result.usage.cost_usd), 0)
        : null,
      mean_cost_usd: costKnown
        ? items.reduce((total, item) => total + Number(item.result.usage.cost_usd), 0) / expected
        : null,
      mean_wall_seconds: timeKnown
        ? items.reduce((total, item) => total + Number(item.result.usage.wall_seconds), 0) /
          expected
        : null,
      meets_observed_floor:
        items.length === expected &&
        limitsKnown &&
        items.every((item) => item.grade.required_passed) &&
        meanScore !== null &&
        meanScore >= spec.quality_floor,
    };
  };
  const candidates = spec.candidates.map((candidate) => {
    const items = observations.filter((item) => item.candidate_id === candidate.id);
    return {
      candidate,
      ...metrics(items, spec.tasks.length * spec.repeats),
      categories: [...new Set(spec.tasks.map((task) => task.category))].map((category) => ({
        category,
        ...metrics(
          items.filter((item) => item.category === category),
          spec.tasks.filter((task) => task.category === category).length * spec.repeats,
        ),
      })),
    };
  });
  const comparable = candidates.flatMap((item) => {
    const { mean_score, mean_cost_usd, mean_wall_seconds } = item;
    return item.meets_observed_floor &&
      mean_score !== null &&
      mean_cost_usd !== null &&
      mean_wall_seconds !== null
      ? [{ ...item, mean_score, mean_cost_usd, mean_wall_seconds }]
      : [];
  });
  const frontier = comparable
    .filter(
      (item) =>
        !comparable.some(
          (other) =>
            other !== item &&
            other.cost_basis === item.cost_basis &&
            other.mean_score >= item.mean_score &&
            other.mean_cost_usd <= item.mean_cost_usd &&
            other.mean_wall_seconds <= item.mean_wall_seconds &&
            (other.mean_score > item.mean_score ||
              other.mean_cost_usd < item.mean_cost_usd ||
              other.mean_wall_seconds < item.mean_wall_seconds),
        ),
    )
    .map((item) => ({ candidate_id: item.candidate.id, cost_basis: item.cost_basis }));
  return {
    benchmark_id: spec.benchmark_id,
    revision: spec.revision,
    source: spec.source,
    environment: spec.environment,
    quality_floor: spec.quality_floor,
    limits: spec.limits,
    benchmark_hash: benchmarkHash(spec),
    evidence_kind: spec.evidence_kind,
    expected_attempts: cells.length,
    recorded_attempts: results.length,
    complete: results.length === cells.length,
    candidates,
    observed_frontier: frontier,
    attempts: observations.map(({ result, ...observation }) => ({
      ...observation,
      status: result.status,
      cost_basis: result.cost_basis,
      usage: result.usage,
      evidence_reference: result.evidence_reference,
    })),
    boundary:
      'Local benchmark observations are advisory, not peer ratings, model authentication, statistical confidence, or production acceptance. Frontier comparisons use the same cost basis. Setup and grading costs are not measured in this slice.',
  };
}
