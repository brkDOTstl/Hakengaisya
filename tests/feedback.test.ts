import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  flushPeerFeedbackLocal,
  type PeerObservation,
  preparePeerFeedback,
  queuePeerFeedback,
  submitPeerFeedbackLocal,
} from '../lib/feedback.ts';
import type { Run } from '../lib/types.ts';
import { createApp } from '../packages/evaluator/src/server.ts';
import { Store } from '../packages/evaluator/src/store.ts';

function fixture() {
  const assignment = {
    owner_context: 'worker',
    reviewer_context: 'reviewer',
    contributor_contexts: [],
    writes: ['work'],
    model_id: 'model-a',
    route: 'native',
    effort: 'medium',
  };
  const result = {
    attempt: 1,
    outputs: [{ id: 'result', reference: 'work/result', summary: 'Result.' }],
    evidence: [{ reference: 'work/check', summary: 'Checked.' }],
  };
  const review = {
    attempt: 1,
    reviewer_context: 'reviewer',
    decision: 'accepted',
    checks: [],
    task_checks: [],
  };
  const packet = {
    id: 'handover',
    task_type: 'implementation',
    difficulty: 'standard',
    skills: ['implementation'],
    attempt: 1,
    assignment,
    result,
    review,
    history: [],
  };
  const run = {
    run_id: 'run-1',
    domain: 'software-engineering',
    evidence_kind: 'local_work',
    packets: { handover: packet },
  } as unknown as Run;
  const observation: PeerObservation = {
    reviewer_context: 'reviewer',
    identities: [
      { context: 'worker', model_id: 'model-a', evidence_reference: 'host-subject-binding' },
      { context: 'reviewer', model_id: 'model-b', evidence_reference: 'host-reviewer-binding' },
    ],
    task_salt: 'a'.repeat(32),
    report_id: 'stable-report-1',
    ratings: { D1: 8 },
    comment: 'Checked C:\\private\\file and the behavior.',
    example: 'A bounded example.',
    guidance: 'Preserve the observed boundary.',
    attribution: 'model',
    usage: { input_tokens: 10, output_tokens: 3, cost_usd: null, wall_seconds: 2 },
    usage_evidence: 'host-token-counter',
  };
  return { run, packet, observation };
}

test('prepares a stable, de-identified evaluator report from an independent review', () => {
  const { run, observation } = fixture();
  const prepared = preparePeerFeedback(run, 'handover', 1, observation);
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.equal(prepared.report.report_id, 'stable-report-1');
  assert.match(prepared.report.task_token, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(prepared.report).includes('C:\\private'));
  assert.equal(prepared.report.usage.cost_usd, null);
  assert.deepEqual(prepared.report.ratings, { D1: 8 });
  assert.equal(prepared.report.subject_model, 'model-a');
  assert.equal(prepared.report.reviewer_model, 'model-b');
  assert.equal(prepared.usage_evidence, 'host-token-counter');
  assert.deepEqual(preparePeerFeedback(run, 'handover', 1, observation), prepared);
});

test('requires actual reviewed attempt, reviewer context, identity, and usage evidence', () => {
  const { run, packet, observation } = fixture();
  assert.throws(() => preparePeerFeedback(run, 'handover', 2, observation), /reviewed attempt/);
  assert.throws(
    () => preparePeerFeedback(run, 'handover', 1, { ...observation, reviewer_context: 'worker' }),
    /independent reviewer/,
  );
  assert.throws(
    () => preparePeerFeedback(run, 'handover', 1, { ...observation, usage_evidence: undefined }),
    /Usage evidence/,
  );
  assert.throws(
    () =>
      preparePeerFeedback(run, 'handover', 1, {
        ...observation,
        identities: [
          { context: 'worker', model_id: 'model-c', evidence_reference: 'host' },
          observation.identities[1],
        ],
      }),
    /must match/,
  );
  packet.review = null as unknown as typeof packet.review;
  assert.throws(() => preparePeerFeedback(run, 'handover', 1, observation), /reviewed attempt/);
});

test('does not invent a different reviewer model for separate contexts of the same model', () => {
  const { run, observation } = fixture();
  const prepared = preparePeerFeedback(run, 'handover', 1, {
    ...observation,
    identities: [observation.identities[0], { ...observation.identities[1], model_id: 'model-a' }],
  });
  assert.equal(prepared.status, 'operational-only');
  assert.ok(!('report' in prepared));
});

test('keeps API-equivalent estimates local and never reports them as observed billing', () => {
  const { run, observation } = fixture();
  const estimated = { ...observation, usage: { ...observation.usage, cost_usd: 0.12 } };
  assert.throws(() => preparePeerFeedback(run, 'handover', 1, estimated), /cost needs an explicit/);
  const prepared = preparePeerFeedback(run, 'handover', 1, {
    ...estimated,
    cost_basis: 'api-equivalent-estimate',
    cost_reference: {
      url: 'https://example.com/pricing',
      checked_at: '2026-10-27',
      assumptions: 'Fixture rates.',
    },
  });
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') return;
  assert.equal(prepared.report.usage.cost_usd, null);
  assert.deepEqual(prepared.local_cost_estimate, {
    usd: 0.12,
    basis: 'api-equivalent-estimate',
    source: {
      url: 'https://example.com/pricing',
      checked_at: '2026-10-27',
      assumptions: 'Fixture rates.',
    },
    usage_evidence: 'host-token-counter',
  });
});

test('can prepare feedback for a retained rejected attempt without relabeling it current', () => {
  const { run, packet, observation } = fixture();
  const original = structuredClone(packet);
  original.review.decision = 'rejected';
  packet.history.push({ ...original, status: 'rejected', invalidated_by: 'rework' } as never);
  packet.attempt = 2;
  packet.review = null as unknown as typeof packet.review;
  packet.result = null as unknown as typeof packet.result;
  const prepared = preparePeerFeedback(run, 'handover', 1, observation);
  assert.equal(prepared.status, 'ready');
});

test('queues once and submits a de-identified observation to a real loopback evaluator', async (t) => {
  const { run, observation } = fixture();
  const prepared = preparePeerFeedback(run, 'handover', 1, observation);
  const directory = await mkdtemp(path.join(tmpdir(), 'hak-feedback-'));
  const queued = await queuePeerFeedback(prepared, directory);
  t.after(async () => {
    await unlink(queued.path);
    const receipts = path.join(directory, 'receipts');
    for (const name of await readdir(receipts)) await unlink(path.join(receipts, name));
    await rmdir(receipts);
    await rmdir(directory);
  });
  assert.deepEqual(await queuePeerFeedback(prepared, directory), queued);
  const stored = JSON.parse(await readFile(queued.path, 'utf8'));
  assert.equal(stored.kind, 'evaluator-report');
  assert.ok(!JSON.stringify(stored).includes('C:\\private'));
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const keys = generateKeyPairSync('ed25519');
  store.enroll({
    id: 'reviewer-client',
    collection_id: 'fixture',
    model: 'model-b',
    public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const unused = createServer();
  unused.listen(0, '127.0.0.1');
  await once(unused, 'listening');
  const unavailable = `http://127.0.0.1:${(unused.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  const offline = await flushPeerFeedbackLocal(
    directory,
    unavailable,
    {
      clientId: 'reviewer-client',
      privateKey: keys.privateKey,
    },
    3,
    'model-b',
  );
  assert.equal(offline.results[0].status, 'queued');
  assert.equal(store.count(), 0);
  const receipt = await submitPeerFeedbackLocal(prepared, endpoint, {
    clientId: 'reviewer-client',
    privateKey: keys.privateKey,
  });
  assert.equal(receipt.status, 'accepted');
  assert.equal(store.count(), 1);
  const second = await submitPeerFeedbackLocal(prepared, endpoint, {
    clientId: 'reviewer-client',
    privateKey: keys.privateKey,
  });
  assert.equal(second.status, 'accepted');
  assert.equal(store.count(), 1);
  const flushed = await flushPeerFeedbackLocal(
    directory,
    endpoint,
    {
      clientId: 'reviewer-client',
      privateKey: keys.privateKey,
    },
    3,
    'model-b',
  );
  assert.equal(flushed.results[0].status, 'accepted');
  assert.equal(store.count(), 1);
  const repeated = await flushPeerFeedbackLocal(
    directory,
    endpoint,
    {
      clientId: 'reviewer-client',
      privateKey: keys.privateKey,
    },
    3,
    'model-b',
  );
  assert.equal(repeated.results.length, 0);
  assert.equal(repeated.skipped, 1);
  await assert.rejects(
    () =>
      submitPeerFeedbackLocal(prepared, 'https://example.com', {
        clientId: 'reviewer-client',
        privateKey: keys.privateKey,
      }),
    /loopback/,
  );
});

test('same-model review is retained locally without submitting a synthetic peer score', async (t) => {
  const { run, observation } = fixture();
  const prepared = preparePeerFeedback(run, 'handover', 1, {
    ...observation,
    identities: [observation.identities[0], { ...observation.identities[1], model_id: 'model-a' }],
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'hak-operational-'));
  const queued = await queuePeerFeedback(prepared, directory);
  t.after(async () => {
    await unlink(queued.path);
    await rmdir(directory);
  });
  const stored = JSON.parse(await readFile(queued.path, 'utf8'));
  assert.equal(stored.kind, 'operational-only');
  assert.equal(stored.record.model_id, 'model-a');
  assert.match(stored.record.task_token, /^[a-f0-9]{64}$/);
  assert.match(stored.record.task_token_scope, /^[a-f0-9]{64}$/);
  assert.ok(!Object.hasOwn(stored, 'report'));
});
