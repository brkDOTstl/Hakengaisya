import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPresets } from '../lib/commands.ts';
import { prepareDispatch } from '../lib/dispatch.ts';
import type { PresetRequest } from '../lib/presets.ts';
import {
  expandPreset,
  selectPreset,
  validatePreset,
  validatePresetRegistry,
} from '../lib/presets.ts';
import type { WorkerInput, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun, nextActions } from '../lib/workflow.ts';

const preset = (await loadPresets())[0];
const micro: PresetRequest = JSON.parse(
  await readFile(new URL('../examples/presets/micro.json', import.meta.url), 'utf8'),
);
const small: PresetRequest = JSON.parse(
  await readFile(new URL('../examples/presets/small-parallel.json', import.meta.url), 'utf8'),
);
function harness(input = micro) {
  const expanded = expandPreset(preset, input);
  let run = createRun(null, expanded.brief);
  let sequence = 0;
  const event = (
    packet_id: string,
    type: WorkflowEvent['type'],
    fields: Record<string, unknown> = {},
  ) => {
    run = applyEvent(run, {
      id: `preset-${++sequence}`,
      expected_revision: run.revision,
      packet_id,
      attempt: run.packets[packet_id].attempt,
      actor_context: input.lead_context,
      type,
      ...fields,
    } as WorkflowEvent);
  };
  const assign = (id: string, owner = 'fixture-worker-a') =>
    event(id, 'assign', {
      assignment: {
        owner_context: owner,
        reviewer_context: input.lead_context,
        contributor_contexts: [],
        writes: run.packets[id].declared_writes,
        fit_reason: 'The fixture route was reassessed for this bounded correction.',
      },
    });
  const start = (id: string) =>
    event(id, 'start', { actor_context: run.packets[id].assignment?.owner_context });
  const submit = (id: string) =>
    event(id, 'submit', {
      actor_context: run.packets[id].assignment?.owner_context,
      outputs: run.packets[id].required_outputs.map((output) => ({
        id: output,
        reference: `fixture:${output}`,
        summary: 'Synthetic output contract.',
      })),
      evidence: [
        {
          reference: 'fixture:checks',
          summary: 'Synthetic controller evidence; no live model claim.',
        },
      ],
    });
  const review = (id: string, decision = 'accepted') =>
    event(id, 'review', {
      decision,
      checks: run.packets[id].checks.map((_check, index) => ({
        index,
        result: decision === 'accepted' ? 'pass' : index === 0 ? 'fail' : 'pass',
        evidence_reference: 'fixture:review',
        note: 'Synthetic observed gate decision.',
      })),
      task_checks:
        id === 'handover'
          ? run.acceptance.map((_check, index) => ({
              index,
              result: 'pass',
              evidence_reference: 'fixture:task',
              note: 'Synthetic user acceptance.',
            }))
          : [],
    });
  const finish = (id: string, owner?: string) => {
    assign(id, owner);
    start(id);
    submit(id);
    review(id);
  };
  return {
    expanded,
    get run() {
      return run;
    },
    event,
    assign,
    start,
    submit,
    review,
    finish,
  };
}

test('registry and preset contract require researched applicability, scale and correction coverage', () => {
  assert.deepEqual(validatePresetRegistry({ schema_version: 1, presets: ['bounded-software'] }), [
    'bounded-software',
  ]);
  for (const invalid of [
    null,
    { schema_version: 1, presets: ['../escape'] },
    { schema_version: 1, presets: ['a', 'a'] },
  ])
    assert.throws(() => validatePresetRegistry(invalid));
  assert.equal(validatePreset(preset).variants.length, 2);
  for (const invalid of [
    { ...preset, sources: [] },
    { ...preset, sources: [{ ...preset.sources[0], reviewed_on: '2026-02-31' }] },
    { ...preset, organization: { ...preset.organization, acceptance: 'peer' } },
    { ...preset, variants: [{ ...preset.variants[0], max_workers: 5 }] },
    { ...preset, exceptions: preset.exceptions.filter((item) => item.id !== 'interrupted') },
    { ...preset, stages: preset.stages.filter((item) => item.id !== 'integration') },
    { ...preset, scale_coverage: { ...preset.scale_coverage, large: {} } },
    { ...preset, verification: { ...preset.verification, real_task_validated: true } },
  ])
    assert.throws(() => validatePreset(invalid));
});

test('micro work expands to one actual packet with existing-supervisor acceptance and version provenance', () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.run.packets), ['handover']);
  assert.equal(h.run.planning_limits?.max_workers, 1);
  assert.equal(h.run.limits.max_parallel, 1);
  assert.equal(h.expanded.staffing.additional_managers, 0);
  assert.equal(h.expanded.dispatch_readiness, 'requires-host-qualification');
  assert.equal(h.run.preset?.variant, 'micro');
  assert.match(h.run.preset?.contract_hash ?? '', /^[a-f0-9]{64}$/);
  h.assign('handover');
  assert.equal(prepareDispatch(h.run, 'handover').preset?.id, preset.id);
  h.start('handover');
  h.submit('handover');
  assert.equal(nextActions(h.run).complete, false);
  h.review('handover');
  assert.equal(nextActions(h.run).complete, true);
  assert.equal(h.run.dispatches, 1);
  assert.equal(h.run.supervision?.reporting_lines.length, 1);
});

test('small work permits two independent owners, then reuses one for integrated delivery', () => {
  const h = harness(small);
  assert.deepEqual(h.run.packets.handover.depends_on, ['work_reader', 'work_command']);
  assert.ok(
    h.run.packets.handover.inputs.includes('reader_delivery') &&
      h.run.packets.handover.inputs.includes('command_delivery'),
  );
  h.assign('work_reader', 'reader');
  h.assign('work_command', 'command');
  assert.throws(() => h.assign('handover', 'extra-integrator'), /execution pool/);
  h.assign('handover', 'reader');
  assert.throws(() => h.start('handover'), /dependency-ready/);
  h.start('work_reader');
  h.start('work_command');
  h.submit('work_reader');
  h.review('work_reader');
  h.submit('work_command');
  h.review('work_command');
  h.start('handover');
  h.submit('handover');
  h.review('handover');
  assert.equal(nextActions(h.run).complete, true);
  assert.equal(h.run.dispatches, 3);
  assert.equal(
    new Set(Object.values(h.run.packets).map((packet) => packet.assignment?.owner_context)).size,
    2,
  );
});

test('selection refuses unbounded, elevated, coupled or unjustified parallel work without inventing a department', () => {
  const coupled = structuredClone(small);
  coupled.components[1].writes = ['SRC/reader.ts'];
  const dependent = structuredClone(small);
  dependent.components[1].inputs = ['reader_delivery'];
  for (const input of [
    { ...micro, family: 'indie-game' },
    { ...micro, risk: 'elevated' },
    { ...micro, execution_topology: 'same-host-federation' },
    { ...small, integration: undefined },
    { ...small, parallel_reason: undefined },
    { ...small, components: [...small.components, { ...small.components[0], id: 'third' }] },
    coupled,
    dependent,
  ]) {
    const selection = selectPreset([preset], input);
    assert.equal(selection.status, 'no-match');
    assert.throws(() => expandPreset(preset, input), /does not apply/);
  }
});

test('rejected work invalidates integration and a reassessed replacement stays inside the current pool', () => {
  const h = harness();
  h.assign('handover', 'first');
  h.start('handover');
  h.submit('handover');
  h.review('handover', 'rejected');
  assert.equal(h.run.packets.handover.history[0].status, 'in_review');
  assert.throws(() => h.start('handover'), /renewed assignment/);
  h.assign('handover', 'replacement');
  h.start('handover');
  h.submit('handover');
  h.review('handover');
  assert.equal(nextActions(h.run).complete, true);
  assert.equal(h.run.packets.handover.history[0].assignment?.owner_context, 'first');
  const parallel = harness(small);
  parallel.finish('work_reader', 'reader');
  parallel.finish('work_command', 'command');
  parallel.finish('handover', 'reader');
  parallel.event('work_reader', 'reopen', {
    reason: 'The component input changed within its contract.',
  });
  assert.equal(parallel.run.packets.handover.status, 'pending');
  assert.equal(parallel.run.artifacts.integrated_delivery, undefined);
  assert.equal(parallel.run.packets.work_command.status, 'accepted');
});

test('interruption preserves occupancy until supervisor resolution and retry ceilings stop more work', () => {
  const h = harness();
  h.assign('handover');
  h.start('handover');
  h.event('handover', 'block', {
    actor_context: 'fixture-worker-a',
    reason: 'Execution state is uncertain; inspect the host before another launch.',
  });
  assert.equal(h.run.packets.handover.status, 'blocked');
  assert.throws(() => h.start('handover'), /dependency-ready/);
  assert.throws(
    () => h.event('handover', 'resume', { actor_context: 'unrelated', reason: 'Guess.' }),
    /supervision/,
  );
  h.event('handover', 'resume', {
    reason: 'The original fixture execution is identified and can continue.',
  });
  h.submit('handover');
  h.review('handover', 'rejected');
  h.assign('handover');
  h.start('handover');
  h.submit('handover');
  h.review('handover', 'rejected');
  h.assign('handover');
  assert.throws(() => h.start('handover'), /limit/);
  assert.equal(nextActions(h.run).complete, false);
});

test('an integration defect returns to its producing component before integration can resume', () => {
  const h = harness(small);
  h.finish('work_reader', 'reader');
  h.finish('work_command', 'command');
  h.assign('handover', 'reader');
  h.start('handover');
  h.submit('handover');
  h.review('handover', 'rejected');
  h.event('work_reader', 'reopen', {
    reason: 'Integration evidence locates the defect in the reader component.',
  });
  h.assign('handover', 'reader');
  assert.throws(() => h.start('handover'), /dependency-ready/);
  h.finish('work_reader', 'reader');
  h.start('handover');
  h.submit('handover');
  h.review('handover');
  assert.equal(nextActions(h.run).complete, true);
  assert.equal(h.run.dispatches, 5);
  assert.equal(h.run.packets.work_command.attempt, 1);
  assert.equal(h.run.packets.handover.history[0].review?.decision, 'rejected');
});

test('unknown hard budgets and missing capability do not become executable preset assignments', () => {
  const limited = harness({ ...micro, planning_limits: { budget_usd: 0.1 } });
  assert.equal(limited.expanded.dispatch_readiness, 'needs-evidence');
  assert.throws(() => limited.assign('handover'), /route and overhead evidence/);
  const worker: WorkerInput = {
    id: 'fixture',
    model_id: 'fixture',
    route: 'fixture',
    available: true,
    tools_verified: true,
    tools: [],
    profiles: [],
  };
  const unavailable = harness({ ...micro, workers: [worker] });
  assert.equal(unavailable.expanded.dispatch_plan?.status, 'needs-evidence');
  assert.ok(
    unavailable.expanded.dispatch_plan?.exclusions?.some(
      (item) => item.reason === 'required-tool-unavailable',
    ),
  );
  assert.throws(() => unavailable.assign('handover'), /route plan/);
});

test('qualified route estimates can choose a smaller adequate pool and respect a supplied budget', () => {
  const units = [...small.components, small.integration].filter((item) => item !== undefined);
  const route = (id: string, cost: number): WorkerInput => ({
    id,
    model_id: `fixture-${id}`,
    route: 'fixture-route',
    effort: 'unknown',
    available: true,
    tools_verified: true,
    tools: ['node-runtime'],
    profiles: units.flatMap((item) =>
      item.skills.map((skill) => ({
        model_id: `fixture-${id}`,
        route: 'fixture-route',
        effort: 'unknown',
        evaluation_kind: 'simulation',
        domain: 'software-engineering',
        task_type: item.task_type,
        difficulty: item.difficulty,
        skill,
        dimensions: Object.fromEntries(
          ['D1', 'D2', 'D6'].map((key) => [
            key,
            { score: 8, support: 'supported-peer-observations' },
          ]),
        ),
        observed_cost_usd: cost,
        observed_wall_seconds: 10,
      })),
    ),
  });
  const result = expandPreset(preset, {
    ...small,
    workers: [route('adequate', 0.01), route('expensive', 1)],
    planning_limits: {
      budget_usd: 0.1,
      overhead_seconds: 1,
      overhead_cost_usd: 0,
      context_startup_seconds: 1,
      context_startup_cost_usd: 0.005,
    },
  });
  assert.equal(result.dispatch_plan?.status, 'planned');
  assert.equal(result.staffing.planned_execution_contexts, 1);
  assert.ok(result.dispatch_plan?.assignments.every((item) => item.worker_id === 'adequate'));
  assert.equal(createRun(null, result.brief).limits.max_parallel, 1);
});

test('invalid estimates, caller authority injection, artifact collisions and expanded scope are rejected', () => {
  assert.throws(
    () => expandPreset(preset, { ...micro, planning_limits: { budget_usd: -1 } }),
    /estimate/,
  );
  assert.throws(
    () =>
      expandPreset(preset, {
        ...micro,
        components: [{ ...micro.components[0], supervisor_context: 'peer' }],
      }),
    /Unknown preset field/,
  );
  assert.throws(
    () =>
      expandPreset(preset, {
        ...micro,
        components: [{ ...micro.components[0], outputs: ['task_brief'] }],
      }),
    /external input/,
  );
  assert.throws(
    () =>
      expandPreset(preset, {
        ...micro,
        components: [{ ...micro.components[0], writes: ['../outside'] }],
      }),
    /relative/,
  );
  const h = harness();
  assert.throws(
    () =>
      h.event('handover', 'assign', {
        assignment: {
          owner_context: 'same',
          reviewer_context: 'same',
          contributor_contexts: [],
          writes: micro.components[0].writes,
        },
      }),
    /differ/,
  );
});

test('a tighter caller pool serializes the small variant without losing its integration gate', () => {
  const h = harness({ ...small, planning_limits: { max_workers: 1 } });
  assert.equal(h.run.limits.max_parallel, 1);
  h.assign('work_reader', 'owner');
  assert.throws(() => h.assign('work_command', 'another'), /execution pool/);
  h.finish('work_reader', 'owner');
  h.finish('work_command', 'owner');
  h.finish('handover', 'owner');
  assert.equal(h.run.dispatches, 3);
  assert.equal(nextActions(h.run).complete, true);
});

test('edited expanded briefs cannot keep a preset label while inflating staff or bypassing its graph', () => {
  const expanded = expandPreset(preset, micro);
  assert.throws(
    () =>
      createRun(null, {
        ...expanded.brief,
        planning_limits: { max_workers: 5 },
        limits: { max_attempts: 9 },
      }),
    /preset limits/,
  );
  assert.throws(
    () =>
      createRun(null, {
        ...expanded.brief,
        reporting_lines: [
          { subordinate_context: 'manager', supervisor_context: micro.lead_context },
        ],
        work_items: expanded.brief.work_items?.map((item) => ({
          ...item,
          supervisor_context: 'manager',
        })),
      }),
    /root supervisor|supervisor layers/,
  );
  const parallel = expandPreset(preset, small);
  const mixed = { ...parallel.brief, preset: expanded.brief.preset };
  assert.throws(() => createRun(null, mixed), /preset limits|one delivery/);
});

test('packaged registry and expansion work outside the repository and preserve a persisted run binding', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hakengaisya-preset-'));
  const helper = fileURLToPath(
    new URL('../plugins/hakengaisya/runtime/scripts/workflow.ts', import.meta.url),
  );
  const requestFile = path.join(workspace, 'request.json');
  await writeFile(requestFile, JSON.stringify(micro));
  const call = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [helper, ...args], { cwd: workspace, encoding: 'utf8' }),
    );
  assert.equal(call('presets')[0].id, 'bounded-software');
  assert.equal(call('preset-select', requestFile).variant, 'micro');
  const result = call('preset-expand', 'bounded-software', requestFile);
  const briefFile = path.join(workspace, 'brief.json');
  await writeFile(briefFile, JSON.stringify(result.brief));
  const created = call('create', path.join(workspace, 'run.json'), briefFile);
  assert.equal(created.preset.contract_hash, result.brief.preset.contract_hash);
  assert.equal(created.ready.length, 1);
});
