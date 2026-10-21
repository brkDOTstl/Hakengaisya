import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyEvent,
  applyEvents,
  chooseStructure,
  createRun,
  nextActions,
} from '../lib/workflow.mjs';

const software = JSON.parse(
  await readFile(new URL('../templates/software-delivery.json', import.meta.url)),
);
const product = JSON.parse(
  await readFile(new URL('../templates/product-design.json', import.meta.url)),
);
const brief = (overrides = {}) => ({
  run_id: 'synthetic-run',
  objective: 'Implement and verify a synthetic integer sum.',
  domain: 'software-engineering',
  difficulty: 'standard',
  independent_streams: 1,
  constraints: ['Synthetic test only.'],
  acceptance: ['Two plus three returns five.'],
  lead_context: 'host',
  evidence_kind: 'simulation',
  reference_workflow: true,
  ...overrides,
});
function harness(overrides = {}, template = software) {
  let run = createRun(template, brief(overrides));
  let seq = 0;
  const event = (packet, type, fields = {}) => {
    run = applyEvent(run, {
      id: `event-${++seq}`,
      expected_revision: run.revision,
      packet_id: packet,
      attempt: run.packets[packet].attempt,
      type,
      actor_context: 'host',
      ...fields,
    });
    return run;
  };
  function assign(id, fields = {}) {
    return event(id, 'assign', {
      assignment: {
        owner_context: `worker-${id}`,
        reviewer_context: `reviewer-${id}`,
        contributor_contexts: run.packets[id].contributor_roles.map(
          (role) => `contributor-${role}`,
        ),
        writes: [],
        ...fields,
      },
    });
  }
  function submit(id) {
    return event(id, 'submit', {
      actor_context: run.packets[id].assignment.owner_context,
      outputs: run.packets[id].required_outputs.map((output) => ({
        id: output,
        reference: `fixture:${output}`,
        summary: 'Synthetic output.',
      })),
      evidence: [
        {
          reference: 'fixture:check',
          summary: 'Synthetic evidence reference; no real execution claim.',
        },
      ],
    });
  }
  function review(id, decision = 'accepted') {
    return event(id, 'review', {
      actor_context: run.packets[id].assignment.reviewer_context,
      decision,
      task_checks:
        id === 'handover'
          ? run.acceptance.map((check, index) => ({
              index,
              result: 'pass',
              evidence_reference: 'fixture:user-check',
              note: 'Synthetic user acceptance.',
            }))
          : [],
      checks: run.packets[id].checks.map((check, index) => ({
        index,
        result: decision === 'accepted' ? 'pass' : index === 0 ? 'fail' : 'pass',
        evidence_reference: 'fixture:check',
        note: 'Synthetic gate decision.',
      })),
    });
  }
  function finish(id) {
    assign(id);
    event(id, 'start', { actor_context: run.packets[id].assignment.owner_context });
    submit(id);
    review(id);
  }
  return {
    get run() {
      return run;
    },
    event,
    assign,
    submit,
    review,
    finish,
  };
}

test('structure choice avoids a company for trivial work and selects technical product discovery', () => {
  assert.equal(chooseStructure(brief({ difficulty: 'routine' })).mode, 'direct');
  assert.equal(chooseStructure(brief()).mode, 'compact');
  assert.equal(chooseStructure(brief({ independent_streams: 2 })).mode, 'company');
  assert.equal(
    chooseStructure(brief({ difficulty: 'routine', request_company: true })).mode,
    'compact',
  );
  assert.equal(
    chooseStructure(brief({ domain: 'technical-product-design', product_discovery: true }))
      .template_id,
    'product-design',
  );
  assert.throws(() => chooseStructure(brief({ domain: 'artistic-production' })), /technical/);
});

test('only accepted predecessors unlock work and pending artifact claims are unavailable', () => {
  const h = harness();
  assert.deepEqual(
    nextActions(h.run).ready.map((item) => item.id),
    ['scope'],
  );
  h.assign('design');
  assert.throws(
    () => h.event('design', 'start', { actor_context: 'worker-design' }),
    /dependency-ready/,
  );
  h.assign('scope');
  h.event('scope', 'start', { actor_context: 'worker-scope' });
  h.submit('scope');
  assert.equal(h.run.artifacts.accepted_scope, undefined);
  h.review('scope');
  assert.deepEqual(
    nextActions(h.run).ready.map((item) => item.id),
    ['design', 'environment'],
  );
  assert.equal(h.run.artifacts.accepted_scope.attempt, 1);
});

test('actual context identity prevents role renaming from allowing self-review', () => {
  const h = harness();
  assert.throws(
    () => h.assign('scope', { owner_context: 'same-agent', reviewer_context: 'same-agent' }),
    /differ/,
  );
  h.finish('scope');
  assert.throws(
    () => h.assign('implementation', { contributor_contexts: ['reviewer-implementation'] }),
    /differ/,
  );
});

test('independent verification cannot reuse the implementation owner context', () => {
  const h = harness();
  ['scope', 'design', 'environment', 'implementation'].forEach(h.finish);
  h.assign('verification', { owner_context: 'worker-implementation' });
  assert.throws(
    () => h.event('verification', 'start', { actor_context: 'worker-implementation' }),
    /Independent/,
  );
});

test('overlapping writable directories serialize concurrent workers on Windows', () => {
  const h = harness({ difficulty: 'complex' });
  h.finish('scope');
  h.assign('design', { writes: ['SRC/module'] });
  h.assign('environment', { writes: ['src/module/settings.json'] });
  h.event('design', 'start', { actor_context: 'worker-design' });
  assert.throws(
    () => h.event('environment', 'start', { actor_context: 'worker-environment' }),
    /overlap/,
  );
  assert.throws(() => h.assign('implementation', { writes: ['../outside'] }), /relative/);
});

test('same-context parallel work and compact concurrency are bounded', () => {
  const h = harness();
  h.finish('scope');
  h.assign('design');
  h.assign('environment');
  h.event('design', 'start', { actor_context: 'worker-design' });
  assert.throws(
    () => h.event('environment', 'start', { actor_context: 'worker-environment' }),
    /Parallel/,
  );
  const company = harness({ difficulty: 'complex' });
  company.finish('scope');
  company.assign('design', { owner_context: 'one-worker' });
  company.assign('environment', { owner_context: 'one-worker' });
  company.event('design', 'start', { actor_context: 'one-worker' });
  assert.throws(
    () => company.event('environment', 'start', { actor_context: 'one-worker' }),
    /two active/,
  );
});

test('submission requires complete outputs and an independent evidence-backed gate', () => {
  const h = harness();
  h.assign('scope');
  h.event('scope', 'start', { actor_context: 'worker-scope' });
  assert.throws(
    () => h.event('scope', 'submit', { actor_context: 'worker-scope', outputs: [], evidence: [] }),
    /required output/,
  );
  h.submit('scope');
  assert.throws(
    () =>
      h.event('scope', 'review', {
        actor_context: 'worker-scope',
        decision: 'accepted',
        checks: [],
      }),
    /reviewer/,
  );
  const checks = h.run.packets.scope.checks.map((check, index) => ({
    index,
    result: 'unverified',
    evidence_reference: 'fixture:gap',
    note: 'Not checked.',
  }));
  assert.throws(
    () =>
      h.event('scope', 'review', { actor_context: 'reviewer-scope', decision: 'accepted', checks }),
    /cannot pass/,
  );
  assert.equal(h.run.packets.scope.status, 'in_review');
});

test('verification rejection preserves history and invalidates implementation and downstream claims', () => {
  const h = harness();
  ['scope', 'design', 'environment', 'implementation'].forEach(h.finish);
  h.assign('verification');
  h.event('verification', 'start', { actor_context: 'worker-verification' });
  h.submit('verification');
  h.review('verification', 'rejected');
  assert.equal(h.run.packets.implementation.attempt, 2);
  assert.equal(h.run.packets.verification.attempt, 2);
  assert.equal(h.run.packets.implementation.history[0].status, 'accepted');
  assert.equal(h.run.packets.verification.history[0].review.decision, 'rejected');
  assert.equal(h.run.artifacts.implementation, undefined);
  assert.ok(h.run.artifacts.architecture_proposal);
  assert.deepEqual(
    nextActions(h.run).ready.map((item) => item.id),
    ['implementation'],
  );
  assert.throws(
    () =>
      h.event('implementation', 'submit', { attempt: 1, actor_context: 'worker-implementation' }),
    /Stale packet/,
  );
});

test('an upstream revision invalidates all affected accepted artifacts and final completion', () => {
  const h = harness();
  ['scope', 'design', 'environment', 'implementation', 'verification', 'handover'].forEach(
    h.finish,
  );
  assert.equal(nextActions(h.run).complete, true);
  h.event('scope', 'reopen', { reason: 'The synthetic requirement changed.' });
  assert.equal(nextActions(h.run).complete, false);
  assert.deepEqual(h.run.artifacts, {});
  assert.ok(Object.values(h.run.packets).every((packet) => packet.status === 'pending'));
});

test('stale revisions and duplicate event identifiers do not mutate the current state', () => {
  const h = harness();
  h.assign('scope');
  const before = JSON.stringify(h.run);
  assert.throws(
    () => applyEvent(h.run, { ...h.run.journal[0].event, expected_revision: 0 }),
    /Stale run/,
  );
  assert.throws(
    () => applyEvent(h.run, { ...h.run.journal[0].event, expected_revision: h.run.revision }),
    /already recorded/,
  );
  assert.equal(JSON.stringify(h.run), before);
});

test('passing generic handover checks alone cannot establish user acceptance', () => {
  const h = harness();
  ['scope', 'design', 'environment', 'implementation', 'verification'].forEach(h.finish);
  h.assign('handover');
  h.event('handover', 'start', { actor_context: 'worker-handover' });
  h.submit('handover');
  const checks = h.run.packets.handover.checks.map((check, index) => ({
    index,
    result: 'pass',
    evidence_reference: 'fixture:handover',
    note: 'Synthetic check.',
  }));
  assert.throws(
    () =>
      h.event('handover', 'review', {
        actor_context: 'reviewer-handover',
        decision: 'accepted',
        checks,
      }),
    /every user/,
  );
  assert.throws(
    () =>
      h.event('handover', 'review', {
        actor_context: 'reviewer-handover',
        decision: 'accepted',
        checks,
        task_checks: [
          {
            index: 0,
            result: 'unverified',
            evidence_reference: 'fixture:gap',
            note: 'No behavioral evidence.',
          },
        ],
      }),
    /prevents completion/,
  );
  assert.equal(nextActions(h.run).complete, false);
});

test('retry and dispatch ceilings stop endless rework', () => {
  const h = harness({ limits: { max_attempts: 1 } });
  h.assign('scope');
  h.event('scope', 'start', { actor_context: 'worker-scope' });
  h.submit('scope');
  h.review('scope', 'rejected');
  assert.throws(
    () => h.event('scope', 'start', { actor_context: 'worker-scope' }),
    /limit reached/,
  );
  const dispatch = harness({ limits: { max_dispatches: 1 } });
  dispatch.finish('scope');
  dispatch.assign('design');
  assert.throws(
    () => dispatch.event('design', 'start', { actor_context: 'worker-design' }),
    /limit reached/,
  );
});

test('a blocker keeps the packet open and explicit lead resolution restores its previous state', () => {
  const h = harness();
  h.assign('scope');
  h.event('scope', 'start', { actor_context: 'worker-scope' });
  h.event('scope', 'block', { actor_context: 'worker-scope', reason: 'Missing synthetic input.' });
  assert.equal(nextActions(h.run).blocked.length, 1);
  assert.equal(nextActions(h.run).complete, false);
  h.event('scope', 'resume', { reason: 'Synthetic input is now available.' });
  assert.equal(h.run.packets.scope.status, 'running');
});

test('the technical product reference reaches handover with explicit evidence gates', () => {
  const h = harness({ domain: 'technical-product-design', product_discovery: true }, product);
  ['framing', 'research', 'feasibility', 'concept', 'prototype', 'evaluation', 'handover'].forEach(
    h.finish,
  );
  assert.equal(nextActions(h.run).complete, true);
  assert.equal(h.run.template_id, 'product-design');
});

test('CLI persists a run and event, rejects stale updates, and protects an existing file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-workflow-'));
  const run = path.join(directory, 'run.json');
  const input = path.join(directory, 'brief.json');
  const action = path.join(directory, 'event.json');
  await writeFile(input, JSON.stringify(brief()));
  const cli = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, ['scripts/workflow.mjs', ...args], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  assert.equal(cli('create', run, input).revision, 0);
  assert.throws(() => cli('create', run, input));
  await writeFile(
    action,
    JSON.stringify({
      id: 'assign-scope',
      expected_revision: 0,
      type: 'assign',
      packet_id: 'scope',
      attempt: 1,
      actor_context: 'host',
      assignment: {
        owner_context: 'native-worker',
        reviewer_context: 'host',
        contributor_contexts: [],
        writes: [],
      },
    }),
  );
  assert.equal(cli('event', run, action).revision, 1);
  assert.throws(() => cli('event', run, action));
  assert.equal(cli('next', run).revision, 1);
  await writeFile(
    action,
    JSON.stringify([
      {
        id: 'start-scope',
        expected_revision: 1,
        type: 'start',
        packet_id: 'scope',
        attempt: 1,
        actor_context: 'native-worker',
      },
      {
        id: 'block-scope',
        type: 'block',
        packet_id: 'scope',
        attempt: 1,
        actor_context: 'native-worker',
        reason: 'Synthetic missing input.',
      },
    ]),
  );
  const batched = cli('event', run, action);
  assert.equal(batched.revision, 3);
  assert.equal(batched.blocked.length, 1);
  const nested = path.join(directory, 'deeper', 'runs', 'created.json');
  assert.equal(cli('create', nested, input).run_file, nested);
});

test('event batches apply atomically in order and record the controller clock', () => {
  const h = harness();
  const before = JSON.stringify(h.run);
  const assign = {
    id: 'batch-assign',
    expected_revision: h.run.revision,
    type: 'assign',
    packet_id: 'scope',
    attempt: 1,
    actor_context: 'host',
    assignment: {
      owner_context: 'worker-scope',
      reviewer_context: 'host',
      contributor_contexts: [],
      writes: [],
    },
  };
  const start = {
    id: 'batch-start',
    type: 'start',
    packet_id: 'scope',
    attempt: 1,
    actor_context: 'worker-scope',
  };
  assert.throws(
    () => applyEvents(h.run, [{ ...assign, expected_revision: undefined }, start]),
    /first event/,
  );
  assert.throws(
    () => applyEvents(h.run, [assign, { ...start, actor_context: 'someone-else' }]),
    /assigned owner/,
  );
  assert.throws(() => applyEvents(h.run, []), /one or more/);
  assert.equal(JSON.stringify(h.run), before);
  const run = applyEvents(h.run, [assign, start], '2026-01-01T00:00:00.000Z');
  assert.equal(run.revision, 2);
  assert.equal(run.packets.scope.status, 'running');
  assert.deepEqual(
    run.journal.map((entry) => [entry.revision, entry.recorded_at, entry.event.expected_revision]),
    [
      [1, '2026-01-01T00:00:00.000Z', 0],
      [2, '2026-01-01T00:00:00.000Z', 1],
    ],
  );
  assert.match(applyEvent(h.run, assign).journal[0].recorded_at, /^\d{4}-\d{2}-\d{2}T/);
});
