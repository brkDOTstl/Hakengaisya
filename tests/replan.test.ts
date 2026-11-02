import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commands } from '../lib/commands.ts';
import type { ExternalEvidence, HostInventory } from '../lib/evaluator-bridge.ts';
import { type IntegrationInput, prepareIntegratedPlan } from '../lib/integrated.ts';
import { adoptIntegratedReplan, prepareIntegratedReplan } from '../lib/replan.ts';
import type { BatchEvent, BriefInput, Run, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';

const inventory: HostInventory = {
  complete: true,
  routes: [
    {
      id: 'alpha',
      model_id: 'alpha',
      route: 'native',
      effort: 'medium',
      context_id: '/root/a',
      available: true,
      tools_verified: true,
      tools: [],
    },
    {
      id: 'beta',
      model_id: 'beta',
      route: 'native',
      effort: 'medium',
      context_id: '/root/b',
      available: true,
      tools_verified: true,
      tools: [],
    },
  ],
};
const external = (model: string, cost: number): ExternalEvidence => ({
  model_id: model,
  route: 'native',
  effort: 'medium',
  task: {
    domain: 'software-engineering',
    task_type: 'implementation',
    difficulty: 'standard',
    skill: 'implementation',
  },
  source: {
    url: `https://example.com/${model}`,
    title: 'Public reference',
    accessed_at: '2026-10-27T00:00:00Z',
  },
  assessment: { kind: 'qualitative', summary: 'Provisional task fit.', trial_fit: 'supports' },
  estimates: {
    kind: 'unobserved_estimate',
    cost_usd: cost,
    wall_seconds: 10,
    basis: 'Declared estimate.',
  },
});
const evidence = [external('alpha', 0.01), external('beta', 0.02)];
const baseBrief = (hard = false): BriefInput => ({
  run_id: 'replan-example',
  objective: 'Deliver two dependent work items.',
  domain: 'software-engineering',
  lead_context: '/root',
  evidence_kind: 'local_work',
  acceptance: ['The combined result works.'],
  constraints: [],
  limits: { max_parallel: 1, max_attempts: 2, max_dispatches: 6 },
  planning_limits: {
    max_parallel: 1,
    max_workers: 2,
    overhead_seconds: 0,
    overhead_cost_usd: 0,
    context_startup_seconds: 0,
    context_startup_cost_usd: 0,
    ...(hard ? { budget_usd: 1, deadline_seconds: 100 } : {}),
  },
  work_items: [
    {
      id: 'core',
      objective: 'Build the core.',
      task_type: 'implementation',
      difficulty: 'standard',
      skills: ['implementation'],
      depends_on: [],
      inputs: ['task_brief'],
      writes: ['core'],
      outputs: ['core_artifact'],
      acceptance: ['Core works.'],
    },
    {
      id: 'finish',
      objective: 'Integrate the result.',
      task_type: 'implementation',
      difficulty: 'standard',
      skills: ['implementation'],
      depends_on: ['core'],
      inputs: ['core_artifact'],
      writes: ['finish'],
      outputs: ['result'],
      acceptance: ['Integration works.'],
    },
  ],
});
const integration = (routes: HostInventory = inventory): Omit<IntegrationInput, 'brief'> => ({
  inventory: routes,
  external_evidence: evidence,
  public_trials: { enabled: true, max_assignments: 2, require_research_for_all: false },
});
const changedInventory: HostInventory = {
  complete: true,
  routes: [{ ...inventory.routes[0], available: false }, inventory.routes[1]],
};

async function initialRun(hard = false, trialCap?: number, originalPolicy?: string): Promise<Run> {
  const original = baseBrief(hard);
  if (trialCap !== undefined && original.planning_limits)
    original.planning_limits.max_trial_assignments = trialCap;
  if (originalPolicy !== undefined && original.planning_limits)
    original.planning_limits.unproven_routes = originalPolicy;
  const prepared = await prepareIntegratedPlan({ brief: original, ...integration() });
  assert.equal(prepared.status, 'planned');
  assert.ok(prepared.planned_brief);
  const run = createRun(null, {
    ...prepared.planned_brief,
    external_inputs: { integrated_original_brief: original },
  });
  assert.equal(run.dispatch_plan?.assignments[0].model_id, 'alpha');
  return run;
}

function apply(run: Run, event: BatchEvent): Run {
  return applyEvent(run, { ...event, expected_revision: run.revision } as WorkflowEvent);
}

function acceptCore(start: Run): Run {
  let run = start;
  const packet = run.packets.work_core;
  const selected = run.dispatch_plan?.assignments.find((item) => item.work_id === 'core');
  assert.ok(selected);
  run = apply(run, {
    id: 'assign-core',
    type: 'assign',
    packet_id: packet.id,
    attempt: 1,
    actor_context: '/root',
    assignment: {
      owner_context: '/root/a',
      reviewer_context: '/root',
      contributor_contexts: [],
      writes: ['core'],
      worker_id: selected.worker_id,
      model_id: selected.model_id,
      route: selected.route,
      effort: selected.effort,
    },
  });
  run = apply(run, {
    id: 'start-core',
    type: 'start',
    packet_id: packet.id,
    attempt: 1,
    actor_context: '/root/a',
  });
  run = apply(run, {
    id: 'submit-core',
    type: 'submit',
    packet_id: packet.id,
    attempt: 1,
    actor_context: '/root/a',
    outputs: [{ id: 'core_artifact', reference: 'core.txt', summary: 'Observed core.' }],
    evidence: [{ reference: 'core-check.txt', summary: 'Observed check.' }],
  });
  return apply(run, {
    id: 'accept-core',
    type: 'review',
    packet_id: packet.id,
    attempt: 1,
    actor_context: '/root',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'core-check.txt', note: 'Passed.' }],
  });
}

function rejectFinish(start: Run): Run {
  let run = start;
  const selected = run.dispatch_plan?.assignments.find((item) => item.work_id === 'finish');
  assert.ok(selected);
  run = apply(run, {
    id: 'assign-finish',
    type: 'assign',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/root',
    assignment: {
      owner_context: '/root/a',
      reviewer_context: '/root',
      contributor_contexts: [],
      writes: ['finish'],
      worker_id: selected.worker_id,
      model_id: selected.model_id,
      route: selected.route,
      effort: selected.effort,
    },
  });
  run = apply(run, {
    id: 'start-finish',
    type: 'start',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/root/a',
  });
  run = apply(run, {
    id: 'submit-finish',
    type: 'submit',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/root/a',
    outputs: [{ id: 'result', reference: 'result.txt', summary: 'Observed result.' }],
    evidence: [{ reference: 'finish-check.txt', summary: 'Observed check.' }],
  });
  return apply(run, {
    id: 'reject-finish',
    type: 'review',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/root',
    decision: 'rejected',
    checks: [
      {
        index: 0,
        result: 'fail',
        evidence_reference: 'finish-check.txt',
        note: 'Correction needed.',
      },
    ],
  });
}

const approvals = [
  { actor_context: '/root', work_ids: ['finish'], evidence_reference: 'review/approval.json' },
];

test('integrated command prepares outside the lock and atomically adopts a supervised replan', async (t) => {
  const run = await initialRun();
  const dir = await mkdtemp(path.join(tmpdir(), 'hak-replan-command-'));
  const runFile = path.join(dir, 'run.json');
  await writeFile(runFile, JSON.stringify(run));
  t.after(async () => {
    await unlink(runFile);
    await rmdir(dir);
  });
  const prepared = (await commands.integrated_replan_prepare.run({
    run_file: runFile,
    request: { expected_revision: run.revision, integration: integration(changedInventory) },
  })) as Awaited<ReturnType<typeof prepareIntegratedReplan>>;
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;
  const denied = (await commands.integrated_replan_adopt.run({
    run_file: runFile,
    request: {
      proposal: prepared.proposal,
      adoption: { actor_context: '/root', reason: 'Change.', approvals: [] },
    },
  })) as { status: string };
  assert.equal(denied.status, 'needs-evidence');
  assert.equal(JSON.parse(await readFile(runFile, 'utf8')).revision, run.revision);
  const adopted = (await commands.integrated_replan_adopt.run({
    run_file: runFile,
    request: {
      proposal: prepared.proposal,
      adoption: {
        actor_context: '/root',
        reason: 'Route unavailable.',
        approvals: [
          {
            actor_context: '/root',
            work_ids: ['core', 'finish'],
            evidence_reference: 'fixture-supervisor-review',
          },
        ],
      },
    },
  })) as { status: string; revision: number };
  assert.equal(adopted.status, 'adopted');
  const stored = JSON.parse(await readFile(runFile, 'utf8'));
  assert.equal(stored.revision, run.revision + 1);
  assert.equal(stored.journal.at(-1).event.type, 'replan');
  assert.equal(stored.dispatch_plan.assignments[0].model_id, 'beta');
});

test('replans after rejected work, preserving accepted artifacts, actual history and earlier bindings', async () => {
  const initial = rejectFinish(acceptCore(await initialRun()));
  const before = structuredClone(initial);
  const preparation = await prepareIntegratedReplan(initial, {
    expected_revision: initial.revision,
    integration: integration(changedInventory),
  });
  assert.equal(preparation.status, 'prepared');
  if (preparation.status !== 'prepared') return;
  const result = adoptIntegratedReplan(initial, preparation.proposal, {
    actor_context: '/root',
    reason: 'Renew the route after a rejected attempt.',
    approvals,
  });
  assert.equal(result.status, 'adopted');
  if (result.status !== 'adopted') return;
  assert.deepEqual(initial, before);
  assert.deepEqual(result.run.packets.work_core, before.packets.work_core);
  assert.deepEqual(result.run.artifacts, before.artifacts);
  assert.deepEqual(result.run.packets.handover.history, before.packets.handover.history);
  assert.deepEqual(result.run.bound_execution_contexts, before.bound_execution_contexts);
  assert.equal(result.run.packets.handover.assignment, null);
  assert.equal(result.run.packets.handover.attempt, 2);
  assert.equal(
    result.run.dispatch_plan?.assignments.find((item) => item.work_id === 'core')?.model_id,
    'alpha',
  );
  assert.equal(
    result.run.dispatch_plan?.assignments.find((item) => item.work_id === 'finish')?.model_id,
    'beta',
  );
  assert.equal(result.run.revision, before.revision + 1);
  assert.equal(result.run.journal.at(-1)?.event.type, 'replan');
  assert.deepEqual(result.event.plan_before, before.dispatch_plan);
  assert.deepEqual(result.changed_work_ids, ['finish']);
  assert.throws(
    () => applyEvent(before, result.event),
    /Unknown workflow event|validated integrated replan/,
  );
  const selected = result.run.dispatch_plan?.assignments.find((item) => item.work_id === 'finish');
  assert.ok(selected);
  const assigned = apply(result.run, {
    id: 'assign-retry',
    type: 'assign',
    packet_id: 'handover',
    attempt: 2,
    actor_context: '/root',
    assignment: {
      owner_context: '/root/b',
      reviewer_context: '/root',
      contributor_contexts: [],
      writes: ['finish'],
      worker_id: selected.worker_id,
      model_id: selected.model_id,
      route: selected.route,
      effort: selected.effort,
      fit_reason: 'Supervisor-approved fresh evidence.',
    },
  });
  assert.equal(assigned.packets.handover.assignment?.model_id, 'beta');
  assert.equal(assigned.packets.work_core.status, 'accepted');
});

test('direct-supervisor approval and its evidence are required for changed work', async () => {
  const run = acceptCore(await initialRun());
  const prepared = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;
  assert.equal(
    adoptIntegratedReplan(run, prepared.proposal, {
      actor_context: '/root',
      reason: 'Change.',
      approvals: [],
    }).status,
    'needs-evidence',
  );
  assert.equal(
    adoptIntegratedReplan(run, prepared.proposal, {
      actor_context: '/root',
      reason: 'Change.',
      approvals: [
        { actor_context: '/other', work_ids: ['finish'], evidence_reference: 'evidence' },
      ],
    }).status,
    'needs-evidence',
  );
  assert.equal(
    adoptIntegratedReplan(run, prepared.proposal, {
      actor_context: '/root',
      reason: 'Change.',
      approvals: [{ actor_context: '/root', work_ids: ['finish'], evidence_reference: '' }],
    }).status,
    'needs-evidence',
  );
  assert.throws(
    () =>
      adoptIntegratedReplan(run, prepared.proposal, {
        actor_context: '/other',
        reason: 'Change.',
        approvals,
      }),
    /root coordinator/,
  );
});

test('a root coordinator cannot substitute its own approval for the responsible team supervisor', async () => {
  const original = baseBrief();
  original.reporting_lines = [
    { supervisor_context: '/root', subordinate_context: '/root/team' },
    { supervisor_context: '/root/team', subordinate_context: '/root/team/a' },
    { supervisor_context: '/root', subordinate_context: '/root/b' },
    { supervisor_context: '/root/team', subordinate_context: '/root/team/c' },
  ];
  assert.ok(original.work_items);
  original.work_items[0].supervisor_context = '/root/team';
  const routes: HostInventory = {
    complete: true,
    routes: [{ ...inventory.routes[0], context_id: '/root/team/a' }, inventory.routes[1]],
  };
  const first = await prepareIntegratedPlan({ brief: original, ...integration(routes) });
  assert.equal(first.status, 'planned');
  assert.ok(first.planned_brief);
  const run = createRun(null, {
    ...first.planned_brief,
    external_inputs: { integrated_original_brief: original },
  });
  const replacement: HostInventory = {
    complete: true,
    routes: [
      { ...routes.routes[0], available: false },
      routes.routes[1],
      {
        id: 'gamma',
        model_id: 'gamma',
        route: 'native',
        effort: 'medium',
        context_id: '/root/team/c',
        available: true,
        tools_verified: true,
        tools: [],
      },
    ],
  };
  const fresh = {
    ...integration(replacement),
    external_evidence: [...evidence, external('gamma', 0.01)],
  };
  const prepared = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: fresh,
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;
  const wrong = adoptIntegratedReplan(run, prepared.proposal, {
    actor_context: '/root',
    reason: 'Change.',
    approvals: [{ actor_context: '/root', work_ids: ['core'], evidence_reference: 'review/root' }],
  });
  assert.equal(wrong.status, 'needs-evidence');
  const correct = adoptIntegratedReplan(run, prepared.proposal, {
    actor_context: '/root',
    reason: 'Change.',
    approvals: [
      { actor_context: '/root/team', work_ids: ['core'], evidence_reference: 'review/team' },
    ],
  });
  assert.equal(correct.status, 'adopted');
});

test('active and uncertain work blocks preparation, and stale revisions block adoption', async () => {
  const run = acceptCore(await initialRun());
  const prepared = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;
  const active = structuredClone(run);
  active.packets.handover.status = 'running';
  assert.equal(
    (
      await prepareIntegratedReplan(active, {
        expected_revision: active.revision,
        integration: integration(changedInventory),
      })
    ).status,
    'needs-evidence',
  );
  active.packets.handover.status = 'blocked';
  assert.equal(
    (
      await prepareIntegratedReplan(active, {
        expected_revision: active.revision,
        integration: integration(changedInventory),
      })
    ).status,
    'needs-evidence',
  );
  active.packets.handover.status = 'in_review';
  assert.equal(
    (
      await prepareIntegratedReplan(active, {
        expected_revision: active.revision,
        integration: integration(changedInventory),
      })
    ).status,
    'needs-evidence',
  );
  const stale = structuredClone(run);
  stale.revision++;
  assert.throws(
    () =>
      adoptIntegratedReplan(stale, prepared.proposal, {
        actor_context: '/root',
        reason: 'Change.',
        approvals,
      }),
    /Stale/,
  );
  await assert.rejects(
    prepareIntegratedReplan(run, {
      expected_revision: run.revision - 1,
      integration: integration(changedInventory),
    }),
    /Stale/,
  );
});

test('hard budget and deadline need observed progress and cannot be exceeded', async () => {
  const run = acceptCore(await initialRun(true));
  const missing = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
  });
  assert.equal(missing.status, 'needs-evidence');
  const excessive = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
    progress: {
      kind: 'observed',
      evidence_reference: 'metrics',
      spent_cost_usd: 1.01,
      elapsed_seconds: 20,
    },
  });
  assert.equal(excessive.status, 'constraints-unmet');
  const late = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
    progress: {
      kind: 'observed',
      evidence_reference: 'metrics',
      spent_cost_usd: 0.1,
      elapsed_seconds: 101,
    },
  });
  assert.equal(late.status, 'constraints-unmet');
  const insufficientBudget = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
    progress: {
      kind: 'observed',
      evidence_reference: 'metrics',
      spent_cost_usd: 0.99,
      elapsed_seconds: 20,
    },
  });
  assert.equal(insufficientBudget.status, 'constraints-unmet');
  const insufficientTime = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
    progress: {
      kind: 'observed',
      evidence_reference: 'metrics',
      spent_cost_usd: 0.1,
      elapsed_seconds: 95,
    },
  });
  assert.equal(insufficientTime.status, 'constraints-unmet');
  const within = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
    progress: {
      kind: 'observed',
      evidence_reference: 'metrics',
      spent_cost_usd: 0.1,
      elapsed_seconds: 20,
    },
  });
  assert.equal(within.status, 'prepared');
  if (within.status === 'prepared') {
    const modified = structuredClone(within.proposal);
    if (modified.progress) modified.progress.spent_cost_usd = 0;
    assert.throws(
      () =>
        adoptIntegratedReplan(run, modified, {
          actor_context: '/root',
          reason: 'Change.',
          approvals,
        }),
      /modified/,
    );
    assert.equal(
      adoptIntegratedReplan(run, within.proposal, {
        actor_context: '/root',
        reason: 'Change.',
        approvals,
      }).status,
      'adopted',
    );
  }
});

test('replanning does not reset an original cumulative trial-assignment ceiling', async () => {
  const run = rejectFinish(acceptCore(await initialRun(false, 2, 'sourced-trial')));
  const prepared = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(changedInventory),
  });
  assert.equal(prepared.status, 'constraints-unmet');
  assert.match(prepared.reason, /cumulative ceiling/);
});

test('an explicit original trial or refuse policy cannot become a sourced-trial policy', async () => {
  for (const policy of ['trial', 'refuse']) {
    const original = baseBrief();
    assert.ok(original.planning_limits);
    original.planning_limits.unproven_routes = policy;
    if (policy === 'trial')
      original.planning_limits.trial_estimate = { cost_usd: 0.1, wall_seconds: 10 };
    const supported = {
      model_id: 'alpha',
      route: 'native',
      effort: 'medium',
      evaluation_kind: 'local_work',
      domain: 'software-engineering',
      task_type: 'implementation',
      difficulty: 'standard',
      skill: 'implementation',
      dimensions: Object.fromEntries(
        ['D1', 'D2', 'D6'].map((key) => [
          key,
          { score: 8, support: 'supported-peer-observations' },
        ]),
      ),
      observed_cost_usd: 0.1,
      observed_wall_seconds: 10,
    };
    const workers = inventory.routes.map((route) => ({
      ...route,
      profiles: route.model_id === 'alpha' ? [supported] : [],
    }));
    const run = createRun(null, {
      ...original,
      workers,
      external_inputs: { integrated_original_brief: original },
    });
    assert.equal(run.dispatch_plan?.status, 'planned');
    const result = await prepareIntegratedReplan(run, {
      expected_revision: run.revision,
      integration: integration(changedInventory),
    });
    assert.equal(result.status, 'needs-evidence');
    assert.match(result.reason, /original unproven-route policy/);
  }
});

test('rejects changed scope, fake available evidence and reuse of a bound context for another model', async () => {
  const run = acceptCore(await initialRun());
  const mutated = structuredClone(run);
  mutated.packets.handover.objective = 'Different task.';
  assert.equal(
    (
      await prepareIntegratedReplan(mutated, {
        expected_revision: mutated.revision,
        integration: integration(changedInventory),
      })
    ).status,
    'needs-evidence',
  );
  const invalidArtifact = structuredClone(run);
  invalidArtifact.artifacts.core_artifact.reference = 'wrong.txt';
  assert.equal(
    (
      await prepareIntegratedReplan(invalidArtifact, {
        expected_revision: invalidArtifact.revision,
        integration: integration(changedInventory),
      })
    ).status,
    'needs-evidence',
  );
  const absent = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: { inventory: changedInventory },
  });
  assert.equal(absent.status, 'needs-evidence');
  const reused: HostInventory = {
    complete: true,
    routes: [{ ...inventory.routes[1], id: 'alpha', context_id: '/root/a' }],
  };
  const prepared = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: integration(reused),
  });
  if (prepared.status === 'prepared')
    assert.notEqual(
      adoptIntegratedReplan(run, prepared.proposal, {
        actor_context: '/root',
        reason: 'Change.',
        approvals,
      }).status,
      'adopted',
    );
  else assert.equal(prepared.status, 'needs-evidence');
});
