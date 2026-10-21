import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeWrites, planWork } from '../lib/planning.ts';
import type {
  BriefInput,
  DimensionObservation,
  Template,
  WorkerInput,
  WorkItemInput,
} from '../lib/types.ts';
import { applyEvent, createRun, nextActions } from '../lib/workflow.ts';

const software = JSON.parse(
  await readFile(new URL('../templates/software-delivery.json', import.meta.url), 'utf8'),
) as Template;
const product = JSON.parse(
  await readFile(new URL('../templates/product-design.json', import.meta.url), 'utf8'),
) as Template;

const work = (id: string, fields: Partial<WorkItemInput> = {}): WorkItemInput => ({
  id,
  objective: `Deliver ${id}`,
  task_type: 'implementation',
  difficulty: 'routine',
  skills: ['implementation'],
  depends_on: [],
  inputs: ['task_brief'],
  writes: [`src/${id}`],
  outputs: [`${id}_artifact`],
  acceptance: ['The specified behavior works.'],
  ...fields,
});

const dimensions: Record<string, DimensionObservation> = Object.fromEntries(
  ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((key) => [
    key,
    { score: 8, support: 'supported-peer-observations' },
  ]),
);

const worker = (id: string, cost: number, seconds: number): WorkerInput => ({
  id,
  model_id: `model-${id}`,
  route: 'local',
  effort: 'unknown',
  available: true,
  tools_verified: true,
  tools: [],
  profiles: [
    {
      model_id: `model-${id}`,
      route: 'local',
      effort: 'unknown',
      evaluation_kind: 'simulation',
      domain: 'software-engineering',
      task_type: 'implementation',
      difficulty: 'routine',
      skill: 'implementation',
      dimensions,
      observed_cost_usd: cost,
      observed_wall_seconds: seconds,
    },
  ],
});

const graphBrief = (items: WorkItemInput[], fields: Partial<BriefInput> = {}): BriefInput => ({
  run_id: 'refactor-fixture',
  objective: 'Deliver integrated behavior.',
  domain: 'software-engineering',
  evidence_kind: 'simulation',
  lead_context: 'host',
  acceptance: ['The integrated behavior works.'],
  constraints: [],
  ...fields,
  work_items: items,
});

const referenceBrief = (domain: string): BriefInput => ({
  run_id: 'reference-fixture',
  objective: 'Rehearse the reference workflow.',
  domain,
  difficulty: 'standard',
  independent_streams: 1,
  constraints: [],
  acceptance: ['The rehearsal completes.'],
  lead_context: 'host',
  evidence_kind: 'simulation',
  reference_workflow: true,
});

test('assignment write scopes follow the same normalization as planned work scopes', () => {
  assert.deepEqual(normalizeWrites(['src\\app\\', 'docs/']), ['src/app', 'docs']);
  for (const bad of [
    ['src/*.mjs'],
    ['../outside'],
    ['/abs'],
    ['C:/abs'],
    ['a//b'],
    ['same', 'same'],
  ]) {
    assert.throws(() => normalizeWrites(bad));
  }
  let run = createRun(software, referenceBrief('software-engineering'));
  const assign = (writes: string[]) =>
    applyEvent(run, {
      id: `assign-${writes.join('-')}`,
      expected_revision: run.revision,
      packet_id: 'scope',
      attempt: 1,
      type: 'assign',
      actor_context: 'host',
      assignment: {
        owner_context: 'worker',
        reviewer_context: 'reviewer',
        contributor_contexts: run.packets.scope.contributor_roles.map((role) => `c-${role}`),
        writes,
      },
    });
  assert.throws(() => assign(['src/*.mjs']), /exact workspace-relative/);
  assert.throws(() => assign(['src', 'src']), /unique/);
  run = assign(['docs\\notes\\']);
  assert.ok(run.packets.scope.assignment);
  assert.deepEqual(run.packets.scope.assignment.writes, ['docs/notes']);
});

test('reference templates declare their independent audits instead of controller constants', () => {
  const pairs = (template: Template) =>
    template.workflow.stages
      .filter((stage) => stage.audits)
      .map((stage) => [stage.id, stage.audits]);
  assert.deepEqual(pairs(software), [['verification', ['implementation']]]);
  assert.deepEqual(pairs(product), [['evaluation', ['prototype']]]);
  const run = createRun(software, referenceBrief('software-engineering'));
  assert.deepEqual(run.packets.verification.audit_sources, ['implementation']);
  assert.deepEqual(run.packets.implementation.audit_sources, []);
});

test('events copy only touched packets and never mutate the previous snapshot', () => {
  const items = [work('a'), work('b'), work('c', { depends_on: ['a', 'b'], writes: ['dist'] })];
  const before = createRun(null, graphBrief(items));
  const frozen = JSON.stringify(before);
  const after = applyEvent(before, {
    id: 'assign-a',
    expected_revision: 0,
    packet_id: 'work_a',
    attempt: 1,
    type: 'assign',
    actor_context: 'host',
    assignment: {
      owner_context: 'worker-a',
      reviewer_context: 'host',
      contributor_contexts: [],
      writes: ['src/a'],
    },
  });
  assert.equal(JSON.stringify(before), frozen);
  assert.notEqual(after.packets.work_a, before.packets.work_a);
  assert.equal(after.packets.work_b, before.packets.work_b);
  assert.equal(after.packets.handover, before.packets.handover);
  assert.equal(after.journal.length, 1);
  assert.equal(before.journal.length, 0);
  assert.deepEqual(
    nextActions(after).dispatchable.map((item) => item.id),
    ['work_a'],
  );
});

test('plan estimates are free of floating point noise', () => {
  const items = [work('a'), work('b'), work('c', { depends_on: ['a', 'b'], writes: ['dist'] })];
  const plan = planWork(
    graphBrief(items, {
      planning_limits: {
        max_parallel: 2,
        overhead_seconds: 1,
        overhead_cost_usd: 0.001,
        context_startup_seconds: 0,
        context_startup_cost_usd: 0,
      },
    }),
    [worker('x', 0.003, 10), worker('y', 0.003, 10)],
  );
  assert.equal(plan.status, 'planned');
  const values = [
    plan.estimated_cost_usd,
    plan.known_components_cost_usd,
    ...plan.assignments.map((item) => item.estimated_cost_usd),
  ];
  for (const value of values) {
    assert.ok(value !== null);
    assert.equal(value, Math.round(value * 1e9) / 1e9);
    assert.ok(String(value).length < 12, `${value} carries float noise`);
  }
  assert.equal(plan.estimated_cost_usd, 0.012);
});
