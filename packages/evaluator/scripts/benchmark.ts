import { readFile } from 'node:fs/promises';
import {
  BENCHMARK_ACTIONS,
  type BenchmarkAction,
  benchmarkCommand,
} from '../src/benchmark-commands.ts';

const [action, database, runId, requestFile, extra] = process.argv.slice(2);
try {
  if (
    !BENCHMARK_ACTIONS.includes(action as BenchmarkAction) ||
    !database ||
    !runId ||
    extra ||
    ['create', 'claim', 'complete'].includes(action) !== Boolean(requestFile)
  )
    throw new Error(
      'Usage: benchmark <create|next|claim|complete|report> <absolute-benchmark.sqlite> <run-id> [request.json]',
    );
  const request: unknown = requestFile
    ? JSON.parse(await readFile(requestFile, 'utf8'))
    : undefined;
  const result = await benchmarkCommand(action as BenchmarkAction, database, runId, request);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
