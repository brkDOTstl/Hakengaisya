import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareDispatch } from '../lib/dispatch.ts';
import type { ScheduledPlan } from '../lib/planning.ts';
import { planWork } from '../lib/planning.ts';
import type { BriefInput, PlanningLimitsInput, WorkerInput, WorkItemInput } from '../lib/types.ts';
import { applyEvent, createRun, nextActions } from '../lib/workflow.ts';

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

const dimensions = Object.fromEntries(
  ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((key) => [
    key,
    { score: 8, support: 'supported-peer-observations' },
  ]),
);

// Proven only for routine implementation work; every other skill or difficulty is unproven.
const worker = (id: string, fields: Partial<WorkerInput> = {}): WorkerInput => ({
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
      observed_cost_usd: 0.004,
      observed_wall_seconds: 20,
    },
  ],
  ...fields,
});

const TRIAL: PlanningLimitsInput = {
  unproven_routes: 'trial',
  trial_estimate: { wall_seconds: 60, cost_usd: 0.02 },
};

function brief(items: WorkItemInput[], limits: PlanningLimitsInput = {}): BriefInput {
  return {
    run_id: 'trial-fixture',
    objective: 'Deliver integrated behavior.',
    domain: 'software-engineering',
    evidence_kind: 'simulation',
    lead_context: 'host',
    acceptance: ['The integrated behavior works.'],
    constraints: [],
    planning_limits: { max_parallel: 2, ...limits },
    work_items: items,
  };
}

// a is proven, tests is unproven (no testing observations), final integrates both.
const mixed = () => [
  work('a'),
  work('tests', { skills: ['testing'], writes: ['tests'] }),
  work('final', {
    depends_on: ['a', 'tests'],
    inputs: ['a_artifact', 'tests_artifact'],
    writes: ['dist'],
  }),
];

test('by default one unproven work item still makes the whole plan needs-evidence', () => {
  const plan = planWork(brief(mixed()), [worker('x'), worker('y')]);
  assert.equal(plan.status, 'needs-evidence');
  assert.deepEqual('unassigned' in plan ? plan.unassigned : null, ['tests']);
});

test('the trial policy requires an explicit host estimate and a known policy name', () => {
  assert.throws(
    () => planWork(brief(mixed(), { unproven_routes: 'trial' }), [worker('x')]),
    /explicit trial_estimate/,
  );
  assert.throws(
    () =>
      planWork(brief(mixed(), { ...TRIAL, trial_estimate: { wall_seconds: 0, cost_usd: 1 } }), [
        worker('x'),
      ]),
    /explicit trial_estimate/,
  );
  assert.throws(
    () => planWork(brief(mixed(), { unproven_routes: 'guess' }), [worker('x')]),
    /refuse or trial/,
  );
  assert.throws(
    () => planWork(brief(mixed(), { ...TRIAL, max_trial_assignments: 0 }), [worker('x')]),
    /max_trial_assignments/,
  );
});

test('trials fill only the evidence gap; proven work keeps its qualified route', () => {
  const plan = planWork(brief(mixed(), TRIAL), [worker('x'), worker('y')]);
  assert.equal(plan.status, 'planned');
  const scheduled = plan as ScheduledPlan;
  const byWork = Object.fromEntries(scheduled.assignments.map((item) => [item.work_id, item]));
  assert.equal(byWork.a.qualification, 'qualified');
  assert.equal(byWork.final.qualification, 'qualified');
  assert.equal(byWork.tests.qualification, 'trial');
  assert.equal(byWork.tests.estimated_cost_usd, 0.02);
  assert.deepEqual(scheduled.trials?.work_ids, ['tests']);
  assert.match(scheduled.estimate_basis, /trial_estimate/);
  const audit = scheduled.routing_audit?.work.find((item) => item.work_id === 'tests');
  const selected = audit?.candidates.find((candidate) => candidate.outcome === 'selected');
  assert.equal(selected?.reason, 'trial-route-selected-without-qualifying-evidence');
});

test('availability, tools, complex difficulty and the trial cap are never bypassed', () => {
  const unavailable = planWork(brief(mixed(), TRIAL), [
    worker('x'),
    worker('y', { available: false }),
  ]);
  const scheduled = unavailable as ScheduledPlan;
  assert.equal(scheduled.status, 'planned');
  assert.ok(scheduled.assignments.every((item) => item.worker_id === 'x'));

  const tooling = planWork(
    brief(
      [
        work('a'),
        work('tests', { skills: ['testing'], writes: ['tests'], required_tools: ['browser'] }),
        work('final', { depends_on: ['a', 'tests'], writes: ['dist'] }),
      ],
      TRIAL,
    ),
    [worker('x')],
  );
  assert.equal(tooling.status, 'needs-evidence');

  const complex = planWork(
    brief(
      [
        work('a'),
        work('hard', { difficulty: 'complex' }),
        work('final', { depends_on: ['a', 'hard'], writes: ['dist'] }),
      ],
      TRIAL,
    ),
    [worker('x')],
  );
  assert.equal(complex.status, 'needs-evidence');
  assert.deepEqual('unassigned' in complex ? complex.unassigned : null, ['hard']);

  const capped = planWork(
    brief(
      [
        work('one', { skills: ['testing'] }),
        work('two', { skills: ['testing'] }),
        work('final', { depends_on: ['one', 'two'], writes: ['dist'] }),
      ],
      { ...TRIAL, max_trial_assignments: 1 },
    ),
    [worker('x'), worker('y')],
  );
  assert.equal(capped.status, 'needs-evidence');
  assert.deepEqual('unassigned' in capped ? capped.unassigned : null, ['two']);
});

test('a trial assignment is visible from the run through next actions and the dispatch envelope', () => {
  let run = createRun(null, { ...brief(mixed(), TRIAL), workers: [worker('x'), worker('y')] });
  assert.equal(run.packets.work_tests.qualification, 'trial');
  assert.equal(run.packets.work_a.qualification, 'qualified');
  const plan = run.dispatch_plan as ScheduledPlan;
  const advice = plan.assignments.find((item) => item.work_id === 'tests');
  assert.ok(advice);
  const ready = nextActions(run).ready.find((item) => item.id === 'work_tests');
  assert.equal(ready?.qualification, 'trial');
  run = applyEvent(run, {
    id: 'assign-tests',
    expected_revision: 0,
    packet_id: 'work_tests',
    attempt: 1,
    type: 'assign',
    actor_context: 'host',
    assignment: {
      owner_context: `ctx-${advice.worker_id}`,
      reviewer_context: 'host',
      contributor_contexts: [],
      writes: ['tests'],
      worker_id: advice.worker_id,
      model_id: advice.model_id,
      route: advice.route,
      effort: advice.effort,
    },
  });
  const envelope = prepareDispatch(run, 'work_tests');
  assert.equal(envelope.route_qualification, 'trial');
  assert.equal(envelope.model_binding.model_id, advice.model_id);
});
