import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ScheduledPlan } from '../lib/planning.ts';
import { planWork, validateWorkGraph } from '../lib/planning.ts';
import type {
  AssignEvent,
  BriefInput,
  EventType,
  ReasonEvent,
  ReviewEvent,
  RouteProfile,
  SubmitEvent,
  WorkerInput,
  WorkflowEvent,
  WorkItemInput,
} from '../lib/types.ts';
import { applyEvent, chooseStructure, createRun } from '../lib/workflow.ts';

type EventFields = Partial<
  Omit<AssignEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'> &
    Omit<SubmitEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'> &
    Omit<ReviewEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'> &
    Omit<ReasonEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'>
>;
type WorkerOptions = Partial<WorkerInput> &
  Partial<Pick<RouteProfile, 'difficulty' | 'task_type' | 'skill'>> & { ability?: number };

interface StaffingComparison {
  selected_pool_cap: number;
  estimates_complete: boolean;
  alternatives: unknown[];
}

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
const brief = (items: WorkItemInput[], fields: Partial<BriefInput> = {}): BriefInput => ({
  run_id: 'synthetic-planning',
  objective: 'Synthetic cost and parallelism planning, not a live bill.',
  domain: 'software-engineering',
  evidence_kind: 'simulation',
  lead_context: 'host',
  acceptance: ['Integrated behavior meets the requested result.'],
  constraints: [],
  work_items: items,
  ...fields,
  planning_limits: {
    overhead_seconds: 0,
    overhead_cost_usd: 0,
    context_startup_seconds: 0,
    context_startup_cost_usd: 0,
    ...fields.planning_limits,
  },
});
function worker(
  id: string,
  cost: number,
  seconds: number,
  options: WorkerOptions = {},
): WorkerInput {
  const {
    difficulty = 'routine',
    ability = 8,
    task_type = 'implementation',
    skill = 'implementation',
  } = options;
  return {
    id,
    model_id: `fixture-${id}`,
    route: 'fixture-route',
    available: true,
    tools_verified: true,
    tools: [],
    profiles: [
      {
        model_id: `fixture-${id}`,
        route: 'fixture-route',
        effort: 'unknown',
        evaluation_kind: 'simulation',
        domain: 'software-engineering',
        task_type,
        difficulty,
        skill,
        observed_cost_usd: cost,
        observed_wall_seconds: seconds,
        dimensions: Object.fromEntries(
          ['D1', 'D2', 'D6'].map((key) => [
            key,
            { score: ability, support: 'supported-peer-observations' },
          ]),
        ),
      },
    ],
    ...options,
  };
}
const parallelBrief = () =>
  brief([
    work('core'),
    work('ui'),
    work('integrated', {
      depends_on: ['core', 'ui'],
      inputs: ['core_artifact', 'ui_artifact'],
      writes: ['dist'],
    }),
  ]);

test('one small deliverable creates one runtime packet without administrative stages', () => {
  const b = brief([work('timer')]);
  const run = createRun(null, b);
  assert.deepEqual(Object.keys(run.packets), ['handover']);
  assert.equal(run.organization.separate_management_agent_required, false);
  assert.equal(run.packets.handover.source_work_id, 'timer');
  assert.equal(run.limits.max_attempts, 1);
  assert.throws(
    () => createRun(null, { ...b, work_items: undefined, difficulty: 'standard' }),
    /work_items/,
  );
});

test('organization concurrency follows dependency and write boundaries, not difficulty or title count', () => {
  assert.equal(chooseStructure(parallelBrief()).max_parallel, 2);
  assert.equal(chooseStructure(brief([work('one', { difficulty: 'complex' })])).max_parallel, 1);
  const b = parallelBrief();
  assert.ok(b.work_items);
  b.work_items[1].writes = ['SRC/core/child'];
  assert.equal(chooseStructure(b).max_parallel, 1);
});

test('cheap adequate route wins routine work over an unnecessary expensive model', () => {
  const plan = planWork(brief([work('timer')]), [
    worker('cheap', 0.01, 30),
    worker('frontier', 1, 20),
  ]);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.assignments[0].worker_id, 'cheap');
  assert.equal(plan.estimated_cost_usd, 0.01);
  assert.equal(plan.organization.length, 1);
});

test('difficult work requires contextual supported ability and does not reuse routine success', () => {
  const plan = planWork(brief([work('hard', { difficulty: 'complex' })]), [
    worker('cheap', 0.01, 20),
    worker('expert', 0.2, 50, { difficulty: 'complex' }),
  ]);
  assert.ok('estimated_makespan_seconds' in plan);
  assert.equal(plan.assignments[0].worker_id, 'expert');
  assert.ok(
    plan.exclusions.some(
      (item) => item.worker_id === 'cheap' && item.reason === 'ability-or-context-unproven',
    ),
  );
});

test('independent work overlaps and integrated work waits for all inputs', () => {
  const plan = planWork(parallelBrief(), [worker('A', 0.01, 30), worker('B', 0.01, 30)]);
  assert.ok('estimated_makespan_seconds' in plan);
  assert.equal(plan.estimated_makespan_seconds, 60);
  assert.equal(plan.serial_estimate_seconds, 90);
  assert.equal(plan.assignments.find((item) => item.work_id === 'core')?.start_seconds, 0);
  assert.equal(plan.assignments.find((item) => item.work_id === 'ui')?.start_seconds, 0);
  assert.equal(plan.assignments.find((item) => item.work_id === 'integrated')?.start_seconds, 30);
});

test('overlapping writes, aliased actual contexts and a concurrency cap serialize work', () => {
  const b = parallelBrief();
  assert.ok(b.work_items);
  b.work_items[1].writes = ['SRC/core/child'];
  assert.equal(
    (planWork(b, [worker('A', 0.01, 30), worker('B', 0.01, 30)]) as ScheduledPlan)
      .estimated_makespan_seconds,
    90,
  );
  assert.equal(
    (
      planWork(parallelBrief(), [
        worker('A', 0.01, 30, { context_id: 'same' }),
        worker('B', 0.01, 30, { context_id: 'same' }),
      ]) as ScheduledPlan
    ).estimated_makespan_seconds,
    90,
  );
  assert.equal(
    (
      planWork(
        {
          ...parallelBrief(),
          planning_limits: { ...parallelBrief().planning_limits, max_parallel: 1 },
        },
        [worker('A', 0.01, 30), worker('B', 0.01, 30)],
      ) as ScheduledPlan
    ).estimated_makespan_seconds,
    90,
  );
});

test('a bounded extra parallelism cost may save time without choosing a frontier model', () => {
  const plan = planWork(parallelBrief(), [
    worker('A', 0.01, 30),
    worker('B', 0.0105, 30),
    worker('frontier', 1, 10),
  ]);
  assert.ok('estimated_makespan_seconds' in plan);
  assert.equal(plan.estimated_makespan_seconds, 60);
  assert.ok(!plan.assignments.some((item) => item.worker_id === 'frontier'));
});

test('an estimated deadline permits escalation only when cheap adequate work misses it', () => {
  const b = brief([work('timer')], { planning_limits: { deadline_seconds: 25, budget_usd: 1 } });
  const plan = planWork(b, [worker('cheap', 0.01, 30), worker('fast', 0.2, 20)]);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.assignments[0].worker_id, 'fast');
  const missed = planWork(
    { ...b, planning_limits: { ...b.planning_limits, deadline_seconds: 10 } },
    [worker('cheap', 0.01, 30)],
  );
  assert.equal(missed.status, 'constraints-unmet');
  assert.equal(missed.reason, 'estimated-deadline');
});

test('remaining cost reserve respects the estimated whole-task budget', () => {
  const plan = planWork(
    {
      ...parallelBrief(),
      planning_limits: { ...parallelBrief().planning_limits, budget_usd: 0.03 },
    },
    [worker('A', 0.01, 30), worker('B', 0.0105, 20)],
  );
  assert.equal(plan.status, 'planned');
  assert.ok(plan.estimated_cost_usd !== null);
  assert.ok(plan.estimated_cost_usd <= 0.03 + 1e-9);
  assert.equal(
    planWork(brief([work('timer')], { planning_limits: { budget_usd: 0.005 } }), [
      worker('A', 0.01, 30),
    ]).status,
    'constraints-unmet',
  );
});

test('unknown cost, ability, effort or tool route never becomes free eligible work', () => {
  const b = brief([work('ui', { required_tools: ['browser'] })]);
  assert.equal(planWork(b, [worker('A', 0.01, 30)]).status, 'needs-evidence');
  assert.equal(
    planWork(brief([work('timer')]), [worker('A', null as never, 30)]).status,
    'needs-evidence',
  );
  assert.equal(
    planWork(brief([work('timer')]), [worker('A', 0.01, 30, { ability: 5 })]).status,
    'needs-evidence',
  );
  assert.equal(
    planWork(brief([work('timer')]), [worker('A', 0.01, 30, { effort: 'high' })]).status,
    'needs-evidence',
  );
  assert.equal(
    planWork(brief([work('timer')], { evidence_kind: 'local_work' }), [worker('A', 0.01, 30)])
      .status,
    'needs-evidence',
  );
});

test('confirmed model failure avoids blind retries while an environment stop does not lower ability', () => {
  const b = brief([work('timer')], {
    failures: [{ work_id: 'timer', worker_id: 'cheap', confirmed: true, attribution: 'model' }],
  });
  assert.equal(
    planWork(b, [worker('cheap', 0.01, 30), worker('expert', 0.2, 40)]).assignments[0].worker_id,
    'expert',
  );
  assert.ok(b.failures);
  b.failures[0].attribution = 'environment';
  assert.equal(planWork(b, [worker('cheap', 0.01, 30)]).assignments[0].worker_id, 'cheap');
});

test('a reviewer route cannot audit its own producer context even under an alias', () => {
  const b = brief([
    work('build'),
    work('audit', {
      task_type: 'code-review',
      skills: ['code-review'],
      depends_on: ['build'],
      inputs: ['build_artifact'],
      writes: [],
      audit_sources: ['build'],
    }),
  ]);
  const producer = worker('build-model', 0.01, 30, { context_id: 'same' });
  const alias = worker('review-alias', 0.01, 5, {
    context_id: 'same',
    task_type: 'code-review',
    skill: 'code-review',
  });
  const independent = worker('independent', 0.02, 10, {
    task_type: 'code-review',
    skill: 'code-review',
  });
  assert.equal(planWork(b, [producer, alias]).status, 'constraints-unmet');
  assert.equal(
    planWork(b, [producer, alias, independent]).assignments.find((item) => item.work_id === 'audit')
      ?.worker_id,
    'independent',
  );
});

test('the execution pool limits total contexts, including a later independent reviewer', () => {
  const b = brief(
    [
      work('build'),
      work('audit', {
        task_type: 'code-review',
        skills: ['code-review'],
        depends_on: ['build'],
        inputs: ['build_artifact'],
        writes: [],
        audit_sources: ['build'],
      }),
    ],
    { planning_limits: { max_workers: 1 } },
  );
  const plan = planWork(b, [
    worker('A', 0.01, 30),
    worker('reviewer', 0.02, 10, { task_type: 'code-review', skill: 'code-review' }),
  ]);
  assert.equal(plan.status, 'constraints-unmet');
  assert.equal(plan.reason, 'independence-pool-or-budget');
});

test('handoff overhead is counted and warns about decomposition smaller than its overhead', () => {
  const plan = planWork(
    brief([work('tiny')], { planning_limits: { overhead_seconds: 20, overhead_cost_usd: 0.02 } }),
    [worker('A', 0.01, 10)],
  );
  assert.ok('estimated_makespan_seconds' in plan);
  assert.equal(plan.estimated_makespan_seconds, 30);
  assert.equal(plan.estimated_cost_usd, 0.03);
  assert.equal(plan.decomposition_warnings.length, 1);
});

test('missing overhead is unknown and cannot prove a total budget or deadline', () => {
  const b = brief([work('timer')]);
  delete b.planning_limits;
  const unpriced = planWork(b, [worker('A', 0.01, 30)]);
  assert.ok('estimated_makespan_seconds' in unpriced);
  assert.equal(unpriced.estimated_cost_usd, null);
  assert.equal(unpriced.estimated_makespan_seconds, null);
  b.planning_limits = { budget_usd: 1 };
  assert.equal(planWork(b, [worker('A', 0.01, 30)]).status, 'needs-evidence');
});

test('context startup is charged once per actual context, including aliased routes', () => {
  const b = parallelBrief();
  assert.ok(b.planning_limits);
  b.planning_limits.context_startup_seconds = 7;
  b.planning_limits.context_startup_cost_usd = 0.05;
  const plan = planWork(b, [
    worker('A', 0.01, 30, { context_id: 'same' }),
    worker('alias', 0.01, 30, { context_id: 'same' }),
  ]);
  assert.ok('estimated_makespan_seconds' in plan);
  assert.equal(plan.organization.length, 1);
  assert.equal(plan.estimated_makespan_seconds, 97);
  assert.ok(plan.estimated_cost_usd !== null);
  assert.ok(Math.abs(plan.estimated_cost_usd - 0.08) < 1e-9);
  assert.deepEqual(
    plan.assignments.map((item) => item.context_startup_seconds),
    [7, 0, 0],
  );
});

test('extra context cost can keep independent work in one reused worker', () => {
  const b = parallelBrief();
  assert.ok(b.planning_limits);
  b.planning_limits.context_startup_cost_usd = 0.1;
  const plan = planWork(b, [worker('A', 0.01, 30), worker('B', 0.01, 30)]);
  assert.ok('estimated_makespan_seconds' in plan);
  assert.equal(plan.organization.length, 1);
  assert.equal(plan.peak_parallel, 1);
  assert.equal((plan.staffing_comparison as StaffingComparison).selected_pool_cap, 1);
  assert.equal((plan.staffing_comparison as StaffingComparison).estimates_complete, true);
  const run = createRun(null, { ...b, workers: [worker('A', 0.01, 30), worker('B', 0.01, 30)] });
  assert.equal(run.mode, 'compact');
  assert.equal(run.limits.max_parallel, 1);
});

test('tiny theoretical parallel gain does not justify another context below the configured threshold', () => {
  const b = parallelBrief();
  assert.ok(b.planning_limits);
  b.planning_limits.minimum_parallel_savings_seconds = 2;
  const tiny = planWork(b, [worker('A', 0.01, 1), worker('B', 0.01, 1)]);
  assert.ok('estimated_makespan_seconds' in tiny);
  assert.equal(tiny.organization.length, 1);
  assert.equal(tiny.estimated_makespan_seconds, 3);
  const substantial = planWork(b, [worker('A', 0.01, 30), worker('B', 0.01, 30)]);
  assert.ok('estimated_makespan_seconds' in substantial);
  assert.equal(substantial.organization.length, 2);
  assert.equal(substantial.estimated_makespan_seconds, 60);
  assert.equal((substantial.staffing_comparison as StaffingComparison).alternatives.length, 2);
});

test('a feasible deadline may justify another startup but never exceed the total estimated budget', () => {
  const b = parallelBrief();
  b.planning_limits = {
    ...b.planning_limits,
    context_startup_cost_usd: 0.01,
    budget_usd: 0.05,
    deadline_seconds: 65,
  };
  const routes = [worker('A', 0.01, 30), worker('B', 0.01, 30)];
  const plan = planWork(b, routes);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.organization.length, 2);
  assert.ok(plan.estimated_cost_usd !== null);
  assert.ok(plan.estimated_cost_usd <= 0.05 + 1e-9);
  assert.ok(b.planning_limits);
  b.planning_limits.budget_usd = 0.049;
  assert.equal(planWork(b, routes).status, 'constraints-unmet');
});

test('missing startup estimates remain unknown despite known per-unit overhead', () => {
  const b = parallelBrief();
  assert.ok(b.planning_limits);
  delete b.planning_limits.context_startup_cost_usd;
  delete b.planning_limits.context_startup_seconds;
  const routes = [worker('A', 0.01, 30), worker('B', 0.01, 30)];
  const plan = planWork(b, routes);
  assert.ok('estimated_makespan_seconds' in plan);
  assert.equal(plan.estimated_cost_usd, null);
  assert.equal(plan.estimated_makespan_seconds, null);
  assert.equal((plan.staffing_comparison as StaffingComparison).estimates_complete, false);
  assert.ok(b.planning_limits);
  b.planning_limits.budget_usd = 1;
  assert.equal(planWork(b, routes).status, 'needs-evidence');
});

test('graph rejects fake decomposition with cycles, unavailable inputs and disconnected outputs', () => {
  assert.throws(
    () =>
      validateWorkGraph(
        brief([work('a', { depends_on: ['b'] }), work('b', { depends_on: ['a'] })]),
      ),
    /Cyclic/,
  );
  assert.throws(() => validateWorkGraph(brief([work('a'), work('b')])), /integrated terminal/);
  assert.throws(
    () => validateWorkGraph(brief([work('a', { inputs: ['nonexistent'] })])),
    /Input artifact/,
  );
  assert.throws(
    () => validateWorkGraph(brief([work('a', { dimensions: [] })])),
    /required dimensions/,
  );
});

test('runtime requires actual planned model declaration and renewed assignment after rejection', () => {
  const b = brief([work('timer')], { workers: [worker('A', 0.01, 30)] });
  let run = createRun(null, b);
  let id = 0;
  const apply = (type: EventType, fields: EventFields = {}) => {
    run = applyEvent(run, {
      id: `event-${++id}`,
      expected_revision: run.revision,
      packet_id: 'handover',
      attempt: run.packets.handover.attempt,
      actor_context: 'host',
      type,
      ...fields,
    } as WorkflowEvent);
  };
  const assignment = {
    owner_context: 'A-context',
    reviewer_context: 'host',
    contributor_contexts: [],
    writes: ['src/timer'],
  };
  assert.throws(() => apply('assign', { assignment }), /selected model/);
  apply('assign', {
    assignment: {
      ...assignment,
      worker_id: 'A',
      model_id: 'fixture-A',
      route: 'fixture-route',
      effort: 'unknown',
    },
  });
  apply('start', { actor_context: 'A-context' });
  apply('submit', {
    actor_context: 'A-context',
    outputs: [{ id: 'timer_artifact', reference: 'fixture:timer', summary: 'Synthetic result.' }],
    evidence: [{ reference: 'fixture:check', summary: 'Synthetic evidence.' }],
  });
  apply('review', {
    decision: 'rejected',
    checks: [
      {
        index: 0,
        result: 'fail',
        evidence_reference: 'fixture:failure',
        note: 'Synthetic failure.',
      },
    ],
  });
  assert.throws(() => apply('start', { actor_context: 'A-context' }), /renewed assignment/);
});

test('packaged planning and task-first CLI work from an unrelated workspace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-plan-'));
  const input = path.join(directory, 'brief.json');
  const routes = path.join(directory, 'workers.json');
  const run = path.join(directory, 'run.json');
  await writeFile(input, JSON.stringify(brief([work('timer')])));
  await writeFile(routes, JSON.stringify([worker('A', 0.01, 30)]));
  const helper = new URL('../plugins/hakengaisya/runtime/scripts/workflow.ts', import.meta.url);
  const call = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [helper.pathname.replace(/^\/(\w:)/, '$1'), ...args], {
        cwd: directory,
        encoding: 'utf8',
      }),
    );
  assert.equal(call('plan', input, routes).assignments[0].worker_id, 'A');
  assert.equal(call('create', run, input).ready.length, 1);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(run, 'utf8'))),
    Object.keys(createRun(null, brief([work('timer')]))),
  );
});

test('actual aliases form one execution context and pool limits also apply to runtime', () => {
  const aliases = [
    worker('A', 0.01, 30, { context_id: 'one-actual-context' }),
    worker('B', 0.01, 30, { context_id: 'one-actual-context' }),
  ];
  assert.equal((planWork(parallelBrief(), aliases) as ScheduledPlan).organization.length, 1);
  assert.equal(
    createRun(null, { ...parallelBrief(), planning_limits: { max_parallel: 1 } }).limits
      .max_parallel,
    1,
  );
  assert.throws(
    () =>
      createRun(null, {
        ...parallelBrief(),
        planning_limits: { max_parallel: 1 },
        limits: { max_parallel: 2 },
      }),
    /respect/,
  );
});

test('task-first terminal gate completes user acceptance without another report department', () => {
  let run = createRun(null, brief([work('timer')]));
  let sequence = 0;
  function event(type: EventType, fields: EventFields) {
    run = applyEvent(run, {
      id: `minimal-${++sequence}`,
      expected_revision: run.revision,
      packet_id: 'handover',
      attempt: 1,
      actor_context: 'host',
      type,
      ...fields,
    } as WorkflowEvent);
  }
  event('assign', {
    assignment: {
      owner_context: 'developer',
      reviewer_context: 'host',
      contributor_contexts: [],
      writes: ['src/timer'],
    },
  });
  event('start', { actor_context: 'developer' });
  event('submit', {
    actor_context: 'developer',
    outputs: [{ id: 'timer_artifact', reference: 'fixture:app', summary: 'Synthetic delivery.' }],
    evidence: [{ reference: 'fixture:checks', summary: 'Synthetic check.' }],
  });
  event('review', {
    decision: 'accepted',
    checks: [
      {
        index: 0,
        result: 'pass',
        evidence_reference: 'fixture:checks',
        note: 'Synthetic gate pass.',
      },
    ],
    task_checks: [
      {
        index: 0,
        result: 'pass',
        evidence_reference: 'fixture:checks',
        note: 'Synthetic user acceptance.',
      },
    ],
  });
  assert.equal(run.revision, 4);
  assert.equal(run.packets.handover.status, 'accepted');
  assert.equal(run.dispatches, 1);
});
