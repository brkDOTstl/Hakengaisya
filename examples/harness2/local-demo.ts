import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareDispatch } from '../../lib/dispatch.ts';
import type { Harness2Report } from '../../lib/learning.ts';
import { createHarness2Job, proposeImprovementSubmission } from '../../lib/learning.ts';
import type { WorkflowEvent } from '../../lib/types.ts';
import { applyEvent, createRun } from '../../lib/workflow.ts';

interface DemoRequest {
  request_id: string;
  request_fingerprint: string;
  actor_context: string;
  kind: string;
  payload: {
    harness: Record<string, string>;
    context: Record<string, string>;
    rollouts: { agg1: { outputs: { text: string }[] } };
  };
}
interface DemoReport extends Harness2Report {
  pending_requests: string[];
  response_directory: string;
  host_calls: number;
  learned: boolean;
}

const { values } = parseArgs({
  options: {
    upstream: { type: 'string' },
    output: { type: 'string', default: 'runs/harness2-local-demo' },
    python: { type: 'string', default: 'python' },
  },
});
const root = path.resolve(values.output);
await mkdir(root, { recursive: true });
const save = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const load = async <T = unknown>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, 'utf8'));
if (existsSync(path.join(root, 'summary.json'))) {
  console.log(JSON.stringify(await load(path.join(root, 'summary.json')), null, 2));
  process.exit(0);
}
const source = path.join(root, 'ledger.csv');
await writeFile(source, 'amount\n100.25\n-20.10\n5.00\n');
const sourceHash = createHash('sha256')
  .update(await readFile(source))
  .digest('hex');
let run = createRun(null, {
  run_id: 'harness2-local-fixture',
  objective: 'Sum every signed amount in the local ledger.',
  domain: 'software-engineering',
  lead_context: 'fixture-supervisor',
  evidence_kind: 'simulation',
  constraints: ['Deterministic host replies only; no model service or user-memory changes.'],
  acceptance: ['The signed total is 85.15.'],
  improvement: { enabled: true, scope: 'fixture-ledger' },
  external_inputs: { ledger: { reference: source, sha256: sourceHash } },
  work_items: [
    {
      id: 'ledger',
      objective: 'Calculate the ledger total and retain supported working guidance.',
      task_type: 'implementation',
      difficulty: 'routine',
      skills: ['implementation'],
      required_tools: [],
      depends_on: [],
      inputs: ['task_brief', 'ledger'],
      writes: ['delivery/total.txt'],
      outputs: ['ledger_total'],
      acceptance: ['All source amounts contribute to the total.'],
    },
  ],
});
let sequence = 0;
const event = async (type: WorkflowEvent['type'], fields: Record<string, unknown> = {}) => {
  run = applyEvent(run, {
    id: `demo-${++sequence}`,
    expected_revision: run.revision,
    packet_id: 'handover',
    attempt: 1,
    actor_context: 'fixture-supervisor',
    type,
    ...fields,
  } as WorkflowEvent);
  await save(path.join(root, 'run.json'), run);
};
await event('assign', {
  assignment: {
    owner_context: 'fixture-worker',
    reviewer_context: 'fixture-supervisor',
    contributor_contexts: [],
    writes: ['delivery/total.txt'],
    model_id: 'fixture-ledger-model',
    route: 'local-deterministic-fixture',
  },
});
const job = createHarness2Job(run, prepareDispatch(run, 'handover'), {
  'systemprompt.md': 'Sum positive amounts only.\n',
});
const jobPath = path.join(root, 'job.json');
await save(jobPath, job);
await event('start', { actor_context: 'fixture-worker' });
const bridge = fileURLToPath(
  new URL('../../packages/optimizer/harness2_bridge.py', import.meta.url),
);
let report: DemoReport | undefined;
for (let step = 0; step < 16; step++) {
  const args = [
    bridge,
    '--job',
    jobPath,
    '--state',
    path.join(root, '.hakengaisya-learning'),
    ...(values.upstream ? ['--upstream', path.resolve(values.upstream)] : []),
  ];
  const processResult = spawnSync(values.python, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (processResult.error) throw processResult.error;
  if (processResult.status !== 0)
    throw new Error(processResult.stdout || processResult.stderr || 'Harness2 bridge failed');
  report = JSON.parse(processResult.stdout) as DemoReport;
  if (report.status !== 'needs-host') break;
  for (const filename of report.pending_requests) {
    const request = await load<DemoRequest>(filename);
    const reply: Record<string, unknown> = {
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      actor_context: request.actor_context,
      status: 'completed',
      cost_usd: 0,
    };
    if (request.kind === 'execute') {
      if (
        createHash('sha256')
          .update(await readFile(source))
          .digest('hex') !== sourceHash
      )
        throw new Error('Source ledger changed during the fixture');
      const signed = request.payload.harness['systemprompt.md'].includes('all signed');
      const amounts = (await readFile(source, 'utf8'))
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .map((value) => Math.round(Number(value) * 100));
      if (amounts.some((value) => !Number.isSafeInteger(value)))
        throw new Error('Invalid ledger cents');
      const total =
        (signed ? amounts : amounts.filter((value) => value > 0)).reduce(
          (sum, value) => sum + value,
          0,
        ) / 100;
      const workspace = path.join(root, 'probe-workspaces', request.request_id);
      await mkdir(path.join(workspace, 'delivery'), { recursive: true });
      const output = path.join(workspace, 'delivery/total.txt');
      const text = `Total: ${total.toFixed(2)}\n`;
      await writeFile(output, text);
      Object.assign(reply, {
        model_id: 'fixture-ledger-model',
        outputs: [
          { id: 'ledger_total', reference: output, summary: 'Deterministic ledger output.', text },
        ],
        evidence: [{ reference: source, summary: `Frozen source ledger: ${sourceHash}` }],
        trajectory: `[ACTION] Read the frozen ledger and sum amounts\n[OBSERVATION] ${text}`,
      });
    } else if (request.kind === 'edit') {
      const harness = Object.fromEntries(
        Object.entries(request.payload.context)
          .filter(
            ([name]) =>
              Object.hasOwn(job.base_harness, name.replace(/^harness\//, '')) &&
              name.startsWith('harness/'),
          )
          .map(([name, text]) => [name.slice(8), text]),
      );
      harness['systemprompt.md'] = 'Sum all signed ledger amounts.\n';
      Object.assign(reply, {
        text: '<notes>Include negative credits as well as positive debits.</notes>',
        harness,
      });
    } else if (request.kind === 'adoption-review') {
      const text = request.payload.rollouts.agg1.outputs[0].text;
      Object.assign(reply, {
        decision: text === 'Total: 85.15\n' ? 'accepted' : 'rejected',
        reason:
          'The candidate matches independent signed-cent arithmetic; the baseline omits credits.',
        evidence: [{ reference: source, summary: '10025 - 2010 + 500 = 8515 cents.' }],
      });
    } else {
      reply.text =
        '<edits>Removed the positive-only restriction.</edits>\n<experience>\ncue: A ledger includes credits and debits\nlesson: Sum both signs rather than filtering positive values.\nevidence: The frozen ledger total changed from 105.25 to 85.15.\nconfidence: This deterministic local arithmetic example only\n</experience>';
    }
    await save(path.join(report.response_directory, path.basename(filename)), reply);
  }
}
if (report?.status !== 'ready-for-submission')
  throw new Error(`The fixture did not produce a reviewed improvement: ${report?.status}`);
await save(path.join(root, 'report.json'), report);
const proposed = proposeImprovementSubmission(run, job, report);
run = applyEvent(run, proposed.event);
await save(path.join(root, 'run.json'), run);
const chosen = await readFile(report.outputs[0].reference, 'utf8');
if (chosen !== 'Total: 85.15\n') throw new Error('Independent task acceptance failed');
await event('review', {
  decision: 'accepted',
  checks: [
    {
      index: 0,
      result: 'pass',
      evidence_reference: report.outputs[0].reference,
      note: 'Independently inspected the signed total.',
    },
  ],
  task_checks: [
    {
      index: 0,
      result: 'pass',
      evidence_reference: report.outputs[0].reference,
      note: 'Observed 85.15 as requested.',
    },
  ],
});
const summary = {
  evidence_kind: 'simulation',
  upstream: job.upstream,
  method: 'Real Harness2 core; deterministic local host replies; no model invocation.',
  host_calls: report.host_calls,
  retained_experience: report.learned,
  total: chosen.trim(),
  task_state: run.packets.handover.status,
  report: path.join(root, 'report.json'),
  run: path.join(root, 'run.json'),
};
await save(path.join(root, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
