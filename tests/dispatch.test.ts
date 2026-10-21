import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareDispatch, prepareReview } from '../lib/dispatch.ts';
import type {
  AssignEvent,
  EventType,
  ReasonEvent,
  ReviewDecision,
  ReviewEvent,
  SubmitEvent,
  WorkflowEvent,
  WorkItemInput,
} from '../lib/types.ts';
import { applyEvent, createRun, nextActions } from '../lib/workflow.ts';

type EventFields = Partial<
  Omit<AssignEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'> &
    Omit<SubmitEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'> &
    Omit<ReviewEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'> &
    Omit<ReasonEvent, 'id' | 'packet_id' | 'expected_revision' | 'type'>
>;

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
  acceptance: ['Behavior works.'],
  ...fields,
});
function harness({ conflicts = false, cap = 2 }: { conflicts?: boolean; cap?: number } = {}) {
  let run = createRun(null, {
    run_id: 'dispatch-fixture',
    lead_context: 'host',
    domain: 'software-engineering',
    evidence_kind: 'simulation',
    objective: 'Deliver integrated behavior.',
    constraints: ['Keep work local.'],
    acceptance: ['Both components work together.'],
    planning_limits: { max_parallel: cap },
    work_items: [
      work('a'),
      work('b', { writes: conflicts ? ['SRC/a/sub'] : ['src/b'] }),
      work('integrated', {
        depends_on: ['a', 'b'],
        inputs: ['a_artifact', 'b_artifact'],
        writes: ['dist'],
      }),
    ],
  });
  let sequence = 0;
  const event = (id: string, type: EventType, fields: EventFields = {}) => {
    run = applyEvent(run, {
      id: `event-${++sequence}`,
      packet_id: id,
      expected_revision: run.revision,
      attempt: run.packets[id].attempt,
      actor_context: 'host',
      type,
      ...fields,
    } as WorkflowEvent);
  };
  const assign = (id: string) => {
    const writes = run.packets[id].declared_writes;
    assert.ok(writes);
    event(id, 'assign', {
      assignment: {
        owner_context: `worker-${id}`,
        reviewer_context: 'host',
        contributor_contexts: [],
        writes,
      },
    });
  };
  const start = (id: string) => {
    const assignment = run.packets[id].assignment;
    assert.ok(assignment);
    event(id, 'start', { actor_context: assignment.owner_context });
  };
  const submit = (id: string) => {
    const assignment = run.packets[id].assignment;
    assert.ok(assignment);
    event(id, 'submit', {
      actor_context: assignment.owner_context,
      outputs: run.packets[id].required_outputs.map((id) => ({
        id,
        reference: `fixture:${id}`,
        summary: 'Observed fixture output.',
      })),
      evidence: [{ reference: 'fixture:check', summary: 'Synthetic evidence only.' }],
    });
  };
  const review = (id: string, decision: ReviewDecision = 'accepted') =>
    event(id, 'review', {
      decision,
      checks: run.packets[id].checks.map((_text, index) => ({
        index,
        result: decision === 'accepted' ? 'pass' : 'fail',
        evidence_reference: 'fixture:check',
        note: 'Synthetic check.',
      })),
      task_checks:
        id === 'handover'
          ? [
              {
                index: 0,
                result: 'pass',
                evidence_reference: 'fixture:integration',
                note: 'Synthetic user acceptance.',
              },
            ]
          : [],
    });
  return {
    get run() {
      return run;
    },
    event,
    assign,
    start,
    submit,
    review,
    finish(id: string) {
      assign(id);
      start(id);
      submit(id);
      review(id);
    },
  };
}

test('dispatch handoff contains the current task inputs and contract without the global transcript', () => {
  const h = harness();
  h.assign('work_a');
  h.run.journal.push({ debug_only: 'UNRELATED_FULL_TRANSCRIPT' } as never);
  h.run.external_inputs.unrelated = 'UNRELATED_PRIVATE_CONTEXT';
  const contract = prepareDispatch(h.run, 'work_a');
  assert.equal(contract.attempt, 1);
  assert.equal(contract.expected_revision, h.run.revision);
  assert.equal(contract.actor_context, 'worker-work_a');
  assert.deepEqual(contract.writes, ['src/a']);
  assert.deepEqual(contract.inputs, [{ id: 'task_brief', external: h.run.objective }]);
  assert.ok(!JSON.stringify(contract).includes('UNRELATED_'));
  contract.constraints.push('Changed clone.');
  assert.equal(h.run.constraints.length, 1);
});

test('unassigned work and dependency-pending integration cannot produce a dispatch handoff', () => {
  const h = harness();
  assert.throws(() => prepareDispatch(h.run, 'work_a'), /assigned/);
  h.assign('handover');
  assert.throws(() => prepareDispatch(h.run, 'handover'), /dependency-ready/);
  h.finish('work_a');
  assert.throws(() => prepareDispatch(h.run, 'handover'), /dependency-ready/);
  h.finish('work_b');
  const contract = prepareDispatch(h.run, 'handover');
  assert.deepEqual(
    contract.inputs.map((input) => input.artifact?.reference),
    ['fixture:a_artifact', 'fixture:b_artifact'],
  );
});

test('next actions distinguish dependency-ready work from work that can actually start now', () => {
  const h = harness();
  h.assign('work_a');
  h.assign('work_b');
  assert.equal(nextActions(h.run).dispatchable.length, 2);
  h.start('work_a');
  assert.deepEqual(
    nextActions(h.run).dispatchable.map((item) => item.id),
    ['work_b'],
  );
  const limited = harness({ cap: 1 });
  limited.assign('work_a');
  limited.assign('work_b');
  assert.equal(nextActions(limited.run).dispatchable.length, 1);
  assert.equal(nextActions(limited.run).revision, limited.run.revision);
  limited.start('work_a');
  assert.equal(nextActions(limited.run).ready.length, 1);
  assert.equal(nextActions(limited.run).dispatchable.length, 0);
  assert.throws(() => prepareDispatch(limited.run, 'work_b'), /Parallel/);
});

test('dispatch enforces write conflicts and retry fit before preparing another worker prompt', () => {
  const h = harness({ conflicts: true });
  h.assign('work_a');
  h.assign('work_b');
  h.start('work_a');
  assert.equal(nextActions(h.run).dispatchable.length, 0);
  assert.throws(() => prepareDispatch(h.run, 'work_b'), /Parallel|overlap/);
  const rejected = harness();
  rejected.assign('work_a');
  rejected.start('work_a');
  rejected.submit('work_a');
  rejected.review('work_a', 'rejected');
  assert.throws(() => prepareDispatch(rejected.run, 'work_a'), /renewed assignment/);
  assert.ok(!nextActions(rejected.run).dispatchable.some((item) => item.id === 'work_a'));
});

test('review handoff needs a real submission and preserves independent and final acceptance checks', () => {
  const h = harness();
  h.assign('work_a');
  assert.throws(() => prepareReview(h.run, 'work_a'), /current submitted/);
  h.start('work_a');
  h.submit('work_a');
  const review = prepareReview(h.run, 'work_a');
  assert.equal(review.actor_context, 'host');
  assert.deepEqual(review.writes, []);
  assert.equal(review.result.attempt, 1);
  assert.equal(review.task_acceptance.length, 0);
  h.review('work_a');
  h.finish('work_b');
  h.assign('handover');
  h.start('handover');
  h.submit('handover');
  assert.deepEqual(prepareReview(h.run, 'handover').task_acceptance, h.run.acceptance);
  const handoverAssignment = h.run.packets.handover.assignment;
  assert.ok(handoverAssignment);
  handoverAssignment.reviewer_context = 'worker-handover';
  assert.throws(() => prepareReview(h.run, 'handover'), /independent/);
});

test('packaged dispatch and review CLI work with a relocated run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-dispatch-'));
  const filename = path.join(directory, 'run.json');
  const helper = fileURLToPath(
    new URL('../plugins/hakengaisya/runtime/scripts/workflow.ts', import.meta.url),
  );
  const call = (command: string) =>
    JSON.parse(
      execFileSync(process.execPath, [helper, command, filename, 'work_a'], {
        cwd: directory,
        encoding: 'utf8',
      }),
    );
  const h = harness();
  h.assign('work_a');
  await writeFile(filename, JSON.stringify(h.run));
  assert.equal(call('dispatch').actor_context, 'worker-work_a');
  h.start('work_a');
  h.submit('work_a');
  await writeFile(filename, JSON.stringify(h.run));
  assert.equal(call('review').role, 'review');
});
