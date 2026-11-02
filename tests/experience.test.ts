import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareDispatch } from '../lib/dispatch.ts';
import {
  experienceProfileId,
  lookupAcceptedExperience,
  registerAcceptedExperience,
} from '../lib/experience.ts';
import {
  createHarness2Job,
  type Harness2Report,
  proposeImprovementSubmission,
} from '../lib/learning.ts';
import type { BriefInput } from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';

test('only supervisor-accepted matching experience enters an explicitly requested later dispatch', async (t) => {
  const brief: BriefInput = {
    run_id: 'experience-fixture',
    objective: 'Fixture task.',
    domain: 'software-engineering',
    lead_context: '/supervisor',
    evidence_kind: 'simulation',
    acceptance: ['Fixture accepted.'],
    constraints: [],
    improvement: { enabled: true, scope: 'fixture-scope', max_host_calls: 9 },
    work_items: [
      {
        id: 'work',
        objective: 'Deliver fixture.',
        task_type: 'implementation',
        difficulty: 'standard',
        skills: ['implementation'],
        depends_on: [],
        writes: ['out'],
        outputs: ['result'],
        acceptance: ['Checked.'],
      },
    ],
  };
  let run = createRun(null, brief);
  run = applyEvent(run, {
    id: 'assign',
    type: 'assign',
    expected_revision: 0,
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/supervisor',
    assignment: {
      owner_context: '/worker',
      reviewer_context: '/supervisor',
      contributor_contexts: [],
      writes: ['out'],
      model_id: 'fixture-model',
      route: 'fixture',
      effort: 'medium',
    },
  });
  const job = createHarness2Job(run, prepareDispatch(run, 'handover'));
  run = applyEvent(run, {
    id: 'start',
    type: 'start',
    expected_revision: 1,
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/worker',
  });
  const profile = experienceProfileId(job);
  const report: Harness2Report & { learned: boolean; profile_id: string } = {
    status: 'ready-for-submission',
    job_id: job.job_id,
    job_fingerprint: job.job_fingerprint,
    evidence_kind: 'simulation',
    learned: true,
    profile_id: profile,
    supervisor_review: {
      actor_context: '/supervisor',
      decision: 'accepted',
      reason: 'Fixture decision.',
      evidence: [{ reference: 'fixture-adoption', summary: 'Fixture.' }],
    },
    outputs: [{ id: 'result', reference: 'fixture-result', summary: 'Fixture.' }],
    evidence: [{ reference: 'fixture-check', summary: 'Fixture.' }],
  };
  const state = await mkdtemp(path.join(tmpdir(), 'hak-experience-'));
  const library = path.join(state, 'library', profile, 'harnesses', job.job_id);
  const source = path.join(library, 'EXPERIENCE.md');
  const index = path.join(state, 'integrated-experiences', profile);
  const indexFile = path.join(index, `${job.job_id}.json`);
  t.after(async () => {
    for (const filename of [source, indexFile])
      try {
        await unlink(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    for (const directory of [
      library,
      path.dirname(library),
      path.dirname(path.dirname(library)),
      path.join(state, 'library'),
      index,
      path.dirname(index),
      state,
    ])
      try {
        await rmdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
  });
  await mkdir(library, { recursive: true });
  await writeFile(source, '# Fixture experience\n\nPreserve the observed task boundary.\n');
  await assert.rejects(
    () =>
      registerAcceptedExperience(run, job, report, {
        actor_context: '/supervisor',
        evidence_reference: 'fixture',
        state_dir: state,
      }),
    /must be accepted/,
  );
  const proposal = proposeImprovementSubmission(run, job, report);
  run = applyEvent(run, proposal.event);
  run = applyEvent(run, {
    id: 'review',
    type: 'review',
    expected_revision: 3,
    packet_id: 'handover',
    attempt: 1,
    actor_context: '/supervisor',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'fixture', note: 'Checked.' }],
    task_checks: [{ index: 0, result: 'pass', evidence_reference: 'fixture', note: 'Accepted.' }],
  });
  await assert.rejects(
    () =>
      registerAcceptedExperience(run, job, report, {
        actor_context: '/worker',
        evidence_reference: 'fixture',
        state_dir: state,
      }),
    /direct supervisor/,
  );
  const registered = await registerAcceptedExperience(run, job, report, {
    actor_context: '/supervisor',
    evidence_reference: 'fixture-review',
    state_dir: state,
  });
  assert.equal(registered.status, 'registered');
  assert.equal(
    (
      await registerAcceptedExperience(run, job, report, {
        actor_context: '/supervisor',
        evidence_reference: 'fixture-review',
        state_dir: state,
      })
    ).status,
    'registered',
  );
  const found = await lookupAcceptedExperience(run, run.packets.handover, 'fixture-scope', state);
  assert.equal(found.status, 'available');
  assert.equal(found.entries.length, 1);
  const live = structuredClone(run);
  live.evidence_kind = 'local_work';
  assert.equal(
    (await lookupAcceptedExperience(live, live.packets.handover, 'fixture-scope', state)).status,
    'empty',
  );
  await writeFile(source, 'changed after approval');
  assert.equal(
    (await lookupAcceptedExperience(run, run.packets.handover, 'fixture-scope', state)).status,
    'partial',
  );
});
