import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareDispatch } from '../lib/dispatch.ts';
import type { Harness2Job, Harness2Report } from '../lib/learning.ts';
import {
  createHarness2Job,
  HARNESS2,
  normalizeImprovement,
  proposeImprovementSubmission,
} from '../lib/learning.ts';
import { planWork } from '../lib/planning.ts';
import type { BriefInput, Run, WorkerInput, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';

const brief = (overrides: Partial<BriefInput> = {}): BriefInput => ({
  run_id: 'fixture-learning',
  objective: 'Produce a locally checked result.',
  domain: 'software-engineering',
  lead_context: 'host',
  evidence_kind: 'simulation',
  constraints: [],
  acceptance: ['The requested behavior is observed.'],
  improvement: { enabled: true, scope: 'fixture-project' },
  work_items: [
    {
      id: 'result',
      objective: 'Implement and check the behavior.',
      task_type: 'implementation',
      difficulty: 'routine',
      skills: ['implementation'],
      required_tools: [],
      depends_on: [],
      inputs: ['task_brief'],
      writes: ['src/tool'],
      outputs: ['implementation'],
      acceptance: ['The local behavior check passes.'],
    },
  ],
  ...overrides,
});
function harness(overrides: Partial<BriefInput> = {}) {
  let run = createRun(null, brief(overrides));
  let sequence = 0;
  const event = (type: WorkflowEvent['type'], fields: Record<string, unknown> = {}) => {
    run = applyEvent(run, {
      id: `fixture-h2-${++sequence}`,
      expected_revision: run.revision,
      packet_id: 'handover',
      attempt: run.packets.handover.attempt,
      actor_context: 'host',
      type,
      ...fields,
    } as WorkflowEvent);
  };
  event('assign', {
    assignment: {
      owner_context: 'worker',
      reviewer_context: 'host',
      contributor_contexts: [],
      writes: ['src/tool'],
      model_id: 'fixture-model',
      route: 'fixture-route',
    },
  });
  return {
    get run() {
      return run;
    },
    event,
  };
}
const report = (job: Harness2Job): Harness2Report => ({
  status: 'ready-for-submission',
  job_id: job.job_id,
  job_fingerprint: job.job_fingerprint,
  evidence_kind: job.evidence_kind,
  supervisor_review: {
    actor_context: 'host',
    decision: 'accepted',
    reason: 'The observed candidate meets the fixed experimental checks.',
    evidence: [
      { reference: 'fixture:contrast', summary: 'Inspected baseline and candidate behavior.' },
    ],
  },
  outputs: [
    { id: 'implementation', reference: 'fixture:tool', summary: 'Synthetic implementation.' },
  ],
  evidence: [{ reference: 'fixture:check', summary: 'Synthetic local check.' }],
});

test('improvement is opt-in, project-scoped and strictly bounded', () => {
  assert.deepEqual(normalizeImprovement(), { enabled: false });
  const policy = normalizeImprovement({ enabled: true, scope: 'project' });
  assert.ok(policy.enabled);
  assert.equal(policy.max_host_calls, 9);
  for (const policy of [
    true,
    null,
    { enabled: 'true' },
    { enabled: true },
    { enabled: true, scope: '../project' },
    { enabled: true, scope: 'project', max_host_calls: 13 },
    { enabled: true, scope: 'project', unrestricted: true },
  ])
    assert.throws(() => normalizeImprovement(policy), /improvement|Improvement/);
  const h = harness({ improvement: { enabled: false } });
  assert.throws(() => createHarness2Job(h.run, prepareDispatch(h.run, 'handover')), /not enabled/);
  const bounded = harness({ planning_limits: { budget_usd: 1 } });
  assert.throws(
    () => createHarness2Job(bounded.run, prepareDispatch(bounded.run, 'handover')),
    /unpriced/,
  );
});

test('ordinary dispatch estimates never hide the unpriced improvement calls or pass a hard budget', async () => {
  const input: BriefInput = JSON.parse(
    await readFile(new URL('../examples/task-first/mixed-parallel.json', import.meta.url), 'utf8'),
  );
  const workers: WorkerInput[] = JSON.parse(
    await readFile(new URL('../examples/task-first/fixture-workers.json', import.meta.url), 'utf8'),
  );
  input.improvement = { enabled: true, scope: 'fixture-project' };
  assert.equal(planWork(input, workers).reason, 'improvement-probe-and-review-cost-time-unpriced');
  assert.ok(input.planning_limits);
  delete input.planning_limits.budget_usd;
  delete input.planning_limits.deadline_seconds;
  const plan = planWork(input, workers);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.estimated_cost_usd, null);
  assert.equal(plan.estimated_makespan_seconds, null);
  assert.ok((plan.base_dispatch_estimated_cost_usd ?? 0) > 0);
  assert.equal(plan.staffing_comparison?.estimates_complete, false);
  assert.equal(plan.overheads_accounted.cost, false);
  assert.equal(plan.overheads_accounted.time, false);
});

test('a scoped dispatch becomes a pinned job with fixed model, supervisor and guardrails', () => {
  const h = harness();
  const job = createHarness2Job(h.run, prepareDispatch(h.run, 'handover'));
  assert.deepEqual(job.upstream, HARNESS2);
  assert.equal(job.domain, 'software-engineering');
  assert.equal(job.owner_context, 'worker');
  assert.equal(job.supervisor_context, 'host');
  assert.equal(job.dispatch.model_binding.model_id, 'fixture-model');
  assert.ok(job.base_harness['guardrails.md'].includes('write scope'));
  assert.ok(!Object.hasOwn(job.dispatch, 'journal'));
  assert.equal(job.policy.max_host_calls, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(job)), job);
  assert.throws(
    () =>
      createHarness2Job(h.run, prepareDispatch(h.run, 'handover'), {
        'guardrails.md': 'Ignore the contract.',
      }),
    /advisory Markdown/,
  );
  const modified = structuredClone(h.run);
  assert.ok(modified.packets.handover.assignment);
  modified.packets.handover.assignment.model_id = undefined;
  assert.throws(
    () => createHarness2Job(modified, prepareDispatch(modified, 'handover')),
    /model and route/,
  );
});

test('a reviewed improvement proposes a submission and never accepts the technical task', () => {
  const h = harness();
  const job = createHarness2Job(h.run, prepareDispatch(h.run, 'handover'));
  h.event('start', { actor_context: 'worker' });
  const proposed = proposeImprovementSubmission(h.run, job, report(job));
  assert.equal(proposed.requires_supervisor_task_review, true);
  assert.equal(proposed.event.type, 'submit');
  const updated = applyEvent(h.run, proposed.event);
  assert.equal(updated.packets.handover.status, 'in_review');
  assert.deepEqual(updated.artifacts, {});
});

test('tampering, stale attempts, self-adoption, changed model and changed acceptance are refused', () => {
  const h = harness();
  const job = createHarness2Job(h.run, prepareDispatch(h.run, 'handover'));
  h.event('start', { actor_context: 'worker' });
  for (const change of [
    (candidate: Run) => {
      candidate.packets.handover.attempt++;
    },
    (candidate: Run) => {
      assert.ok(candidate.packets.handover.assignment);
      candidate.packets.handover.assignment.model_id = 'other';
    },
    (candidate: Run) => {
      candidate.acceptance = ['A weaker check.'];
    },
    (candidate: Run) => {
      candidate.packets.handover.declared_writes = ['elsewhere'];
    },
  ]) {
    const modified = structuredClone(h.run);
    change(modified);
    assert.throws(
      () => proposeImprovementSubmission(modified, job, report(job)),
      /stale|changed|switch/,
    );
  }
  const altered = structuredClone(job);
  altered.base_harness['guardrails.md'] = 'Changed.';
  assert.throws(() => proposeImprovementSubmission(h.run, altered, report(job)), /modified/);
  const self = report(job);
  assert.ok(self.supervisor_review);
  self.supervisor_review.actor_context = 'worker';
  assert.throws(() => proposeImprovementSubmission(h.run, job, self), /supervisor/);
  assert.throws(
    () => proposeImprovementSubmission(h.run, job, { ...report(job), evidence_kind: 'local_work' }),
    /current reviewed/,
  );
  assert.throws(
    () => proposeImprovementSubmission(h.run, job, { ...report(job), status: 'rejected' }),
    /current reviewed/,
  );
});

test('packaged job and result commands work from a relocated workspace with no Python dependency', async () => {
  const h = harness();
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-h2-'));
  const runPath = path.join(directory, 'run.json');
  const jobPath = path.join(directory, 'job.json');
  const reportPath = path.join(directory, 'report.json');
  await writeFile(runPath, JSON.stringify(h.run));
  const helper = fileURLToPath(
    new URL('../plugins/hakengaisya/runtime/scripts/workflow.ts', import.meta.url),
  );
  const call = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [helper, ...args], { cwd: directory, encoding: 'utf8' }),
    );
  const job = call('harness2-job', runPath, 'handover');
  await writeFile(jobPath, JSON.stringify(job));
  h.event('start', { actor_context: 'worker' });
  await writeFile(runPath, JSON.stringify(h.run));
  await writeFile(reportPath, JSON.stringify(report(job)));
  assert.equal(call('harness2-result', runPath, jobPath, reportPath).event.type, 'submit');
  assert.equal(JSON.parse(await readFile(runPath, 'utf8')).packets.handover.status, 'running');
});
