import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commands } from '../lib/commands.ts';
import type { ExternalEvidence } from '../lib/evaluator-bridge.ts';
import { type IntegrationInput, prepareIntegratedPlan } from '../lib/integrated.ts';
import type { BriefInput } from '../lib/types.ts';
import { prepareReport, submitReport } from '../packages/evaluator/sdk/client.ts';
import { createApp } from '../packages/evaluator/src/server.ts';
import { Store } from '../packages/evaluator/src/store.ts';

const baseBrief: BriefInput = {
  run_id: 'integrated-fixture',
  objective: 'Deliver a bounded fixture.',
  domain: 'software-engineering',
  lead_context: '/host',
  evidence_kind: 'local_work',
  acceptance: ['Result is checked.'],
  constraints: [],
  work_items: [
    {
      id: 'result',
      objective: 'Produce fixture output.',
      task_type: 'implementation',
      difficulty: 'standard',
      skills: ['implementation'],
      depends_on: [],
      writes: ['work'],
      outputs: ['result'],
      acceptance: ['Output passes.'],
    },
  ],
  planning_limits: {
    max_parallel: 1,
    max_workers: 1,
    overhead_seconds: 0,
    overhead_cost_usd: 0,
    context_startup_seconds: 0,
    context_startup_cost_usd: 0,
  },
};
const inventory = {
  complete: true,
  routes: [
    {
      id: 'alpha-slot',
      model_id: 'alpha',
      route: 'native',
      effort: 'medium',
      available: true,
      tools_verified: true,
      tools: [],
    },
    {
      id: 'beta-slot',
      model_id: 'beta',
      route: 'native',
      effort: 'medium',
      available: true,
      tools_verified: true,
      tools: [],
    },
  ],
};
const evidence = (model: string, cost: number, seconds: number): ExternalEvidence => ({
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
    title: 'Public fixture',
    accessed_at: '2026-10-27T00:00:00Z',
  },
  assessment: {
    kind: 'qualitative',
    summary: 'Fixture supports a bounded trial.',
    trial_fit: 'supports',
  },
  estimates: {
    kind: 'unobserved_estimate',
    cost_usd: cost,
    wall_seconds: seconds,
    basis: 'Explicit fixture estimate.',
  },
});

test('requires real inventory and requests research rather than silently dispatching defaults', async () => {
  const partial = await prepareIntegratedPlan({
    brief: baseBrief,
    inventory: { ...inventory, complete: false },
  });
  assert.equal(partial.status, 'needs-inventory');
  assert.equal(partial.plan, null);
  const noEvidence = await prepareIntegratedPlan({ brief: baseBrief, inventory });
  assert.equal(noEvidence.status, 'needs-research');
  assert.equal(noEvidence.research_requests.length, 2);
  assert.equal(noEvidence.planned_brief, null);
  assert.equal(noEvidence.catalog.workers.length, 2);
});

test('uses sourced external assessments only for explicit, labeled, bounded trials', async () => {
  const input: IntegrationInput = {
    brief: baseBrief,
    inventory,
    public_trials: { enabled: true, max_assignments: 1 },
    external_evidence: [evidence('alpha', 0.03, 30), evidence('beta', 0.1, 10)],
  };
  const result = await prepareIntegratedPlan(input);
  assert.equal(result.status, 'planned');
  assert.equal(result.plan?.assignments[0].worker_id, 'alpha-slot');
  assert.equal(result.plan?.assignments[0].qualification, 'trial');
  assert.equal(result.plan?.assignments[0].trial_sources?.[0].url, 'https://example.com/alpha');
  assert.equal(result.catalog.workers[0].profiles?.length, 0);
  const missing = await prepareIntegratedPlan({
    ...input,
    external_evidence: [evidence('alpha', 0.03, 30)],
  });
  assert.equal(missing.status, 'needs-research');
  assert.equal(missing.research_requests[0].model_id, 'beta');
  const noApproval = await prepareIntegratedPlan({ ...input, public_trials: undefined });
  assert.equal(noApproval.status, 'needs-trial-policy');
  const opposed = evidence('beta', 0.1, 10);
  opposed.assessment.trial_fit = 'opposes';
  const opposedResult = await prepareIntegratedPlan({
    ...input,
    external_evidence: [evidence('alpha', 0.03, 30), opposed],
  });
  assert.equal(opposedResult.status, 'needs-research');
  await assert.rejects(
    () =>
      prepareIntegratedPlan({
        ...input,
        brief: {
          ...baseBrief,
          planning_limits: { ...baseBrief.planning_limits, unproven_routes: 'refuse' },
        },
      }),
    /cannot override/,
  );
  const capped = await prepareIntegratedPlan({
    ...input,
    brief: {
      ...baseBrief,
      planning_limits: { ...baseBrief.planning_limits, max_trial_assignments: 1 },
    },
    public_trials: { enabled: true, max_assignments: 4 },
  });
  assert.equal(capped.planned_brief?.planning_limits?.max_trial_assignments, 1);
});

test('sourced trials never override unavailable routes, tools, or mismatched task provenance', async () => {
  const altered = evidence('alpha', 0.01, 1);
  altered.task.difficulty = 'routine';
  const result = await prepareIntegratedPlan({
    brief: baseBrief,
    inventory: { complete: true, routes: [inventory.routes[0]] },
    public_trials: { enabled: true, max_assignments: 1 },
    external_evidence: [altered],
  });
  assert.equal(result.status, 'needs-research');
  const unavailable = await prepareIntegratedPlan({
    brief: baseBrief,
    inventory: { complete: true, routes: [{ ...inventory.routes[0], available: false }] },
    public_trials: { enabled: true, max_assignments: 1 },
    external_evidence: [evidence('alpha', 0.01, 1)],
  });
  assert.equal(unavailable.status, 'needs-evidence');
  assert.equal(unavailable.planned_brief, null);
});

test('a preflighted existing context is marked for reuse instead of a false fresh launch', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hak-integrated-reuse-'));
  const runFile = path.join(dir, 'run.json');
  t.after(async () => {
    await unlink(runFile);
    await rmdir(dir);
  });
  const request = {
    brief: baseBrief,
    inventory: { complete: true, routes: [{ ...inventory.routes[0], context_id: '/existing' }] },
    public_trials: { enabled: true, max_assignments: 1 },
    external_evidence: [evidence('alpha', 0.01, 10)],
  };
  await commands.integrated_create.run({ run_file: runFile, request });
  const reserved = (await commands.integrated_reserve.run({
    run_file: runFile,
    request: {
      packet_id: 'handover',
      expected_revision: 0,
      actor_context: '/host',
      owner_context: '/existing',
      reviewer_context: '/host',
      contributor_contexts: [],
    },
  })) as { launch: { mode: string; fork_turns: string | null }; boundary: string };
  assert.equal(reserved.launch.mode, 'reuse-existing-context');
  assert.equal(reserved.launch.fork_turns, null);
  assert.match(reserved.boundary, /verifies actual identity/);
});

test('isolated real evaluator service feeds planning and receives a reviewed local feedback record', async (t) => {
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const peers = ['reviewer-one', 'reviewer-two'].map((model, index) => {
    const keys = generateKeyPairSync('ed25519');
    store.enroll({
      id: `client-${index}`,
      collection_id: 'fixture',
      model,
      public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    });
    return {
      model,
      keys,
      credentials: { clientId: `client-${index}`, privateKey: keys.privateKey },
    };
  });
  for (const [model, cost, seconds] of [
    ['alpha', 0.02, 30],
    ['beta', 0.2, 10],
  ] as const) {
    for (const task of ['task-1', 'task-2']) {
      for (const peer of peers) {
        const report = prepareReport(
          {
            report_id: `fixture-${model}-${task}-${peer.model}`,
            reviewer_model: peer.model,
            subject_model: model,
            route: 'native',
            effort: 'medium',
            local_task_identity: task,
            evaluation_kind: 'local_work',
            task: {
              domain: 'software-engineering',
              type: 'implementation',
              difficulty: 'standard',
              skills: ['implementation'],
            },
            ratings: { D1: 8, D2: 8, D6: 8 },
            comment: 'Synthetic fixture observation.',
            example: 'Synthetic task.',
            guidance: 'Fixture only.',
            relationship: 'review',
            attribution: 'model',
            usage: { input_tokens: 10, output_tokens: 3, cost_usd: cost, wall_seconds: seconds },
          },
          'synthetic-salt-that-is-at-least-32-characters',
        );
        assert.equal((await submitReport(endpoint, report, peer.credentials)).accepted, true);
      }
    }
  }
  const request: IntegrationInput = { brief: baseBrief, inventory, evaluator_endpoint: endpoint };
  const plan = await prepareIntegratedPlan(request);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.catalog.evaluator.status, 'available');
  assert.equal(plan.plan?.assignments[0].worker_id, 'alpha-slot');
  assert.equal(plan.plan?.assignments[0].qualification, 'qualified');

  const dir = await mkdtemp(path.join(tmpdir(), 'hak-integrated-'));
  const runFile = path.join(dir, 'run.json');
  const saltFile = path.join(dir, 'salt');
  const keyFile = path.join(dir, 'key');
  const queueDir = path.join(dir, 'queue');
  const configFile = path.join(dir, 'integration.json');
  const otherConfigFile = path.join(dir, 'other-integration.json');
  await writeFile(saltFile, 'synthetic-salt-that-is-at-least-32-characters');
  await writeFile(keyFile, peers[0].keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  t.after(async () => {
    for (const file of [
      path.join(queueDir, 'observed-fixture.json'),
      path.join(queueDir, 'mismatch-fixture.json'),
      runFile,
      saltFile,
      keyFile,
      configFile,
      otherConfigFile,
    ]) {
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await rmdir(queueDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rmdir(dir);
  });
  const configResult = (await commands.integrated_config_create.run({
    config_file: configFile,
    config: {
      version: 1,
      evaluator: {
        endpoint,
        queue_dir: queueDir,
        task_salt_file: saltFile,
        client_id: 'client-0',
        reviewer_model: 'reviewer-one',
        private_key_file: keyFile,
      },
      cost: { allow_api_equivalent: true, max_age_days: 30 },
      learning: { state_dir: path.join(dir, 'learning'), reuse_enabled: false },
    },
  })) as { status: { evaluator: { state: string } } };
  assert.equal(configResult.status.evaluator.state, 'configured');
  const configuredRequest = { brief: baseBrief, inventory, config_file: configFile };
  const configuredPlan = await prepareIntegratedPlan(configuredRequest);
  assert.equal(configuredPlan.status, 'planned');
  assert.equal(configuredPlan.configuration?.evaluator.profiles, 'configured');
  const created = (await commands.integrated_create.run({
    run_file: runFile,
    request: configuredRequest,
  })) as {
    created: boolean;
    revision: number;
  };
  assert.equal(created.created, true);
  const reservation = (await commands.integrated_reserve.run({
    run_file: runFile,
    request: {
      packet_id: 'handover',
      expected_revision: 0,
      actor_context: '/host',
      owner_context: '/worker',
      reviewer_context: '/host',
      contributor_contexts: [],
      config_file: configFile,
    },
  })) as {
    revision: number;
    status: string;
    launch: { model: string; reasoning_effort: string; fork_turns: string };
  };
  assert.equal(reservation.status, 'reserved-awaiting-native-host');
  assert.equal(reservation.revision, 2);
  assert.equal(reservation.launch.model, 'alpha');
  assert.equal(reservation.launch.reasoning_effort, 'medium');
  assert.equal(reservation.launch.fork_turns, 'none');
  await assert.rejects(
    () =>
      commands.integrated_reserve.run({
        run_file: runFile,
        request: {
          packet_id: 'handover',
          expected_revision: 0,
          actor_context: '/host',
          owner_context: '/worker',
          reviewer_context: '/host',
          contributor_contexts: [],
        },
      }) as Promise<unknown>,
    /revision|pending|assigned/i,
  );
  await commands.event.run({
    run_file: runFile,
    events: [
      {
        id: 'submit',
        type: 'submit',
        expected_revision: 2,
        packet_id: 'handover',
        attempt: 1,
        actor_context: '/worker',
        outputs: [{ id: 'result', reference: 'fixture-result', summary: 'Fixture output.' }],
        evidence: [{ reference: 'fixture-evidence', summary: 'Synthetic evidence.' }],
      },
    ],
  });
  const result = (await commands.integrated_review.run({
    run_file: runFile,
    request: {
      event: {
        id: 'review',
        type: 'review',
        expected_revision: 3,
        packet_id: 'handover',
        attempt: 1,
        actor_context: '/host',
        decision: 'accepted',
        checks: [{ index: 0, result: 'pass', evidence_reference: 'fixture', note: 'Fixture.' }],
        task_checks: [
          { index: 0, result: 'pass', evidence_reference: 'fixture', note: 'Fixture.' },
        ],
      },
      feedback: {
        packet_id: 'handover',
        attempt: 1,
        config_file: configFile,
        observation: {
          reviewer_context: '/host',
          identities: [
            { context: '/worker', model_id: 'alpha', evidence_reference: 'fixture-worker' },
            { context: '/host', model_id: 'reviewer-one', evidence_reference: 'fixture-reviewer' },
          ],
          report_id: 'observed-fixture',
          ratings: { D1: 8, D2: 8, D6: 8 },
          comment: 'Synthetic fixture.',
          example: 'Synthetic review.',
          guidance: 'Fixture only.',
          attribution: 'model',
          usage: { input_tokens: 10, output_tokens: 4, cost_usd: 0.02, wall_seconds: 5 },
          usage_evidence: 'fixture-counter',
          cost_basis: 'actual-billed',
        },
      },
    },
  })) as {
    review_applied: boolean;
    feedback: { submission: { status: string }; boundary: string };
  };
  assert.equal(result.review_applied, true);
  assert.equal(result.feedback.submission.status, 'accepted');
  assert.match(result.feedback.boundary, /loopback evaluator/);
  assert.doesNotMatch(result.feedback.boundary, /No report is transmitted/);
  assert.equal(store.count(), 9);
  await commands.integrated_config_create.run({
    config_file: otherConfigFile,
    config: {
      version: 1,
      evaluator: {
        endpoint,
        queue_dir: queueDir,
        task_salt_file: saltFile,
        client_id: 'client-1',
        reviewer_model: 'reviewer-two',
        private_key_file: path.join(dir, 'missing-key'),
      },
    },
  });
  const mismatch = (await commands.feedback_record.run({
    run_file: runFile,
    request: {
      packet_id: 'handover',
      attempt: 1,
      config_file: otherConfigFile,
      observation: {
        reviewer_context: '/host',
        identities: [
          { context: '/worker', model_id: 'alpha', evidence_reference: 'fixture-worker' },
          { context: '/host', model_id: 'reviewer-one', evidence_reference: 'fixture-reviewer' },
        ],
        report_id: 'mismatch-fixture',
        ratings: {},
        comment: 'Fixture review.',
        example: 'Fixture.',
        guidance: 'Fixture.',
        attribution: 'model',
      },
    },
  })) as { submission: { status: string } };
  assert.equal(mismatch.submission.status, 'reviewer-identity-mismatch');
  assert.equal(store.count(), 9);
  await assert.rejects(
    () =>
      commands.feedback_record.run({
        run_file: runFile,
        request: {
          packet_id: 'handover',
          attempt: 1,
          config_file: configFile,
          observation: {
            reviewer_context: '/host',
            identities: [
              { context: '/worker', model_id: 'alpha', evidence_reference: 'fixture-worker' },
              {
                context: '/host',
                model_id: 'reviewer-two',
                evidence_reference: 'fixture-reviewer',
              },
            ],
            report_id: 'relabelled-fixture',
            ratings: {},
            comment: 'Fixture.',
            example: 'Fixture.',
            guidance: 'Fixture.',
            attribution: 'model',
          },
        },
      }) as Promise<unknown>,
    /Reviewer model differs/,
  );
  assert.equal(JSON.parse(await readFile(runFile, 'utf8')).packets.handover.status, 'accepted');
});
