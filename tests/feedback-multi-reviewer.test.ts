import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commands } from '../lib/commands.ts';
import { flushPeerFeedbackLocal } from '../lib/feedback.ts';
import type { BatchEvent, BriefInput, Run, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';
import { createApp } from '../packages/evaluator/src/server.ts';
import { Store } from '../packages/evaluator/src/store.ts';

function reviewedRun(id: string, reviewer: string): Run {
  const brief: BriefInput = {
    run_id: id,
    objective: 'Review a fixture.',
    domain: 'software-engineering',
    evidence_kind: 'local_work',
    lead_context: '/host',
    acceptance: ['Fixture checked.'],
    constraints: [],
    work_items: [
      {
        id: 'work',
        objective: 'Produce a fixture.',
        task_type: 'implementation',
        difficulty: 'standard',
        skills: ['implementation'],
        depends_on: [],
        writes: ['work'],
        outputs: ['result'],
        acceptance: ['Checked.'],
      },
    ],
  };
  let run = createRun(null, brief);
  function apply(event: BatchEvent) {
    run = applyEvent(run, { ...event, expected_revision: run.revision } as WorkflowEvent);
  }
  apply({
    id: 'assign',
    type: 'assign',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/host',
    assignment: {
      owner_context: '/worker',
      reviewer_context: '/host',
      contributor_contexts: [],
      writes: ['work'],
      model_id: 'subject',
      route: 'native',
      effort: 'medium',
    },
  });
  apply({
    id: 'start',
    type: 'start',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/worker',
  });
  apply({
    id: 'submit',
    type: 'submit',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/worker',
    outputs: [{ id: 'result', reference: 'fixture-result', summary: 'Fixture.' }],
    evidence: [{ reference: 'fixture-check', summary: 'Checked.' }],
  });
  apply({
    id: 'review',
    type: 'review',
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/host',
    reviewer_model: reviewer,
    reviewer_identity_evidence: 'fixture-reviewer-binding',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'fixture-check', note: 'Passed.' }],
    task_checks: [
      { index: 0, result: 'pass', evidence_reference: 'fixture-check', note: 'Passed.' },
    ],
  });
  return run;
}

test('mixed queued feedback uses only the selected reviewer identity and never auto-signs an unknown reviewer', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hak-mixed-review-'));
  const queue = path.join(directory, 'queue');
  const saltFile = path.join(directory, 'salt');
  const configFile = path.join(directory, 'config.json');
  const keyA = path.join(directory, 'a.key');
  const keyB = path.join(directory, 'b.key');
  const ids = ['a-reviewer-b', 'b-reviewer-a', 'c-operational', 'd-unconfigured'];
  const runs = ids.map((id) => path.join(directory, `${id}-run.json`));
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    const receipts = path.join(queue, 'receipts');
    try {
      for (const name of await readdir(receipts)) await unlink(path.join(receipts, name));
      await rmdir(receipts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const id of ids) {
      try {
        await unlink(path.join(queue, `${id}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await rmdir(queue);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const filename of [...runs, saltFile, configFile, keyA, keyB]) {
      try {
        await unlink(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rmdir(directory);
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const keysA = generateKeyPairSync('ed25519');
  const keysB = generateKeyPairSync('ed25519');
  for (const [id, model, keys] of [
    ['client-a', 'reviewer-a', keysA],
    ['client-b', 'reviewer-b', keysB],
  ] as const)
    store.enroll({
      id,
      collection_id: 'fixture',
      model,
      public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    });
  await writeFile(saltFile, 'test-only-salt-at-least-thirty-two-characters');
  await commands.integrated_config_create.run({
    config_file: configFile,
    config: {
      version: 1,
      evaluator: {
        endpoint,
        queue_dir: queue,
        task_salt_file: saltFile,
        reviewers: [
          { reviewer_model: 'reviewer-a', client_id: 'client-a', private_key_file: keyA },
          { reviewer_model: 'reviewer-b', client_id: 'client-b', private_key_file: keyB },
        ],
      },
    },
  });
  const reviewers = ['reviewer-b', 'reviewer-a', 'subject', 'reviewer-c'];
  for (const [index, reviewer] of reviewers.entries()) {
    await writeFile(runs[index], JSON.stringify(reviewedRun(`run-${index}`, reviewer)));
    const recorded = (await commands.feedback_record.run({
      run_file: runs[index],
      request: {
        packet_id: 'handover',
        attempt: 1,
        config_file: configFile,
        submit_local: false,
        observation: {
          reviewer_context: '/host',
          identities: [
            { context: '/worker', model_id: 'subject', evidence_reference: 'fixture-subject' },
            {
              context: '/host',
              model_id: reviewer,
              evidence_reference: 'fixture-reviewer-binding',
            },
          ],
          report_id: ids[index],
          ratings: { D1: 8 },
          comment: 'Synthetic fixture.',
          example: 'Fixture.',
          guidance: 'Fixture only.',
          attribution: 'model',
          usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.01, wall_seconds: 3 },
          usage_evidence: 'fixture-counter',
          cost_basis: 'api-equivalent-estimate',
          cost_reference: {
            url: 'https://example.com/pricing',
            checked_at: '2026-10-27',
            assumptions: 'Fixture prices.',
          },
        },
      },
    })) as { submission: { status: string } };
    assert.equal(
      recorded.submission.status,
      reviewer === 'subject' ? 'operational-only' : 'not-requested',
    );
  }
  const noSelection = (await commands.feedback_flush.run({
    request: { config_file: configFile },
  })) as { status: string };
  assert.equal(noSelection.status, 'needs-reviewer-selection');
  const unknown = (await commands.feedback_flush.run({
    request: { config_file: configFile, reviewer_model: 'reviewer-c' },
  })) as { status: string };
  assert.equal(unknown.status, 'reviewer-identity-mismatch');
  const direct = (await commands.feedback_flush.run({
    request: { queue_dir: queue, endpoint, client_id: 'client-a', private_key_file: keyA },
  })) as { status: string };
  assert.equal(direct.status, 'needs-reviewer-selection');
  await assert.rejects(
    flushPeerFeedbackLocal(
      queue,
      endpoint,
      { clientId: 'client-a', privateKey: keysA.privateKey },
      undefined,
      '',
    ),
    /actual reviewer model/,
  );
  assert.equal(store.count(), 0);
  assert.ok(!(await readdir(queue)).includes('receipts'));
  await writeFile(keyA, keysA.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await writeFile(keyB, keysB.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const first = (await commands.feedback_flush.run({
    request: { config_file: configFile, reviewer_model: 'reviewer-a' },
  })) as {
    results: Array<{ record_id: string; status: string }>;
    unmatched: number;
    skipped: number;
  };
  assert.deepEqual(first.results, [{ record_id: 'b-reviewer-a', status: 'accepted' }]);
  assert.equal(first.unmatched, 2);
  assert.equal(first.skipped, 1);
  assert.equal(store.count(), 1);
  const firstRow = store.db.prepare('SELECT client_id, json FROM reports').get() as {
    client_id: string;
    json: string;
  };
  assert.equal(firstRow.client_id, 'client-a');
  assert.equal(JSON.parse(firstRow.json).reviewer_model, 'reviewer-a');
  assert.ok(!firstRow.json.includes('local_cost_estimate'));
  assert.ok(!firstRow.json.includes('task_token_scope'));
  const second = (await commands.feedback_flush.run({
    request: { config_file: configFile, reviewer_model: 'reviewer-b' },
  })) as { results: Array<{ record_id: string; status: string }> };
  assert.deepEqual(second.results, [{ record_id: 'a-reviewer-b', status: 'accepted' }]);
  assert.equal(store.count(), 2);
  const again = (await commands.feedback_flush.run({
    request: { config_file: configFile, reviewer_model: 'reviewer-a' },
  })) as { results: unknown[] };
  assert.equal(again.results.length, 0);
  assert.equal(store.count(), 2);
  await assert.rejects(
    commands.feedback_flush.run({
      request: { config_file: configFile, reviewer_model: 'reviewer-a', client_id: 'client-b' },
    }) as Promise<unknown>,
    /Client differs/,
  );
  assert.equal(store.count(), 2);
});
