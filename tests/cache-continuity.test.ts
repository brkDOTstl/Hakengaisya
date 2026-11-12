import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, sha256Digest } from '../lib/canonical.ts';
import { prepareReview } from '../lib/dispatch.ts';
import type { ExternalEvidence, HostInventory } from '../lib/evaluator-bridge.ts';
import { prepareIntegratedPlan } from '../lib/integrated.ts';
import { agentReview } from '../lib/participation.ts';
import { planWork, type ScheduledPlan } from '../lib/planning.ts';
import { adoptIntegratedReplan, prepareIntegratedReplan } from '../lib/replan.ts';
import type {
  BatchEvent,
  BriefInput,
  PacketUsage,
  WorkerInput,
  WorkflowEvent,
  WorkItemInput,
} from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';

const DIMS = Object.fromEntries(
  ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((key) => [
    key,
    { score: 8, support: 'supported-peer-observations' },
  ]),
);

function makeWorker(
  id: string,
  modelId: string,
  cost: number,
  seconds: number,
  skills = ['implementation'],
): WorkerInput {
  return {
    id,
    model_id: modelId,
    route: 'local',
    effort: 'standard',
    available: true,
    tools_verified: true,
    tools: ['shell'],
    profiles: skills.map((skill) => ({
      model_id: modelId,
      route: 'local',
      effort: 'standard',
      evaluation_kind: 'simulation',
      domain: 'software-engineering',
      task_type: 'implementation',
      difficulty: 'routine',
      skill,
      dimensions: DIMS,
      observed_cost_usd: cost,
      observed_wall_seconds: seconds,
    })),
  };
}

function sequentialItems(): WorkItemInput[] {
  return [
    {
      id: 'step_one',
      objective: 'Implement core module.',
      task_type: 'implementation',
      difficulty: 'routine',
      skills: ['implementation'],
      depends_on: [],
      writes: ['src/core'],
      outputs: ['core_out'],
      acceptance: ['Core works.'],
    },
    {
      id: 'step_two',
      objective: 'Extend core module and finalize.',
      task_type: 'implementation',
      difficulty: 'routine',
      skills: ['implementation'],
      depends_on: ['step_one'],
      inputs: ['core_out'],
      writes: ['src/core'],
      outputs: ['final_out'],
      acceptance: ['Final works.'],
    },
  ];
}

function makeBrief(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    run_id: 'continuity-run',
    objective: 'Keep one warm model across sequential engineering steps.',
    domain: 'software-engineering',
    evidence_kind: 'simulation',
    lead_context: 'lead',
    acceptance: ['All behavior verified.'],
    constraints: [],
    work_items: sequentialItems(),
    ...overrides,
  };
}

test('canonical JSON omits undefined object properties consistently with JSON.stringify', () => {
  assert.equal(canonical({ b: 1, a: undefined, c: [undefined, 2] }), '{"b":1,"c":[null,2]}');
  assert.equal(sha256Digest({ a: 1, b: undefined }), sha256Digest({ a: 1 }));
});

test('sticky and single-model continuity prevent model churn across sequential steps and discount warm continuations', () => {
  const workers: WorkerInput[] = [
    makeWorker('w-alpha', 'model-alpha', 0.01, 20, ['implementation', 'scoping']),
    makeWorker('w-beta', 'model-beta', 0.0095, 20, ['implementation']),
  ];
  const singleStep: WorkItemInput[] = [sequentialItems()[1]];
  singleStep[0] = { ...singleStep[0], depends_on: [], inputs: ['task_brief'] };

  // When w-alpha is already warm, legacy 'none' still switches to slightly-cheaper cold w-beta.
  const unsticky = planWork(
    makeBrief({
      work_items: singleStep,
      planning_limits: { continuity_policy: 'none', warm_context_keys: ['w-alpha'] },
    }),
    workers,
  ) as ScheduledPlan;
  assert.equal(unsticky.status, 'planned');
  assert.deepEqual(
    unsticky.assignments.map((item) => item.model_id),
    ['model-beta'],
  );

  // Default 'sticky' keeps the already-warm w-alpha context within parallel_cost_premium.
  const sticky = planWork(
    makeBrief({
      work_items: singleStep,
      planning_limits: { warm_context_keys: ['w-alpha'] },
    }),
    workers,
  ) as ScheduledPlan;
  assert.equal(sticky.status, 'planned');
  assert.deepEqual(
    sticky.assignments.map((item) => item.model_id),
    ['model-alpha'],
  );
  assert.equal(sticky.continuity?.context_reuses, 1);

  // 'prefer-single-model' keeps one model across sequential steps even when beta is cheaper & faster.
  const items = sequentialItems();
  items[0] = { ...items[0], skills: ['scoping'] };
  const fasterCheaperBeta = [
    makeWorker('w-alpha', 'model-alpha', 0.01, 20, ['implementation', 'scoping']),
    makeWorker('w-beta', 'model-beta', 0.005, 19, ['implementation']),
  ];
  const singlePreferred = planWork(
    makeBrief({
      work_items: items,
      planning_limits: {
        continuity_policy: 'prefer-single-model',
        warm_context_cost_discount: 0.5,
        overhead_cost_usd: 0,
        context_startup_cost_usd: 0,
      },
    }),
    fasterCheaperBeta,
  ) as ScheduledPlan;
  assert.equal(singlePreferred.status, 'planned');
  assert.deepEqual(
    singlePreferred.assignments.map((item) => item.model_id),
    ['model-alpha', 'model-alpha'],
  );
  // Cold step_one costs 0.01; warm reused step_two gets 50% discount -> 0.005; total = 0.015.
  assert.equal(singlePreferred.estimated_cost_usd, 0.015);
});

test('strict-single-model refuses split execution, exempts independent audit_sources, and enforces runtime assignment', () => {
  const splitSkills: WorkItemInput[] = [
    { ...sequentialItems()[0], skills: ['frontend'] },
    { ...sequentialItems()[1], skills: ['backend'] },
  ];
  const specialists = [
    makeWorker('w-fe', 'model-fe', 0.01, 20, ['frontend']),
    makeWorker('w-be', 'model-be', 0.01, 20, ['backend']),
  ];
  const refused = planWork(
    makeBrief({
      work_items: splitSkills,
      cache_policy: { continuity_mode: 'strict-single-model' },
    }),
    specialists,
  );
  assert.equal(refused.status, 'constraints-unmet');
  assert.equal(refused.reason, 'single-model-continuity-unmet');

  // Prefer-single-model falls back explicitly when no single model covers both skills.
  const fallback = planWork(
    makeBrief({
      work_items: splitSkills,
      cache_policy: { continuity_mode: 'prefer-single-model' },
    }),
    specialists,
  ) as ScheduledPlan;
  assert.equal(fallback.status, 'planned');
  assert.equal(
    fallback.continuity?.fallback_reason,
    'no-single-model-satisfied-all-work-and-bounds',
  );

  // Independent audit packet may use a distinct model/context while execution stays single-model.
  const withAudit: WorkItemInput[] = [
    sequentialItems()[0],
    {
      id: 'audit',
      objective: 'Independently verify core.',
      task_type: 'implementation',
      difficulty: 'routine',
      skills: ['auditing'],
      depends_on: ['step_one'],
      audit_sources: ['step_one'],
      inputs: ['core_out'],
      writes: ['reports/audit'],
      outputs: ['audit_out'],
      acceptance: ['Audit complete.'],
    },
  ];
  const auditPlanned = planWork(
    makeBrief({
      work_items: withAudit,
      cache_policy: { continuity_mode: 'strict-single-model' },
    }),
    [
      makeWorker('w-exec', 'model-exec', 0.01, 20, ['implementation']),
      makeWorker('w-auditor', 'model-auditor', 0.01, 20, ['auditing']),
    ],
  ) as ScheduledPlan;
  assert.equal(auditPlanned.status, 'planned');
  assert.deepEqual(auditPlanned.continuity?.execution_models, ['model-exec']);

  // Runtime assignment also blocks switching execution models under strict-single-model.
  let run = createRun(
    null,
    makeBrief({ cache_policy: { continuity_mode: 'strict-single-model' } }),
  );
  run = applyEvent(run, {
    id: 'assign-1',
    expected_revision: run.revision,
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'assign',
    actor_context: 'lead',
    assignment: {
      owner_context: 'ctx-alpha',
      reviewer_context: 'lead',
      contributor_contexts: [],
      writes: ['src/core'],
      model_id: 'model-alpha',
      route: 'local',
    },
  });
  assert.throws(
    () =>
      applyEvent(run, {
        id: 'assign-2-other-model',
        expected_revision: run.revision,
        packet_id: 'handover',
        attempt: 1,
        type: 'assign',
        actor_context: 'lead',
        assignment: {
          owner_context: 'ctx-beta',
          reviewer_context: 'lead',
          contributor_contexts: [],
          writes: ['src/core'],
          model_id: 'model-beta',
          route: 'local',
        },
      }),
    /forbids switching execution models/,
  );
});

test('management review penalizes unjustified model switching and enforces configurable cache hit rate hard gates', () => {
  const runSteps = (
    brief: BriefInput,
    secondModel: string,
    secondOwner: string,
    usages: [PacketUsage | undefined, PacketUsage | undefined],
  ) => {
    let run = createRun(null, brief);
    const step = (ev: BatchEvent) => {
      run = applyEvent(run, { ...ev, expected_revision: run.revision } as WorkflowEvent);
    };
    step({
      id: 'a1',
      packet_id: 'work_step_one',
      attempt: 1,
      type: 'assign',
      actor_context: 'lead',
      assignment: {
        owner_context: 'ctx-1',
        reviewer_context: 'lead',
        contributor_contexts: [],
        writes: ['src/core'],
        model_id: 'model-alpha',
        route: 'local',
      },
    });
    step({
      id: 's1',
      packet_id: 'work_step_one',
      attempt: 1,
      type: 'start',
      actor_context: 'ctx-1',
    });
    step({
      id: 'sub1',
      packet_id: 'work_step_one',
      attempt: 1,
      type: 'submit',
      actor_context: 'ctx-1',
      outputs: [{ id: 'core_out', reference: 'src/core/index.ts', summary: 'Core module.' }],
      evidence: [{ reference: 'logs/step1.txt', summary: 'Tests pass.' }],
      ...(usages[0] ? { usage: usages[0] } : {}),
    });
    step({
      id: 'rev1',
      packet_id: 'work_step_one',
      attempt: 1,
      type: 'review',
      actor_context: 'lead',
      decision: 'accepted',
      checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/step1.txt', note: 'OK.' }],
    });
    step({
      id: 'a2',
      packet_id: 'handover',
      attempt: 1,
      type: 'assign',
      actor_context: 'lead',
      assignment: {
        owner_context: secondOwner,
        reviewer_context: 'lead',
        contributor_contexts: [],
        writes: ['src/core'],
        model_id: secondModel,
        route: 'local',
      },
    });
    step({
      id: 's2',
      packet_id: 'handover',
      attempt: 1,
      type: 'start',
      actor_context: secondOwner,
    });
    step({
      id: 'sub2',
      packet_id: 'handover',
      attempt: 1,
      type: 'submit',
      actor_context: secondOwner,
      outputs: [{ id: 'final_out', reference: 'src/core/final.ts', summary: 'Finalized.' }],
      evidence: [{ reference: 'logs/step2.txt', summary: 'Tests pass.' }],
      ...(usages[1] ? { usage: usages[1] } : {}),
    });
    return run;
  };

  // Soft management review: unjustified switch + low cache rate deducts score without blocking handover.
  let switched = runSteps(
    makeBrief({
      cache_policy: {
        continuity_mode: 'prefer-single-model',
        target_cache_hit_rate: 0.7,
        enforce_cache_gate: false,
      },
    }),
    'model-beta',
    'ctx-2',
    [
      { input_tokens: 2000, cached_input_tokens: 200, output_tokens: 100 },
      { input_tokens: 3000, cached_input_tokens: 300, output_tokens: 150 },
    ],
  );
  const preview = prepareReview(switched, 'handover');
  assert.equal(preview.cache_and_continuity_preview.usage.observed_cache_hit_rate, 0.1);
  assert.ok(preview.cache_and_continuity_preview.tags.includes('unjustified-model-switch'));
  assert.ok(preview.cache_and_continuity_preview.tags.includes('cache-below-target'));
  switched = applyEvent(switched, {
    id: 'rev2',
    expected_revision: switched.revision,
    packet_id: 'handover',
    attempt: 1,
    type: 'review',
    actor_context: 'lead',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/step2.txt', note: 'OK.' }],
    task_checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/step2.txt', note: 'OK.' }],
  });
  const mgmt = agentReview(switched);
  assert.equal(mgmt.cache_and_continuity.status, 'below-target');
  assert.ok((mgmt.cache_and_continuity.score ?? 10) <= 4);

  // Hard gate enabled: low cumulative cache hit rate blocks final acceptance.
  const gatedLow = runSteps(
    makeBrief({
      cache_policy: {
        continuity_mode: 'strict-single-model',
        target_cache_hit_rate: 0.75,
        minimum_cache_hit_rate: 0.6,
        enforce_cache_gate: true,
      },
    }),
    'model-alpha',
    'ctx-1',
    [
      { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 80 },
      { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 120 },
    ],
  );
  assert.throws(
    () =>
      applyEvent(gatedLow, {
        id: 'rev2-blocked',
        expected_revision: gatedLow.revision,
        packet_id: 'handover',
        attempt: 1,
        type: 'review',
        actor_context: 'lead',
        decision: 'accepted',
        checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/step2.txt', note: 'OK.' }],
        task_checks: [
          { index: 0, result: 'pass', evidence_reference: 'logs/step2.txt', note: 'OK.' },
        ],
      }),
    /below minimum_cache_hit_rate/,
  );

  // Cold turn 1 (0/1000) + warm turn 2 reusing ctx-1 (8000/9000) -> 80% cumulative cache hit rate passes!
  let gatedHigh = runSteps(
    makeBrief({
      cache_policy: {
        continuity_mode: 'strict-single-model',
        target_cache_hit_rate: 0.75,
        minimum_cache_hit_rate: 0.6,
        enforce_cache_gate: true,
      },
    }),
    'model-alpha',
    'ctx-1',
    [
      { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 80 },
      { input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 120 },
    ],
  );
  gatedHigh = applyEvent(gatedHigh, {
    id: 'rev2-pass',
    expected_revision: gatedHigh.revision,
    packet_id: 'handover',
    attempt: 1,
    type: 'review',
    actor_context: 'lead',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/step2.txt', note: 'OK.' }],
    task_checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/step2.txt', note: 'OK.' }],
  });
  const compliant = agentReview(gatedHigh);
  assert.equal(compliant.cache_and_continuity.status, 'compliant');
  assert.equal(compliant.cache_and_continuity.score, 10);
  assert.equal(compliant.cache_and_continuity.context_reuses, 1);
  assert.equal(compliant.cache_and_continuity.usage.observed_cache_hit_rate, 0.8);
});

test('replanning preserves incumbent model stickiness when the active worker remains healthy', async () => {
  const inventory: HostInventory = {
    complete: true,
    routes: [
      {
        id: 'slot-alpha',
        model_id: 'alpha',
        route: 'native',
        effort: 'high',
        context_id: 'ctx-alpha',
        available: true,
        tools_verified: true,
        tools: [],
      },
      {
        id: 'slot-beta',
        model_id: 'beta',
        route: 'native',
        effort: 'high',
        context_id: 'ctx-beta',
        available: true,
        tools_verified: true,
        tools: [],
      },
    ],
  };
  const evidence = (modelId: string, cost: number, wall: number): ExternalEvidence => ({
    model_id: modelId,
    route: 'native',
    effort: 'high',
    task: {
      domain: 'software-engineering',
      task_type: 'implementation',
      difficulty: 'routine',
      skill: 'implementation',
    },
    source: {
      url: `https://example.com/${modelId}`,
      title: `${modelId} card`,
      accessed_at: '2026-10-20T00:00:00Z',
    },
    assessment: {
      kind: 'qualitative',
      trial_fit: 'supports',
      summary: 'Supports routine implementation.',
    },
    estimates: {
      kind: 'unobserved_estimate',
      cost_usd: cost,
      wall_seconds: wall,
      basis: 'Fixture estimate.',
    },
  });
  const original = makeBrief({
    cache_policy: { continuity_mode: 'prefer-single-model' },
    planning_limits: {
      unproven_routes: 'sourced-trial',
      max_trial_assignments: 2,
      overhead_seconds: 1,
      overhead_cost_usd: 0.001,
      context_startup_seconds: 2,
      context_startup_cost_usd: 0.002,
    },
  });
  const prepared = await prepareIntegratedPlan({
    brief: original,
    inventory,
    external_evidence: [evidence('alpha', 0.01, 20), evidence('beta', 0.012, 20)],
    public_trials: { enabled: true, max_assignments: 2, require_research_for_all: false },
  });
  assert.equal(prepared.status, 'planned');
  assert.ok(prepared.planned_brief);
  let run = createRun(null, {
    ...prepared.planned_brief,
    external_inputs: { integrated_original_brief: original },
  });
  run = applyEvent(run, {
    id: 'a1',
    expected_revision: run.revision,
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'assign',
    actor_context: 'lead',
    assignment: {
      owner_context: 'ctx-alpha',
      reviewer_context: 'lead',
      contributor_contexts: [],
      writes: ['src/core'],
      worker_id: 'slot-alpha',
      model_id: 'alpha',
      route: 'native',
      effort: 'high',
    },
  });
  run = applyEvent(run, {
    id: 's1',
    expected_revision: run.revision,
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'start',
    actor_context: 'ctx-alpha',
  });
  run = applyEvent(run, {
    id: 'sub1',
    expected_revision: run.revision,
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'submit',
    actor_context: 'ctx-alpha',
    outputs: [{ id: 'core_out', reference: 'src/core/a.ts', summary: 'Done.' }],
    evidence: [{ reference: 'logs/a.txt', summary: 'Checked.' }],
  });
  run = applyEvent(run, {
    id: 'rev1',
    expected_revision: run.revision,
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'review',
    actor_context: 'lead',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/a.txt', note: 'OK.' }],
  });

  // Even if beta now looks cheaper and faster on paper, incumbent alpha stays selected on step_two!
  const replanned = await prepareIntegratedReplan(run, {
    expected_revision: run.revision,
    integration: {
      inventory,
      external_evidence: [evidence('alpha', 0.01, 20), evidence('beta', 0.008, 18)],
      public_trials: { enabled: true, max_assignments: 2, require_research_for_all: false },
    },
  });
  assert.equal(replanned.status, 'prepared');
  if (replanned.status !== 'prepared') return;
  assert.deepEqual(
    replanned.proposal.prepared.plan?.assignments.map((item) => item.model_id),
    ['alpha'],
  );
  assert.deepEqual(
    replanned.proposal.prepared.plan?.assignments.map((item) => item.context_key),
    ['ctx-alpha'],
  );
  void adoptIntegratedReplan;
});
