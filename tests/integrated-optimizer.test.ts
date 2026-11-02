import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commands } from '../lib/commands.ts';
import type { IntegrationInput } from '../lib/integrated.ts';
import type { Harness2Job } from '../lib/learning.ts';

test('integrated reservation creates a current immutable opt-in Harness2 job', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hak-optimizer-integrated-'));
  const runFile = path.join(dir, 'run.json');
  let jobFile = '';
  t.after(async () => {
    for (const file of [jobFile, runFile])
      if (file)
        try {
          await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    await rmdir(dir);
  });
  const request: IntegrationInput = {
    brief: {
      run_id: 'optimizer-integrated-fixture',
      objective: 'Produce a fixture.',
      domain: 'software-engineering',
      lead_context: '/host',
      evidence_kind: 'simulation',
      acceptance: ['Checked.'],
      constraints: [],
      improvement: { enabled: true, scope: 'fixture', max_host_calls: 9 },
      work_items: [
        {
          id: 'output',
          objective: 'Produce output.',
          task_type: 'implementation',
          difficulty: 'routine',
          skills: ['implementation'],
          depends_on: [],
          writes: ['out'],
          outputs: ['result'],
          acceptance: ['Checked.'],
        },
      ],
      planning_limits: { max_parallel: 1, max_workers: 1 },
    },
    inventory: {
      complete: true,
      routes: [
        {
          id: 'worker',
          model_id: 'fixture-model',
          route: 'native',
          effort: 'low',
          available: true,
          tools_verified: true,
          tools: [],
        },
      ],
    },
    public_trials: { enabled: true, max_assignments: 1 },
    external_evidence: [
      {
        model_id: 'fixture-model',
        route: 'native',
        effort: 'low',
        task: {
          domain: 'software-engineering',
          task_type: 'implementation',
          difficulty: 'routine',
          skill: 'implementation',
        },
        source: {
          url: 'https://example.com/fixture',
          title: 'Fixture',
          accessed_at: '2026-10-27T00:00:00Z',
        },
        assessment: { kind: 'qualitative', summary: 'Fixture only.', trial_fit: 'supports' },
        estimates: {
          kind: 'unobserved_estimate',
          cost_usd: 0.01,
          wall_seconds: 10,
          basis: 'Fixture estimate.',
        },
      },
    ],
  };
  const created = (await commands.integrated_create.run({ run_file: runFile, request })) as {
    created: boolean;
  };
  assert.equal(created.created, true);
  const stored = JSON.parse(await readFile(runFile, 'utf8'));
  assert.equal(
    stored.external_inputs.integrated_original_brief.planning_limits.max_trial_assignments,
    1,
  );
  assert.equal(
    stored.external_inputs.integrated_original_brief.planning_limits.unproven_routes,
    'sourced-trial',
  );
  const reservation = (await commands.integrated_reserve.run({
    run_file: runFile,
    request: {
      packet_id: 'handover',
      expected_revision: 0,
      actor_context: '/host',
      owner_context: '/worker',
      reviewer_context: '/host',
      contributor_contexts: [],
    },
  })) as { launch: { optimizer_job: Harness2Job; experience: { status: string } } };
  assert.equal(reservation.launch.optimizer_job.policy.enabled, true);
  assert.equal(reservation.launch.experience.status, 'not-requested');
  const job = reservation.launch.optimizer_job;
  jobFile = path.join(dir, `${job.job_id}.json`);
  assert.equal(
    (
      (await commands.optimizer_save_job.run({
        run_file: runFile,
        request: { job, job_file: jobFile },
      })) as { status: string }
    ).status,
    'saved',
  );
  assert.equal(
    (
      (await commands.optimizer_save_job.run({
        run_file: runFile,
        request: { job, job_file: jobFile },
      })) as { status: string }
    ).status,
    'saved',
  );
  assert.equal(JSON.parse(await readFile(jobFile, 'utf8')).job_fingerprint, job.job_fingerprint);
  await assert.rejects(
    () =>
      commands.optimizer_save_job.run({
        run_file: runFile,
        request: {
          job: { ...job, owner_context: '/impostor' },
          job_file: jobFile,
        },
      }) as Promise<unknown>,
    /fingerprint/,
  );
  const report = {
    status: 'ready-for-submission',
    job_id: job.job_id,
    job_fingerprint: job.job_fingerprint,
    evidence_kind: 'simulation',
    supervisor_review: {
      actor_context: '/host',
      decision: 'accepted',
      reason: 'Fixture review.',
      evidence: [{ reference: 'fixture-review', summary: 'Fixture.' }],
    },
    outputs: [{ id: 'result', reference: 'fixture-result', summary: 'Fixture.' }],
    evidence: [{ reference: 'fixture-evidence', summary: 'Fixture.' }],
  };
  const submitted = (await commands.integrated_optimizer_submit.run({
    run_file: runFile,
    request: { job, report, expected_revision: 2 },
  })) as { status: string; revision: number };
  assert.equal(submitted.status, 'submitted-for-ordinary-review');
  assert.equal(submitted.revision, 3);
  assert.equal(JSON.parse(await readFile(runFile, 'utf8')).packets.handover.status, 'in_review');
});

test('snapshot tool reports the same fingerprint for matching isolated content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'hak-snapshot-integrated-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  await mkdir(a);
  await mkdir(b);
  await writeFile(path.join(a, 'x.txt'), 'same');
  await writeFile(path.join(b, 'x.txt'), 'same');
  t.after(async () => {
    await unlink(path.join(a, 'x.txt'));
    await unlink(path.join(b, 'x.txt'));
    await rmdir(a);
    await rmdir(b);
    await rmdir(root);
  });
  const first = (await commands.optimizer_snapshot.run({ snapshot: a })) as { fingerprint: string };
  const second = (await commands.optimizer_snapshot.run({ snapshot: b })) as {
    fingerprint: string;
  };
  assert.equal(first.fingerprint, second.fingerprint);
});
