import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupervision } from '../lib/supervision.mjs';
import { createRun, applyEvent, nextActions } from '../lib/workflow.mjs';
import { prepareDispatch, prepareReview } from '../lib/dispatch.mjs';
import { planWork } from '../lib/planning.mjs';

const work = (id, fields = {}) => ({ id, objective: 'Deliver ' + id, task_type: 'implementation', difficulty: 'routine', skills: ['implementation'], depends_on: [], inputs: ['task_brief'], writes: ['src/' + id], outputs: [id + '_artifact'], acceptance: ['The requested behavior is verified.'], ...fields });
function brief() {
  return { run_id: 'hierarchy-fixture', objective: 'Deliver integrated technical behavior.', domain: 'software-engineering', lead_context: 'host', evidence_kind: 'simulation', constraints: [], acceptance: ['The integrated result meets the request.'], limits: { max_attempts: 2 }, planning_limits: { max_parallel: 2, max_workers: 3, overhead_seconds: 0, overhead_cost_usd: 0, context_startup_seconds: 0, context_startup_cost_usd: 0 }, reporting_lines: [{ supervisor_context: 'host', subordinate_context: 'lead-a' }, { supervisor_context: 'host', subordinate_context: 'lead-b' }, { supervisor_context: 'lead-a', subordinate_context: 'employee-a' }, { supervisor_context: 'lead-b', subordinate_context: 'employee-b' }], work_items: [work('component', { supervisor_context: 'lead-a' }), work('integrated', { depends_on: ['component'], inputs: ['component_artifact'], supervisor_context: 'host' })] };
}
function harness(b = brief()) {
  let run = createRun(null, b); let sequence = 0;
  const event = (id, type, actor, fields = {}) => { run = applyEvent(run, { id: 'hierarchy-' + ++sequence, expected_revision: run.revision, packet_id: id, attempt: run.packets[id].attempt, actor_context: actor, type, ...fields }); };
  const assign = (id, supervisor, owner, reviewer = supervisor) => event(id, 'assign', supervisor, { assignment: { owner_context: owner, reviewer_context: reviewer, contributor_contexts: [], writes: run.packets[id].declared_writes } });
  const start = id => event(id, 'start', run.packets[id].assignment.owner_context);
  const submit = id => event(id, 'submit', run.packets[id].assignment.owner_context, { outputs: run.packets[id].required_outputs.map(id => ({ id, reference: 'fixture:' + id, summary: 'Synthetic delivery evidence.' })), evidence: [{ reference: 'fixture:check', summary: 'Synthetic checks.' }] });
  const review = (id, supervisor, decision = 'accepted') => event(id, 'review', supervisor, { decision, checks: [{ index: 0, result: decision === 'accepted' ? 'pass' : 'fail', evidence_reference: 'fixture:check', note: 'Synthetic review.' }], task_checks: id === 'handover' ? [{ index: 0, result: 'pass', evidence_reference: 'fixture:final', note: 'Synthetic final check.' }] : [] });
  return { get run() { return run; }, event, assign, start, submit, review };
}

test('reporting hierarchy rejects cycles, multiple parents and disconnected authorities', () => {
  const line = (child, parent) => ({ subordinate_context: child, supervisor_context: parent });
  assert.throws(() => createSupervision('host', [line('a', 'b'), line('b', 'a')]), /Cyclic/);
  assert.throws(() => createSupervision('host', [line('a', 'host'), line('a', 'b')]), /one direct supervisor/);
  assert.throws(() => createSupervision('host', [line('a', 'missing')]), /reach the root/);
  assert.throws(() => createSupervision('host', [line('host', 'a')]), /Root/);
});

test('a small task binds one direct supervisor without adding administrative packets', () => {
  const b = brief(); delete b.reporting_lines; b.work_items = [work('small')];
  const h = harness(b); h.assign('handover', 'host', 'employee');
  assert.equal(h.run.schema_version, 2); assert.deepEqual(Object.keys(h.run.packets), ['handover']);
  assert.deepEqual(h.run.supervision.reporting_lines, [{ subordinate_context: 'employee', supervisor_context: 'host' }]);
  assert.equal(prepareDispatch(h.run, 'handover').supervision.acceptance_authority, 'host');
});

test('only the scoped direct supervisor may assign or choose the acceptance authority', () => {
  const h = harness(); const before = JSON.stringify(h.run);
  assert.throws(() => h.assign('work_component', 'host', 'employee-a'), /responsible direct supervisor/);
  assert.throws(() => h.assign('work_component', 'lead-b', 'employee-a'), /responsible direct supervisor/);
  assert.throws(() => h.assign('work_component', 'lead-a', 'employee-a', 'independent-peer'), /Acceptance belongs/);
  assert.throws(() => h.assign('work_component', 'lead-a', 'employee-b'), /existing reporting line/);
  assert.equal(JSON.stringify(h.run), before);
  h.assign('work_component', 'lead-a', 'employee-a');
  assert.equal(h.run.packets.work_component.assignment.supervisor_context, 'lead-a');
});

test('peer or higher-level review cannot bypass the responsible direct supervisor', () => {
  const h = harness(); h.assign('work_component', 'lead-a', 'employee-a'); h.start('work_component'); h.submit('work_component');
  assert.equal(h.run.packets.work_component.result.reports_to, 'lead-a');
  assert.equal(prepareReview(h.run, 'work_component').supervision.reports_to, 'lead-a');
  for (const actor of ['employee-a', 'employee-b', 'lead-b', 'host']) assert.throws(() => h.review('work_component', actor), /assigned independent reviewer/);
  h.review('work_component', 'lead-a'); assert.equal(h.run.packets.work_component.status, 'accepted');
});

test('accepted subordinate work does not accept the supervisor delivery to the root', () => {
  const h = harness(); h.assign('work_component', 'lead-a', 'employee-a'); h.start('work_component'); h.submit('work_component'); h.review('work_component', 'lead-a');
  assert.equal(nextActions(h.run).complete, false); assert.equal(h.run.packets.handover.status, 'pending');
  h.assign('handover', 'host', 'lead-a'); h.start('handover'); h.submit('handover');
  assert.equal(h.run.packets.handover.status, 'in_review');
  assert.throws(() => h.review('handover', 'lead-a'), /assigned independent reviewer/);
  h.review('handover', 'host'); assert.equal(nextActions(h.run).complete, true);
});

test('rejected subordinate work blocks upward integration and stays with its responsible supervisor', () => {
  const h = harness(); h.assign('work_component', 'lead-a', 'employee-a'); h.start('work_component'); h.submit('work_component'); h.review('work_component', 'lead-a', 'rejected');
  assert.equal(h.run.packets.work_component.attempt, 2);
  assert.equal(h.run.packets.work_component.history[0].review.reviewer_context, 'lead-a');
  h.assign('handover', 'host', 'lead-a'); assert.throws(() => prepareDispatch(h.run, 'handover'), /dependency-ready/);
  assert.throws(() => h.assign('work_component', 'host', 'employee-a'), /responsible direct supervisor/);
});

test('blocker resolution follows the supervision chain and excludes sibling management', () => {
  const h = harness(); h.assign('work_component', 'lead-a', 'employee-a'); h.start('work_component');
  h.event('work_component', 'block', 'employee-a', { reason: 'A synthetic environment issue.' });
  assert.throws(() => h.event('work_component', 'resume', 'lead-b', { reason: 'Unrelated manager.' }), /supervision chain/);
  h.event('work_component', 'resume', 'lead-a', { reason: 'The local issue is resolved.' });
  assert.throws(() => h.event('work_component', 'reopen', 'lead-b', { reason: 'Unrelated scope.' }), /supervision chain/);
  h.event('work_component', 'reopen', 'host', { reason: 'Root requests a scope correction.' });
  assert.equal(h.run.packets.work_component.status, 'pending');
});

test('unknown authorities and non-root final acceptance cannot be created', () => {
  const b = brief(); b.work_items[0].supervisor_context = 'unknown';
  assert.throws(() => createRun(null, b), /rooted reporting/);
  const nested = brief(); nested.work_items[1].supervisor_context = 'lead-a';
  assert.throws(() => createRun(null, nested), /root supervisor/);
});

function worker(id, contextId) {
  return { id, model_id: 'fixture-' + id, route: 'fixture', available: true, ...(contextId ? { context_id: contextId } : {}), profiles: [{ model_id: 'fixture-' + id, route: 'fixture', effort: 'unknown', evaluation_kind: 'simulation', domain: 'software-engineering', task_type: 'implementation', difficulty: 'routine', skill: 'implementation', observed_cost_usd: 0.01, observed_wall_seconds: 5, dimensions: Object.fromEntries(['D1', 'D2', 'D6'].map(key => [key, { score: 8, support: 'supported-peer-observations' }])) }] };
}

test('cost planning preserves reporting lines even when reusing one worker would cost less', () => {
  const b = brief(); b.planning_limits.context_startup_cost_usd = 0.1;
  const plan = planWork(b, [worker('employee', 'employee-a'), worker('other-team', 'employee-b'), worker('lead', 'lead-a')]);
  assert.equal(plan.status, 'planned'); assert.equal(plan.organization.length, 2);
  assert.equal(plan.assignments[0].supervisor_context, 'lead-a');
  assert.equal(plan.assignments[1].supervisor_context, 'host');
  assert.ok(plan.exclusions.some(item => item.worker_id === 'other-team' && item.reason === 'reporting-line-incompatible'));
  const unbound = planWork(b, [worker('unbound-a'), worker('unbound-b')]);
  assert.equal(unbound.organization.length, 2);
  assert.equal(planWork({ ...b, planning_limits: { ...b.planning_limits, max_workers: 1 } }, [worker('unbound-a')]).status, 'constraints-unmet');
});
