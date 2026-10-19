import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeDei, agentReview } from '../lib/participation.mjs';
import { planWork } from '../lib/planning.mjs';
import { createRun, applyEvent, nextActions } from '../lib/workflow.mjs';
import { prepareReview } from '../lib/dispatch.mjs';

const unit = (id, depends_on = [], fields = {}) => ({ id, objective: 'Produce ' + id, task_type: 'implementation', difficulty: 'routine', skills: ['implementation'], depends_on, inputs: ['task_brief'], writes: ['src/' + id], outputs: [id + '_output'], acceptance: ['The synthetic behavior passes.'], ...fields });
const brief = (fields = {}) => ({ run_id: 'fixture-dei', objective: 'Exercise model participation without invoking models.', domain: 'software-engineering', lead_context: 'host', evidence_kind: 'simulation', acceptance: ['The synthetic integrated result passes.'], constraints: [], work_items: [unit('core'), unit('integrate', ['core'])], planning_limits: { max_workers: 3, max_parallel: 2, overhead_seconds: 0, overhead_cost_usd: 0, context_startup_seconds: 0, context_startup_cost_usd: 0 }, ...fields });
function worker(id, cost = 0.01, fields = {}) {
  return { id, model_id: 'fixture-' + id, route: 'fixture-route', available: true, profiles: [{ model_id: 'fixture-' + id, route: 'fixture-route', effort: 'unknown', evaluation_kind: 'simulation', domain: 'software-engineering', task_type: 'implementation', difficulty: 'routine', skill: 'implementation', observed_cost_usd: cost, observed_wall_seconds: 10, dimensions: Object.fromEntries(['D1', 'D2', 'D6'].map(key => [key, { score: 8, support: 'supported-peer-observations' }])) }], ...fields };
}
const policy = { enabled: true, model_ids: ['fixture-A', 'fixture-B'] };
function harness(fields = {}) {
  let run = createRun(null, brief({ dei: policy, ...fields })); let seq = 0;
  const event = (packet_id, type, fields = {}) => {
    run = applyEvent(run, { id: 'fixture-event-' + ++seq, expected_revision: run.revision, packet_id, attempt: run.packets[packet_id].attempt, actor_context: 'host', type, ...fields });
    return run;
  };
  const assign = (packet, model = 'A') => event(packet, 'assign', { assignment: { owner_context: 'worker-' + model, reviewer_context: 'host', contributor_contexts: [], writes: run.packets[packet].declared_writes, model_id: 'fixture-' + model, route: 'fixture-route' } });
  const start = packet => event(packet, 'start', { actor_context: run.packets[packet].assignment.owner_context });
  const submit = packet => event(packet, 'submit', { actor_context: run.packets[packet].assignment.owner_context, outputs: run.packets[packet].required_outputs.map(id => ({ id, reference: 'fixture:' + id, summary: 'Synthetic deliverable.' })), evidence: [{ reference: 'fixture:check-' + seq, summary: 'Synthetic work evidence, not a live invocation.' }] });
  const review = (packet, decision = 'accepted') => event(packet, 'review', { decision, checks: [{ index: 0, result: decision === 'accepted' ? 'pass' : 'fail', evidence_reference: 'fixture:gate', note: 'Synthetic gate result.' }], task_checks: packet === 'handover' ? [{ index: 0, result: 'pass', evidence_reference: 'fixture:task', note: 'Synthetic task acceptance.' }] : [] });
  const finish = (packet, model) => { assign(packet, model); start(packet); submit(packet); review(packet); };
  return { get run() { return run; }, event, assign, start, submit, review, finish };
}

test('DEI is opt-in with a strict unique model roster', () => {
  assert.deepEqual(normalizeDei(), { enabled: false, model_ids: [] });
  for (const invalid of [null, true, { enabled: 'true' }, { enabled: true }, { enabled: true, model_ids: ['A', 'A'] }, { enabled: true, model_ids: [' A'] }, { enabled: true, model_ids: ['A'], waiver: true }]) assert.throws(() => normalizeDei(invalid), /DEI/);
  assert.throws(() => createRun(null, { ...brief({ dei: policy }), work_items: undefined }), /task-first/);
});

test('disabled DEI preserves cheapest-adequate selection and applies no score or tag', () => {
  const workers = [worker('A'), worker('B', 0.5)];
  const before = planWork(brief(), workers); const off = planWork(brief({ dei: { ...policy, enabled: false } }), workers);
  assert.deepEqual(off, before); assert.ok(off.assignments.every(item => item.model_id === 'fixture-A'));
  const h = harness({ dei: { enabled: false } }); h.finish('work_core', 'A'); h.finish('handover', 'A');
  assert.equal(agentReview(h.run).dei.status, 'disabled'); assert.equal(agentReview(h.run).dei.score, null); assert.deepEqual(agentReview(h.run).dei.tags, []);
});

test('enabled planning covers every selected model and excludes unselected cheaper models', () => {
  const plan = planWork(brief({ dei: policy }), [worker('A'), worker('B', 0.5), worker('C', 0.001)]);
  assert.equal(plan.status, 'planned'); assert.deepEqual(new Set(plan.assignments.map(item => item.model_id)), new Set(policy.model_ids));
  assert.equal(plan.estimated_cost_usd, 0.51); assert.deepEqual(plan.dei.missing_model_ids, []);
  assert.ok(plan.exclusions.some(item => item.worker_id === 'C' && item.reason === 'outside-selected-dei-roster'));
});

test('coverage matching keeps a restricted model on its only qualified task', () => {
  const hard = worker('B'); hard.profiles[0].difficulty = 'complex';
  const general = worker('A'); general.profiles.push({ ...general.profiles[0], difficulty: 'complex' });
  const b = brief({ dei: policy, work_items: [unit('hard', [], { difficulty: 'complex' }), unit('final', ['hard'])] });
  const plan = planWork(b, [general, hard]); assert.equal(plan.status, 'planned');
  assert.equal(plan.assignments.find(item => item.work_id === 'hard').model_id, 'fixture-B');
});

test('insufficient work, unqualified or unavailable selected models stay unresolved without dummy calls', () => {
  const one = brief({ dei: policy, work_items: [unit('only')] });
  for (const [input, workers] of [[one, [worker('A'), worker('B')]], [brief({ dei: policy }), [worker('A'), worker('B', 0.01, { available: false })]], [brief({ dei: policy }), [worker('A'), worker('B', 0.01, { profiles: [] })]], [brief({ dei: policy }), [worker('A')]]]) {
    const plan = planWork(input, workers); assert.equal(plan.status, 'constraints-unmet'); assert.equal(plan.reason, 'dei-coverage-unresolved');
    assert.deepEqual(plan.assignments, []); assert.ok(plan.dei.missing_model_ids.length); assert.equal(plan.automatic_execution, false);
  }
});

test('DEI does not override budgets, capacity, independent review or tool qualification', () => {
  const b = brief({ dei: policy }); b.planning_limits.budget_usd = 0.1;
  assert.equal(planWork(b, [worker('A'), worker('B', 0.5)]).status, 'constraints-unmet');
  const bounded = brief({ dei: policy }); bounded.planning_limits.max_workers = 1;
  assert.equal(planWork(bounded, [worker('A'), worker('B')]).status, 'constraints-unmet');
  const tools = brief({ dei: policy, work_items: [unit('core', [], { required_tools: ['database'] }), unit('final', ['core'], { required_tools: ['database'] })] });
  assert.equal(planWork(tools, [worker('A'), worker('B')]).status, 'constraints-unmet');
  const h = harness();
  assert.throws(() => h.event('work_core', 'assign', { assignment: { owner_context: 'host', reviewer_context: 'host', contributor_contexts: [], writes: ['src/core'], model_id: 'fixture-A', route: 'fixture-route' } }), /differ/);
});

test('model aliases on multiple routes count once and cannot replace another selected model', () => {
  const alias = worker('alias'); alias.model_id = 'fixture-A'; alias.profiles = worker('A').profiles;
  assert.equal(planWork(brief({ dei: policy }), [worker('A'), alias]).status, 'constraints-unmet');
  const h = harness(); assert.throws(() => h.assign('work_core', 'C'), /selected model/);
});

test('planning, assignment and start alone never earn participation credit', () => {
  const h = harness();
  assert.equal(agentReview(h.run).dei.score, null); assert.deepEqual(agentReview(h.run).dei.missing_model_ids, policy.model_ids);
  h.assign('work_core'); h.start('work_core');
  assert.deepEqual(agentReview(h.run).dei.missing_model_ids, policy.model_ids);
  h.submit('work_core');
  assert.deepEqual(agentReview(h.run).dei.missing_model_ids, ['fixture-B']); assert.equal(agentReview(h.run).dei.status, 'pending');
});

test('a completed omission automatically gives the root manager one point and the policy tag', () => {
  const h = harness(); h.finish('work_core', 'A'); h.assign('handover', 'A'); h.start('handover'); h.submit('handover');
  const preview = prepareReview(h.run, 'handover').agent_review_preview;
  assert.equal(preview.dei.score, 1); assert.equal(agentReview(h.run).dei.score, null);
  h.review('handover');
  const report = nextActions(h.run).agent_review;
  assert.equal(report.manager_context, 'host'); assert.equal(report.dei.status, 'non-compliant'); assert.equal(report.dei.score, 1);
  assert.deepEqual(report.dei.tags, ['dei-non-compliant']); assert.deepEqual(report.dei.missing_model_ids, ['fixture-B']);
  assert.equal(h.run.packets.handover.review.agent_review.dei.score, 1); assert.equal(nextActions(h.run).complete, true);
});

test('all selected models submit work contracts before completed DEI receives ten points', () => {
  const h = harness(); h.finish('work_core', 'A'); h.finish('handover', 'B');
  const report = agentReview(h.run); assert.equal(report.dei.score, 10); assert.deepEqual(report.dei.tags, []);
  assert.equal(report.evidence_kind, 'simulation'); assert.equal(report.dei.models[1].submissions[0].owner_context, 'worker-B');
  assert.ok(report.dei.models.every(model => model.submissions[0].evidence_references.length));
});

test('rejected observed work counts as participation while reopening clears only the final score', () => {
  const h = harness({ limits: { max_attempts: 2 } }); h.assign('work_core', 'B'); h.start('work_core'); h.submit('work_core'); h.review('work_core', 'rejected');
  h.event('work_core', 'assign', { assignment: { owner_context: 'worker-A', reviewer_context: 'host', contributor_contexts: [], writes: ['src/core'], model_id: 'fixture-A', route: 'fixture-route', fit_reason: 'Correct the synthetic rejected result.' } });
  h.start('work_core'); h.submit('work_core'); h.review('work_core'); h.finish('handover', 'A');
  assert.equal(agentReview(h.run).dei.score, 10);
  h.event('work_core', 'reopen', { reason: 'Synthetic requirement change.' });
  assert.equal(agentReview(h.run).dei.status, 'pending'); assert.equal(agentReview(h.run).dei.score, null);
  assert.deepEqual(agentReview(h.run).dei.missing_model_ids, []);
});

test('packaged agent-review reads a completed run without launching a model or changing it', async () => {
  const h = harness(); h.finish('work_core', 'A'); h.finish('handover', 'A');
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-dei-')); const filename = path.join(directory, 'run.json');
  await writeFile(filename, JSON.stringify(h.run));
  const helper = fileURLToPath(new URL('../plugins/hakengaisya/runtime/scripts/workflow.mjs', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [helper, 'agent-review', filename], { cwd: directory, encoding: 'utf8' }));
  assert.equal(result.dei.score, 1); assert.deepEqual(result, agentReview(h.run));
});

test('ordinary routing considers every supplied family and chooses the cheaper adequate other family', () => {
  const routes = [worker('A', 0.5, { model_family: 'fixture-host-family' }), worker('B', 0.01, { model_family: 'fixture-other-family' }), worker('C', 0.001, { available: false })];
  const plan = planWork(brief(), routes);
  assert.ok(plan.assignments.every(item => item.model_id === 'fixture-B'));
  assert.equal(plan.routing_audit.family_filter_applied, false);
  const candidates = plan.routing_audit.work[0].candidates;
  assert.deepEqual(candidates.map(item => item.outcome), ['eligible-not-selected', 'selected', 'excluded']);
  assert.equal(candidates[2].reason, 'route-unavailable'); assert.equal(candidates[2].model_family, null);
  const relabelled = planWork(brief(), routes.map(route => ({ ...route, model_family: 'another-label' })));
  assert.deepEqual(relabelled.assignments, plan.assignments);
  const run = createRun(null, brief({ workers: routes }));
  assert.deepEqual(agentReview(run).routing_audit, plan.routing_audit);
});
