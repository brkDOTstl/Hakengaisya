import { openBenchmarkStore } from './benchmark-store.ts';
import { assert } from './contract.ts';

export const BENCHMARK_ACTIONS = ['create', 'next', 'claim', 'complete', 'report'] as const;
export type BenchmarkAction = (typeof BENCHMARK_ACTIONS)[number];

export async function benchmarkCommand(
  action: BenchmarkAction,
  filename: string,
  runId: string,
  request?: unknown,
) {
  assert(BENCHMARK_ACTIONS.includes(action), 'Unknown benchmark action');
  if (action === 'claim' || action === 'complete')
    assert(
      (request as { run_id?: string })?.run_id === runId,
      'Request run differs from the selected benchmark run',
    );
  const store = await openBenchmarkStore(
    filename,
    action === 'create' ? 'create' : ['next', 'report'].includes(action) ? 'read' : 'write',
  );
  try {
    switch (action) {
      case 'create':
        return store.create(runId, request);
      case 'next':
        return store.next(runId);
      case 'claim':
        return store.claim(request);
      case 'complete':
        return store.complete(request);
      case 'report':
        return store.report(runId);
    }
  } finally {
    store.close();
  }
}
