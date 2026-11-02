import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCostObservations } from '../lib/cost-observations.ts';
import type { PeerObservation } from '../lib/feedback.ts';
import { preparePeerFeedback, queuePeerFeedback } from '../lib/feedback.ts';
import type { Run } from '../lib/types.ts';
import type { LocalReport } from '../packages/evaluator/sdk/client.ts';
import { prepareReport } from '../packages/evaluator/sdk/client.ts';

const salt = 'a'.repeat(32);
const scope = createHmac('sha256', salt).update('hakengaisya-cost-token-scope-v1').digest('hex');
const price = {
  url: 'https://example.com/pricing',
  checked_at: '2026-10-27',
  assumptions: 'Standard API equivalent; billing unavailable.',
};

function report(
  id: string,
  reviewer: string,
  task: string,
  kind: LocalReport['evaluation_kind'] = 'local_work',
) {
  return prepareReport(
    {
      report_id: id,
      reviewer_model: reviewer,
      subject_model: 'alpha',
      route: 'native',
      effort: 'medium',
      local_task_identity: task,
      evaluation_kind: kind,
      task: {
        domain: 'software-engineering',
        type: 'implementation',
        difficulty: 'standard',
        skills: ['implementation'],
      },
      ratings: { D1: 8 },
      comment: 'Observed a bounded task.',
      example: 'The result was reviewed.',
      guidance: 'Keep the check.',
      relationship: 'review',
      attribution: 'model',
      usage: { input_tokens: 1000, output_tokens: 200, cost_usd: null, wall_seconds: 12 },
    },
    salt,
  );
}

function evaluated(
  id: string,
  reviewer: string,
  task: string,
  amount = 0.1,
  kind: LocalReport['evaluation_kind'] = 'local_work',
) {
  return {
    kind: 'evaluator-report',
    report: report(id, reviewer, task, kind),
    task_token_scope: scope,
    local_cost_estimate: {
      usd: amount,
      basis: 'api-equivalent-estimate',
      source: price,
      usage_evidence: 'local-counter:attempt',
    },
  };
}

function operational(task: string, amount = 0.1) {
  const taskToken = createHmac('sha256', salt).update(task).digest('hex');
  return {
    kind: 'operational-only',
    reason: 'Same model in distinct contexts.',
    record: {
      task_token_scope: scope,
      task_token: taskToken,
      model_id: 'alpha',
      subject_context: '/worker',
      reviewer_context: '/reviewer',
      identity_evidence: ['subject-binding', 'reviewer-binding'],
      decision: 'accepted',
      task: {
        domain: 'software-engineering',
        task_type: 'implementation',
        difficulty: 'standard',
        skills: ['implementation'],
        evidence_kind: 'local_work',
        route: 'native',
        effort: 'medium',
      },
      usage: { input_tokens: 1000, output_tokens: 200, cost_usd: amount, wall_seconds: 12 },
      usage_evidence: 'local-counter:attempt',
      cost_basis: 'api-equivalent-estimate',
      cost_reference: price,
    },
  };
}

async function directory(t: { after: (callback: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hak-cost-'));
  const paths: string[] = [];
  t.after(async () => {
    for (const filename of paths) await unlink(filename);
    await rmdir(dir);
  });
  return {
    dir,
    track: (id: string) => paths.push(path.join(dir, `${id}.json`)),
    put: async (id: string, value: unknown) => {
      const filename = path.join(dir, `${id}.json`);
      paths.push(filename);
      await writeFile(filename, JSON.stringify(value));
    },
  };
}

test('deduplicates peer and same-model operational records by exact task token', async (t) => {
  const { dir, put } = await directory(t);
  await put('r1', evaluated('r1', 'beta', 'run/packet/1'));
  await put('r2', evaluated('r2', 'gamma', 'run/packet/1'));
  await put('r3', operational('run/packet/1'));
  await put('r4', evaluated('r4', 'beta', 'run/other/1', 0.3));
  const result = await readCostObservations(dir);
  assert.equal(result.status, 'available');
  assert.equal(result.estimates.length, 1);
  assert.equal(result.estimates[0].sample_count, 2);
  assert.equal(result.estimates[0].estimated_cost_usd, 0.2);
  assert.equal(result.estimates[0].basis, 'api-equivalent-estimate');
  assert.equal(result.diagnostics.duplicate_records, 2);
  assert.equal(result.estimates[0].provenance.find((item) => item.records.length === 3)?.usd, 0.1);
  assert.ok(!('observed_cost_usd' in result.estimates[0]));
  assert.match(result.boundary, /not actual billing/);
});

test('excludes conflicting estimates or identities for a task rather than averaging them', async (t) => {
  const { dir, put } = await directory(t);
  await put('r1', evaluated('r1', 'beta', 'same-task', 0.1));
  await put('r2', evaluated('r2', 'gamma', 'same-task', 0.2));
  const result = await readCostObservations(dir);
  assert.equal(result.status, 'needs-evidence');
  assert.equal(result.estimates.length, 0);
  assert.equal(result.diagnostics.conflicting_tasks.length, 1);
  assert.equal(result.diagnostics.duplicate_records, 0);
});

test('excludes a reused task token when subject model identity differs', async (t) => {
  const { dir, put } = await directory(t);
  const second = operational('same-task');
  second.record.model_id = 'other-model';
  await put('r1', evaluated('r1', 'beta', 'same-task'));
  await put('r2', second);
  const result = await readCostObservations(dir);
  assert.equal(result.status, 'needs-evidence');
  assert.equal(result.diagnostics.conflicting_tasks.length, 1);
  assert.equal(result.estimates.length, 0);
});

test('reads actual locally queued feedback and deduplicates an independent same-model context', async (t) => {
  const { dir, track } = await directory(t);
  const assignment = {
    owner_context: '/worker',
    reviewer_context: '/reviewer',
    contributor_contexts: [],
    writes: ['work'],
    model_id: 'alpha',
    route: 'native',
    effort: 'medium',
  };
  const run = {
    run_id: 'trial-1',
    domain: 'software-engineering',
    evidence_kind: 'local_work',
    packets: {
      handover: {
        id: 'handover',
        task_type: 'implementation',
        difficulty: 'standard',
        skills: ['implementation'],
        attempt: 1,
        assignment,
        result: {
          attempt: 1,
          outputs: [{ id: 'result', reference: 'work/result', summary: 'Result.' }],
          evidence: [{ reference: 'work/check', summary: 'Checked.' }],
        },
        review: {
          attempt: 1,
          reviewer_context: '/reviewer',
          decision: 'accepted',
          checks: [],
          task_checks: [],
        },
        history: [],
      },
    },
  } as unknown as Run;
  const observation: PeerObservation = {
    reviewer_context: '/reviewer',
    identities: [
      { context: '/worker', model_id: 'alpha', evidence_reference: 'subject-binding' },
      { context: '/reviewer', model_id: 'beta', evidence_reference: 'reviewer-binding' },
    ],
    task_salt: salt,
    report_id: 'queued-peer',
    ratings: { D1: 8 },
    comment: 'Reviewed.',
    example: 'Checked.',
    guidance: 'Retain.',
    attribution: 'model',
    usage: { input_tokens: 1000, output_tokens: 200, cost_usd: 0.1, wall_seconds: 12 },
    usage_evidence: 'local-counter:attempt',
    cost_basis: 'api-equivalent-estimate',
    cost_reference: price,
  };
  track('queued-peer');
  await queuePeerFeedback(preparePeerFeedback(run, 'handover', 1, observation), dir);
  const sameModel = {
    ...observation,
    report_id: 'queued-same-model',
    identities: [observation.identities[0], { ...observation.identities[1], model_id: 'alpha' }],
  };
  track('queued-same-model');
  await queuePeerFeedback(preparePeerFeedback(run, 'handover', 1, sameModel), dir);
  const result = await readCostObservations(dir);
  assert.equal(result.status, 'available');
  assert.equal(result.estimates[0].sample_count, 1);
  assert.equal(result.estimates[0].estimated_cost_usd, 0.1);
  assert.equal(result.diagnostics.duplicate_records, 1);
  assert.deepEqual(
    new Set(result.estimates[0].provenance[0].records.map((item) => item.kind)),
    new Set(['evaluator-report', 'operational-only']),
  );
});

test('keeps simulations isolated and missing source, scope or token usage unknown', async (t) => {
  const { dir, put } = await directory(t);
  await put('valid', evaluated('valid', 'beta', 'valid-task'));
  await put('sim', evaluated('sim', 'beta', 'sim-task', 0.2, 'simulation'));
  const old = evaluated('old', 'beta', 'old-task');
  delete (old.local_cost_estimate as Partial<typeof old.local_cost_estimate>).source;
  await put('old', old);
  const noScope = evaluated('noscope', 'beta', 'scope-task');
  delete (noScope as Partial<typeof noScope>).task_token_scope;
  await put('noscope', noScope);
  const noTokens = evaluated('notokens', 'beta', 'tokens-task');
  noTokens.report.usage.input_tokens = null;
  await put('notokens', noTokens);
  const result = await readCostObservations(dir);
  assert.equal(result.status, 'partial');
  assert.equal(result.diagnostics.excluded_nonlocal_records, 1);
  assert.equal(result.diagnostics.unknown_records, 3);
  assert.equal(result.estimates[0].sample_count, 1);
});

test('does not combine incomparable token scopes without an explicit scope selection', async (t) => {
  const { dir, put } = await directory(t);
  const first = evaluated('r1', 'beta', 'first');
  const second = evaluated('r2', 'beta', 'second');
  second.task_token_scope = 'b'.repeat(64);
  await put('r1', first);
  await put('r2', second);
  const all = await readCostObservations(dir);
  assert.equal(all.status, 'needs-evidence');
  assert.deepEqual(all.estimates, []);
  assert.equal(all.available_scopes.length, 2);
  const selected = await readCostObservations(dir, { task_token_scope: scope });
  assert.equal(selected.status, 'partial');
  assert.equal(selected.estimates[0].sample_count, 1);
  assert.equal(selected.diagnostics.ignored_other_scope_records, 1);
});

test('flags invalid records, missing directories and an attempted report-id substitution without modifying input', async (t) => {
  const { dir, put } = await directory(t);
  await put('wrong', evaluated('other-id', 'beta', 'another-task'));
  const filename = path.join(dir, 'wrong.json');
  const before = await readFile(filename, 'utf8');
  const result = await readCostObservations(dir);
  assert.equal(result.status, 'needs-evidence');
  assert.equal(result.diagnostics.malformed_records, 1);
  assert.equal(await readFile(filename, 'utf8'), before);
  assert.equal((await readCostObservations(path.join(dir, 'missing'))).status, 'needs-evidence');
  assert.equal((await readCostObservations('relative')).status, 'needs-evidence');
});
