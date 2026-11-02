import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commands } from '../lib/commands.ts';
import { prepareDispatch } from '../lib/dispatch.ts';
import { createHarness2Job } from '../lib/learning.ts';
import type { BriefInput, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';
import {
  type BridgeRunner,
  claimHarness2Request,
  completeHarness2Request,
  driveHarness2,
  fingerprintHarness2Snapshot,
  type HostDriverOptions,
  type HostRequest,
  nextHarness2Step,
  rejectedHarness2Baseline,
  type StepIsolation,
} from '../packages/optimizer/src/host-driver.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const exists = async (filename: string) =>
  readFile(filename).then(
    () => true,
    () => false,
  );
const read = async (filename: string): Promise<unknown> =>
  JSON.parse(await readFile(filename, 'utf8'));

function makeJob() {
  const brief: BriefInput = {
    run_id: 'fixture-driver',
    objective: 'Produce a bounded artifact.',
    domain: 'software-engineering',
    lead_context: 'supervisor',
    evidence_kind: 'simulation',
    constraints: [],
    acceptance: ['Artifact is checked.'],
    improvement: { enabled: true, scope: 'fixture' },
    work_items: [
      {
        id: 'artifact',
        objective: 'Produce the artifact.',
        task_type: 'implementation',
        difficulty: 'routine',
        skills: ['implementation'],
        depends_on: [],
        inputs: ['task_brief'],
        writes: ['artifact'],
        outputs: ['result'],
        acceptance: ['Artifact is checked.'],
      },
    ],
  };
  let run = createRun(null, brief);
  run = applyEvent(run, {
    id: 'assignment',
    expected_revision: 0,
    packet_id: 'handover',
    attempt: 1,
    actor_context: 'supervisor',
    type: 'assign',
    assignment: {
      owner_context: 'worker',
      reviewer_context: 'supervisor',
      contributor_contexts: [],
      writes: ['artifact'],
      model_id: 'fixture-model',
      route: 'fixture-route',
    },
  } as WorkflowEvent);
  return createHarness2Job(run, prepareDispatch(run, 'handover'));
}

type Job = ReturnType<typeof makeJob>;
type Kind = 'execute' | 'edit' | 'adoption-review' | 'experience';
function requestFor(job: Job, kind: Kind, label: string): HostRequest {
  const payload =
    kind === 'execute'
      ? { dispatch: job.dispatch, harness: job.base_harness, isolated_workspace_required: true }
      : kind === 'adoption-review'
        ? { contract: job.dispatch }
        : { context: {} };
  const body = {
    version: 1 as const,
    job_id: job.job_id,
    job_fingerprint: job.job_fingerprint,
    kind,
    label,
    actor_context: (kind === 'execute' || kind === 'edit'
      ? job.owner_context
      : job.supervisor_context) as string,
    payload,
  };
  const request_fingerprint = digest(body);
  return {
    ...body,
    request_fingerprint,
    request_id: `request-${request_fingerprint.slice(0, 32)}`,
  };
}

async function fixture(sequence: Kind[] = ['execute', 'edit', 'adoption-review', 'experience']) {
  const root = await mkdtemp(path.join(tmpdir(), 'h2-host-driver-'));
  const state = path.join(root, 'state');
  const live = path.join(root, 'live');
  const isolation = path.join(root, 'isolation');
  const session = path.join(state, 'sessions', 'a'.repeat(64));
  const requests = path.join(session, 'requests');
  const responses = path.join(session, 'responses');
  for (const dir of [state, live, isolation, requests, responses])
    await mkdir(dir, { recursive: true });
  const job = makeJob();
  const jobFile = path.join(root, 'job.json');
  await writeFile(jobFile, JSON.stringify(job));
  await writeFile(path.join(session, 'input.json'), JSON.stringify(job));
  const inputs = sequence.map((kind, index) => requestFor(job, kind, `${kind}-${index}`));
  const bridge: BridgeRunner = async () => {
    for (const request of inputs) {
      const name = `${request.request_id}.json`;
      if (!(await exists(path.join(requests, name))))
        await writeFile(path.join(requests, name), JSON.stringify(request));
      const response = path.join(responses, name);
      if (!(await exists(response)))
        return {
          status: 'needs-host',
          job_id: job.job_id,
          session,
          response_directory: responses,
          pending_requests: [path.join(requests, name)],
        };
      const saved = (await read(response)) as Record<string, unknown>;
      if (saved.status !== 'completed')
        return { status: 'blocked', reason: 'Host execution failed.' };
      if (request.kind === 'adoption-review' && saved.decision === 'rejected') {
        const report = {
          status: 'rejected',
          learned: false,
          job_id: job.job_id,
          job_fingerprint: job.job_fingerprint,
          evidence_kind: job.evidence_kind,
          supervisor_review: {
            actor_context: job.supervisor_context,
            decision: 'rejected',
            reason: saved.reason,
            evidence: saved.evidence,
          },
        };
        await writeFile(path.join(session, 'report.json'), JSON.stringify(report));
        return report;
      }
    }
    return {
      status: 'ready-for-submission',
      job_id: job.job_id,
      job_fingerprint: job.job_fingerprint,
      evidence_kind: job.evidence_kind,
      supervisor_review: {
        actor_context: job.supervisor_context,
        decision: 'accepted',
        reason: 'Checked.',
        evidence: [{ reference: 'fixture:review', summary: 'Observed.' }],
      },
      outputs: [{ id: 'result', reference: 'fixture:result', summary: 'Test.' }],
      evidence: [{ reference: 'fixture:check', summary: 'Test.' }],
      observed_cost_usd: 0,
      cost_evidence_complete: false,
      upstream_cost_placeholder_used: true,
      cost_comparison_allowed: false,
    };
  };
  const observed: string[] = [];
  const fingerprint = 'b'.repeat(64);
  const options: HostDriverOptions = {
    job,
    job_file: jobFile,
    state_dir: state,
    run_bridge: bridge,
    isolation: {
      root: isolation,
      live_workspace: live,
      source_fingerprint: fingerprint,
      prepare: async (request) => {
        const workspace = path.join(isolation, request.request_id);
        await mkdir(workspace);
        return { workspace, source_fingerprint: fingerprint };
      },
      verify: async () => fingerprint,
    },
    handle: async (request) => {
      observed.push(request.request_id);
      const common = {
        request_id: request.request_id,
        request_fingerprint: request.request_fingerprint,
        actor_context: request.actor_context,
        status: 'completed' as const,
        cost_usd: null,
      };
      if (request.kind === 'execute')
        return {
          ...common,
          model_id: 'fixture-model',
          outputs: [{ id: 'result', reference: 'fixture:result', summary: 'Test.', text: 'done' }],
          evidence: [{ reference: 'fixture:check', summary: 'Checked.' }],
          trajectory: 'Observed test.',
        };
      if (request.kind === 'adoption-review')
        return {
          ...common,
          decision: 'accepted',
          reason: 'Checked.',
          evidence: [{ reference: 'fixture:review', summary: 'Checked.' }],
        };
      return { ...common, text: 'Test response.', harness: job.base_harness };
    },
  };
  return { root, state, session, requests, responses, inputs, job, jobFile, options, observed };
}

test('explicit host drives bounded requests, preserves unknown costs and resumes without repeating calls', async () => {
  const f = await fixture();
  const first = await driveHarness2(f.options);
  assert.equal(first.status, 'ready-for-submission');
  assert.equal(first.processed, 4);
  assert.equal(f.observed.length, 4);
  assert.equal(new Set(f.observed).size, 4);
  if (first.status === 'ready-for-submission') {
    assert.equal((first.report as unknown as Record<string, unknown>).observed_cost_usd, null);
    assert.equal(
      (first.report as unknown as Record<string, unknown>).cost_comparison_allowed,
      false,
    );
    assert.match(first.boundary, /does not accept the ordinary task/);
  }
  const second = await driveHarness2(f.options);
  assert.equal(second.status, 'ready-for-submission');
  assert.equal(second.processed, 0);
  assert.equal(f.observed.length, 4);
});

test('supervisor rejection stops without accepting or creating further calls', async () => {
  const f = await fixture();
  const handle = f.options.handle;
  f.options.handle = async (request, execution) => {
    const response = await handle(request, execution);
    return request.kind === 'adoption-review' ? { ...response, decision: 'rejected' } : response;
  };
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'rejected');
  assert.equal(result.processed, 3);
  assert.equal(f.observed.length, 3);
});

test('an uncertain callback is not automatically invoked a second time', async () => {
  const f = await fixture(['execute']);
  let calls = 0;
  f.options.handle = async () => {
    calls++;
    throw new Error('The host response was lost.');
  };
  const first = await driveHarness2(f.options);
  assert.equal(first.status, 'uncertain-execution');
  const second = await driveHarness2(f.options);
  assert.equal(second.status, 'uncertain-execution');
  assert.equal(calls, 1);
});

test('a response without its original receipt remains uncertain and is not backfilled', async () => {
  const f = await fixture(['edit']);
  let calls = 0;
  f.options.handle = async () => {
    calls++;
    throw new Error('The host result was lost.');
  };
  assert.equal((await driveHarness2(f.options)).status, 'uncertain-execution');
  const request = f.inputs[0];
  await writeFile(
    path.join(f.responses, `${request.request_id}.json`),
    JSON.stringify({
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      actor_context: request.actor_context,
      status: 'completed',
      cost_usd: null,
      text: 'Observed result.',
    }),
  );
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'uncertain-execution');
  assert.equal(result.processed, 0);
  assert.equal(calls, 1);
  assert.equal(
    await exists(path.join(f.session, 'host-receipts', `${request.request_id}.json`)),
    false,
  );
});

test('a second host driver cannot dispatch while the first holds its state lock', async () => {
  const f = await fixture(['edit']);
  let release: () => void = () => {};
  let notify: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const handler = f.options.handle;
  f.options.handle = async (request, execution) => {
    notify();
    await held;
    return handler(request, execution);
  };
  const first = driveHarness2(f.options);
  await started;
  const second = await driveHarness2(f.options);
  assert.equal(second.status, 'blocked');
  assert.match(second.status === 'blocked' ? second.reason : '', /lock/);
  release();
  assert.equal((await first).status, 'ready-for-submission');
  assert.equal(f.observed.length, 1);
});

test('wrong actors, changed request fingerprints and escaped pending paths never invoke a host', async () => {
  for (const fault of ['actor', 'fingerprint', 'path']) {
    const f = await fixture(['edit']);
    const request = f.inputs[0];
    if (fault === 'actor') {
      request.actor_context = 'other';
      const { request_id: _id, request_fingerprint: _fingerprint, ...body } = request;
      request.request_fingerprint = digest(body);
      request.request_id = `request-${request.request_fingerprint.slice(0, 32)}`;
    }
    if (fault === 'fingerprint') request.payload = { changed: true };
    if (fault === 'path')
      f.options.run_bridge = async () => ({
        status: 'needs-host',
        job_id: f.job.job_id,
        session: f.session,
        response_directory: f.responses,
        pending_requests: [path.join(f.root, `${request.request_id}.json`)],
      });
    const result = await driveHarness2(f.options);
    assert.equal(result.status, 'blocked');
    if (fault === 'actor' && result.status === 'blocked') assert.match(result.reason, /authority/);
    assert.equal(f.observed.length, 0);
  }
});

test('Python-formatted small floating-point numbers preserve the request fingerprint', async () => {
  const f = await fixture(['edit']);
  const request = f.inputs[0];
  request.payload = { ratio: 1e-7 };
  const { request_id: _id, request_fingerprint: _fingerprint, ...body } = request;
  const pythonCanonical = canonical(body).replace('1e-7', '1e-07');
  request.request_fingerprint = createHash('sha256').update(pythonCanonical).digest('hex');
  request.request_id = `request-${request.request_fingerprint.slice(0, 32)}`;
  const runner = f.options.run_bridge as BridgeRunner;
  f.options.run_bridge = async (invocation) => {
    const result = await runner(invocation);
    if (result.status === 'needs-host') {
      const filename = path.join(f.requests, `${request.request_id}.json`);
      const text = await readFile(filename, 'utf8');
      await writeFile(filename, text.replace('1e-7', '1e-07'));
    }
    return result;
  };
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'ready-for-submission');
  assert.equal(f.observed.length, 1);
});

test('the host stops before dispatch when stored requests exceed the job ceiling', async () => {
  const f = await fixture(['edit']);
  assert.equal(f.job.policy.enabled, true);
  if (!f.job.policy.enabled) return;
  for (let index = 0; index < f.job.policy.max_host_calls; index++) {
    await writeFile(path.join(f.requests, `extra-${index}.json`), '{}');
  }
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reason : '', /ceiling/);
  assert.equal(f.observed.length, 0);
});

test('executions require a verified isolated snapshot, not the live workspace', async () => {
  const f = await fixture(['execute']);
  assert.ok(f.options.isolation);
  f.options.isolation.verify = async () => 'c'.repeat(64);
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reason : '', /snapshot/);
  assert.equal(f.observed.length, 0);
});

test('missing Python is reported as unavailable without invoking the host', async () => {
  const f = await fixture([]);
  delete f.options.run_bridge;
  f.options.python = path.join(f.root, 'missing-python');
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'unavailable');
  assert.equal(f.observed.length, 0);
});

test('a missing configured upstream checkout is reported as unavailable', async () => {
  const f = await fixture([]);
  delete f.options.run_bridge;
  f.options.upstream = path.join(f.root, 'missing-upstream');
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'unavailable');
  assert.match(result.status === 'unavailable' ? result.reason : '', /checkout is unavailable/);
  assert.equal(f.observed.length, 0);
});

test('a modified saved job fails before any host execution', async () => {
  const f = await fixture([]);
  await writeFile(f.jobFile, JSON.stringify({ ...f.job, objective: 'different' }));
  await assert.rejects(driveHarness2(f.options), /Saved job differs/);
  assert.equal(f.observed.length, 0);
});

test('an incomplete adoption review cannot be promoted to a submission', async () => {
  const f = await fixture([]);
  f.options.run_bridge = async () => ({
    status: 'ready-for-submission',
    job_id: f.job.job_id,
    job_fingerprint: f.job.job_fingerprint,
    evidence_kind: f.job.evidence_kind,
    supervisor_review: { actor_context: f.job.supervisor_context, decision: 'accepted' },
    outputs: [{ id: 'result', reference: 'fixture:result', summary: 'Test.' }],
    evidence: [{ reference: 'fixture:check', summary: 'Test.' }],
  });
  const result = await driveHarness2(f.options);
  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reason : '', /review needs a reason/);
});

test('real pinned upstream completes its host protocol with deterministic isolated fixture replies', {
  skip: !process.env.HAKENGAISYA_HARNESS2_SOURCE,
}, async () => {
  const f = await fixture();
  delete f.options.run_bridge;
  f.options.upstream = process.env.HAKENGAISYA_HARNESS2_SOURCE;
  f.options.state_dir = path.join(f.root, 'real-state');
  await mkdir(f.options.state_dir);
  f.options.handle = async (request, execution) => {
    f.observed.push(request.request_id);
    const common = {
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      actor_context: request.actor_context,
      status: 'completed' as const,
      cost_usd: null,
    };
    if (request.kind === 'execute') {
      assert.ok(execution?.workspace);
      return {
        ...common,
        cost_usd: 1e-7,
        model_id: f.job.dispatch.model_binding.model_id,
        outputs: [
          {
            id: 'result',
            reference: 'fixture:result',
            summary: 'Deterministic fixture.',
            text: 'Fixture result.',
          },
        ],
        evidence: [{ reference: 'fixture:check', summary: 'Fixture check.' }],
        trajectory: 'Fixture trajectory.',
      };
    }
    if (request.kind === 'adoption-review')
      return {
        ...common,
        decision: 'accepted',
        reason: 'Fixture adoption.',
        evidence: [{ reference: 'fixture:review', summary: 'Fixture review.' }],
      };
    if (request.kind === 'experience')
      return {
        ...common,
        text: '<edits>Scoped fixture.</edits>\n<experience>\ncue: A fixture task\nlesson: Keep the contract\nevidence: The fixture result\n</experience>',
      };
    return {
      ...common,
      text: '<notes>Scoped fixture edit.</notes>',
      harness: {
        ...f.job.base_harness,
        'systemprompt.md': 'Complete the fixed fixture task and report evidence.\n',
      },
    };
  };
  const first = await driveHarness2(f.options);
  assert.equal(
    first.status,
    'ready-for-submission',
    first.status === 'blocked' ||
      first.status === 'unavailable' ||
      first.status === 'uncertain-execution'
      ? first.reason
      : undefined,
  );
  assert.equal(first.processed, 9);
  assert.equal(f.observed.length, 9);
  if (first.status === 'ready-for-submission') {
    const report = first.report as unknown as Record<string, unknown>;
    assert.equal(report.observed_cost_usd, null);
    assert.equal(report.upstream_cost_placeholder_used, true);
    assert.equal(report.cost_comparison_allowed, false);
  }
  const again = await driveHarness2(f.options);
  assert.equal(again.status, 'ready-for-submission');
  assert.equal(again.processed, 0);
  assert.equal(f.observed.length, 9);
});

test('model-mediated steps require a claim and preserve an idempotent response', async () => {
  const f = await fixture(['edit']);
  const options = { job_file: f.jobFile, state_dir: f.state, run_bridge: f.options.run_bridge };
  const pending = await nextHarness2Step(options);
  assert.equal(pending.status, 'needs-host');
  if (pending.status !== 'needs-host') return;
  assert.equal(pending.requests.length, 1);
  assert.equal(pending.requests[0].claimed, false);
  assert.equal(Object.hasOwn(pending.requests[0], 'payload'), false);
  const request_id = pending.requests[0].request_id;
  const unclaimed = await completeHarness2Request({
    ...options,
    session: pending.session,
    request_id,
    response: {
      request_id,
      request_fingerprint: pending.requests[0].request_fingerprint,
      actor_context: 'worker',
      status: 'completed',
      cost_usd: null,
      text: 'Observed.',
    },
  });
  assert.equal(unclaimed.status, 'blocked');
  const claimed = await claimHarness2Request({ ...options, session: pending.session, request_id });
  assert.equal(claimed.status, 'claimed');
  if (claimed.status !== 'claimed') return;
  const inFlight = await nextHarness2Step(options);
  assert.equal(inFlight.status, 'needs-host');
  if (inFlight.status === 'needs-host') assert.equal(inFlight.requests[0].claimed, true);
  assert.equal(
    (await claimHarness2Request({ ...options, session: pending.session, request_id })).status,
    'uncertain-execution',
  );
  const response = {
    request_id,
    request_fingerprint: claimed.request.request_fingerprint,
    actor_context: claimed.request.actor_context,
    status: 'completed' as const,
    cost_usd: null,
    text: 'Observed.',
  };
  const wrongActor = await completeHarness2Request({
    ...options,
    session: pending.session,
    request_id,
    response: { ...response, actor_context: 'someone-else' },
  });
  assert.equal(wrongActor.status, 'blocked');
  assert.equal(
    (await completeHarness2Request({ ...options, session: pending.session, request_id, response }))
      .status,
    'submitted',
  );
  assert.equal(
    (await completeHarness2Request({ ...options, session: pending.session, request_id, response }))
      .status,
    'already-submitted',
  );
  assert.equal(
    (
      await completeHarness2Request({
        ...options,
        session: pending.session,
        request_id,
        response: { ...response, text: 'Changed.' },
      })
    ).status,
    'blocked',
  );
  assert.equal((await nextHarness2Step(options)).status, 'ready-for-submission');
});

test('a step response written without its immutable receipt remains uncertain', async () => {
  const f = await fixture(['edit']);
  const options = { job_file: f.jobFile, state_dir: f.state, run_bridge: f.options.run_bridge };
  const pending = await nextHarness2Step(options);
  assert.equal(pending.status, 'needs-host');
  if (pending.status !== 'needs-host') return;
  const request_id = pending.requests[0].request_id;
  const claimed = await claimHarness2Request({ ...options, session: pending.session, request_id });
  assert.equal(claimed.status, 'claimed');
  if (claimed.status !== 'claimed') return;
  const response = {
    request_id,
    request_fingerprint: claimed.request.request_fingerprint,
    actor_context: claimed.request.actor_context,
    status: 'completed' as const,
    cost_usd: null,
    text: 'Completed before crash.',
  };
  await writeFile(path.join(f.responses, `${request_id}.json`), JSON.stringify(response));
  const result = await completeHarness2Request({
    ...options,
    session: pending.session,
    request_id,
    response,
  });
  assert.equal(result.status, 'uncertain-execution');
  assert.equal(await exists(path.join(f.session, 'host-receipts', `${request_id}.json`)), false);
  assert.equal((await nextHarness2Step(options)).status, 'uncertain-execution');
});

test('a validly fingerprinted but non-pending request cannot be claimed', async () => {
  const f = await fixture(['edit']);
  const options = { job_file: f.jobFile, state_dir: f.state, run_bridge: f.options.run_bridge };
  const pending = await nextHarness2Step(options);
  assert.equal(pending.status, 'needs-host');
  if (pending.status !== 'needs-host') return;
  const forged = requestFor(f.job, 'edit', 'not-issued-by-bridge');
  await writeFile(path.join(f.requests, `${forged.request_id}.json`), JSON.stringify(forged));
  const result = await claimHarness2Request({
    ...options,
    session: pending.session,
    request_id: forged.request_id,
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reason : '', /no longer pending/);
});

test('claim reports the bridge failure rather than hiding its reason', async () => {
  const f = await fixture(['edit']);
  const options = { job_file: f.jobFile, state_dir: f.state, run_bridge: f.options.run_bridge };
  const pending = await nextHarness2Step(options);
  assert.equal(pending.status, 'needs-host');
  if (pending.status !== 'needs-host') return;
  const result = await claimHarness2Request({
    ...options,
    run_bridge: async () => ({ status: 'blocked', reason: 'Original bridge diagnostic.' }),
    session: pending.session,
    request_id: pending.requests[0].request_id,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.status === 'blocked' ? result.reason : '', 'Original bridge diagnostic.');
});

test('step execution claims verify source bytes, isolation, and distinct probe workspaces', async () => {
  const f = await fixture(['execute', 'execute']);
  const options = { job_file: f.jobFile, state_dir: f.state, run_bridge: f.options.run_bridge };
  const snapshot = path.join(f.root, 'snapshot');
  const firstWorkspace = path.join(f.root, 'isolation', 'first');
  const live = path.join(f.root, 'live');
  await mkdir(snapshot);
  await mkdir(firstWorkspace);
  await writeFile(path.join(snapshot, 'input.txt'), 'fixed source');
  await writeFile(path.join(firstWorkspace, 'input.txt'), 'wrong source');
  const source_fingerprint = await fingerprintHarness2Snapshot(snapshot);
  const pending = await nextHarness2Step(options);
  assert.equal(pending.status, 'needs-host');
  if (pending.status !== 'needs-host') return;
  const request_id = pending.requests[0].request_id;
  const isolation = {
    root: path.join(f.root, 'isolation'),
    live_workspace: live,
    snapshot,
    workspace: firstWorkspace,
    source_fingerprint,
  };
  assert.equal(
    (await claimHarness2Request({ ...options, session: pending.session, request_id, isolation }))
      .status,
    'blocked',
  );
  await writeFile(path.join(firstWorkspace, 'input.txt'), 'fixed source');
  const first = await claimHarness2Request({
    ...options,
    session: pending.session,
    request_id,
    isolation,
  });
  assert.equal(first.status, 'claimed');
  if (first.status !== 'claimed') return;
  assert.equal(first.execution?.source_fingerprint, source_fingerprint);
  const response = {
    request_id,
    request_fingerprint: first.request.request_fingerprint,
    actor_context: first.request.actor_context,
    status: 'completed' as const,
    cost_usd: null,
    model_id: 'fixture-model',
    outputs: [{ id: 'result', reference: 'fixture:result', summary: 'Test.', text: 'done' }],
    evidence: [{ reference: 'fixture:check', summary: 'Checked.' }],
    trajectory: 'Fixture.',
  };
  await writeFile(path.join(snapshot, 'input.txt'), 'changed source');
  const changedSnapshot = await completeHarness2Request({
    ...options,
    session: pending.session,
    request_id,
    response,
  });
  assert.equal(changedSnapshot.status, 'blocked');
  assert.match(
    changedSnapshot.status === 'blocked' ? changedSnapshot.reason : '',
    /snapshot changed/,
  );
  await writeFile(path.join(snapshot, 'input.txt'), 'fixed source');
  assert.equal(
    (await completeHarness2Request({ ...options, session: pending.session, request_id, response }))
      .status,
    'submitted',
  );
  const second = await nextHarness2Step(options);
  assert.equal(second.status, 'needs-host');
  if (second.status !== 'needs-host') return;
  const reused = await claimHarness2Request({
    ...options,
    session: second.session,
    request_id: second.requests[0].request_id,
    isolation,
  });
  assert.equal(reused.status, 'blocked');
  assert.match(reused.status === 'blocked' ? reused.reason : '', /distinct/);
});

test('real pinned upstream can be advanced one explicit model-mediated step at a time', {
  skip: !process.env.HAKENGAISYA_HARNESS2_SOURCE,
}, async () => {
  const f = await fixture();
  const options = {
    job_file: f.jobFile,
    state_dir: path.join(f.root, 'real-step-state'),
    upstream: process.env.HAKENGAISYA_HARNESS2_SOURCE,
  };
  await mkdir(options.state_dir);
  const snapshot = path.join(f.root, 'frozen-source');
  await mkdir(snapshot);
  await writeFile(path.join(snapshot, 'input.txt'), 'frozen fixture');
  const source_fingerprint = await fingerprintHarness2Snapshot(snapshot);
  let count = 0;
  for (;;) {
    const next = await nextHarness2Step(options);
    if (next.status === 'ready-for-submission') {
      assert.equal(next.report.observed_cost_usd, null);
      assert.equal(next.report.upstream_cost_placeholder_used, true);
      assert.equal(next.report.cost_comparison_allowed, false);
      break;
    }
    assert.equal(
      next.status,
      'needs-host',
      next.status === 'blocked' || next.status === 'unavailable' ? next.reason : undefined,
    );
    if (next.status !== 'needs-host') return;
    for (const pending of next.requests) {
      assert.equal(pending.claimed, false);
      let isolation: StepIsolation | undefined;
      if (pending.kind === 'execute') {
        const workspace = path.join(f.root, 'isolation', pending.request_id);
        await mkdir(workspace);
        await writeFile(path.join(workspace, 'input.txt'), 'frozen fixture');
        isolation = {
          root: path.join(f.root, 'isolation'),
          live_workspace: path.join(f.root, 'live'),
          snapshot,
          workspace,
          source_fingerprint,
        };
      }
      const claimed = await claimHarness2Request({
        ...options,
        session: next.session,
        request_id: pending.request_id,
        isolation,
      });
      assert.equal(
        claimed.status,
        'claimed',
        claimed.status === 'blocked' ? claimed.reason : undefined,
      );
      if (claimed.status !== 'claimed') return;
      const request = claimed.request;
      const common = {
        request_id: request.request_id,
        request_fingerprint: request.request_fingerprint,
        actor_context: request.actor_context,
        status: 'completed' as const,
        cost_usd: null,
      };
      const response =
        request.kind === 'execute'
          ? {
              ...common,
              model_id: 'fixture-model',
              outputs: [
                {
                  id: 'result',
                  reference: 'fixture:result',
                  summary: 'Fixture.',
                  text: 'Fixture result.',
                },
              ],
              evidence: [{ reference: 'fixture:check', summary: 'Fixture.' }],
              trajectory: 'Fixture trajectory.',
            }
          : request.kind === 'adoption-review'
            ? {
                ...common,
                decision: 'accepted',
                reason: 'Fixture review.',
                evidence: [{ reference: 'fixture:review', summary: 'Fixture.' }],
              }
            : request.kind === 'experience'
              ? {
                  ...common,
                  text: '<edits>Fixture.</edits>\n<experience>\ncue: A fixture\nlesson: Preserve contract\nevidence: Fixture result\n</experience>',
                }
              : {
                  ...common,
                  text: '<notes>Fixture edit.</notes>',
                  harness: {
                    ...f.job.base_harness,
                    'systemprompt.md': 'Complete the fixed fixture task and report evidence.\n',
                  },
                };
      assert.equal(
        (
          await completeHarness2Request({
            ...options,
            session: next.session,
            request_id: pending.request_id,
            response,
          })
        ).status,
        'submitted',
      );
      count++;
    }
  }
  assert.equal(count, 9);
  const resumed = await nextHarness2Step(options);
  assert.equal(resumed.status, 'ready-for-submission');
});

async function rejectedFixture() {
  const f = await fixture(['execute', 'adoption-review']);
  f.inputs[0] = requestFor(f.job, 'execute', 'base1');
  const options = { job_file: f.jobFile, state_dir: f.state, run_bridge: f.options.run_bridge };
  const snapshot = path.join(f.root, 'baseline-snapshot');
  const workspace = path.join(f.root, 'isolation', 'baseline');
  await mkdir(snapshot);
  await mkdir(workspace);
  await writeFile(path.join(snapshot, 'input.txt'), 'frozen baseline');
  await writeFile(path.join(workspace, 'input.txt'), 'frozen baseline');
  const source_fingerprint = await fingerprintHarness2Snapshot(snapshot);
  const isolation = {
    root: path.join(f.root, 'isolation'),
    live_workspace: path.join(f.root, 'live'),
    snapshot,
    workspace,
    source_fingerprint,
  };
  for (let index = 0; index < 2; index++) {
    const next = await nextHarness2Step(options);
    assert.equal(next.status, 'needs-host');
    if (next.status !== 'needs-host') throw new Error('Expected a host request');
    const pending = next.requests[0];
    const claimed = await claimHarness2Request({
      ...options,
      session: next.session,
      request_id: pending.request_id,
      isolation: pending.kind === 'execute' ? isolation : undefined,
    });
    assert.equal(claimed.status, 'claimed');
    if (claimed.status !== 'claimed') throw new Error('Expected a claimed request');
    const request = claimed.request;
    const common = {
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      actor_context: request.actor_context,
      status: 'completed' as const,
      cost_usd: null,
    };
    const response =
      request.kind === 'execute'
        ? {
            ...common,
            model_id: 'fixture-model',
            outputs: [
              {
                id: 'result',
                reference: 'fixture:baseline',
                summary: 'Baseline artifact.',
                text: 'Original baseline content.',
              },
            ],
            evidence: [{ reference: 'fixture:baseline-check', summary: 'Baseline check.' }],
            trajectory: 'Actual baseline fixture trajectory.',
          }
        : {
            ...common,
            decision: 'rejected',
            reason: 'Candidate did not improve the baseline.',
            evidence: [{ reference: 'fixture:comparison', summary: 'No observed improvement.' }],
          };
    assert.equal(
      (
        await completeHarness2Request({
          ...options,
          session: next.session,
          request_id: pending.request_id,
          response,
        })
      ).status,
      'submitted',
    );
  }
  assert.equal((await nextHarness2Step(options)).status, 'rejected');
  return { ...f, options, snapshot, source_fingerprint };
}

test('a rejected improvement returns only the separately reviewed, recorded baseline', async () => {
  const f = await rejectedFixture();
  const result = await rejectedHarness2Baseline({ ...f.options, session: f.session });
  assert.equal(result.status, 'baseline-ready-for-submission');
  if (result.status !== 'baseline-ready-for-submission') return;
  assert.equal(result.requires_supervisor_task_review, true);
  assert.deepEqual(result.outputs, [
    { id: 'result', reference: 'fixture:baseline', summary: 'Baseline artifact.' },
  ]);
  assert.deepEqual(result.evidence, [
    { reference: 'fixture:baseline-check', summary: 'Baseline check.' },
  ]);
  assert.equal(result.host_reported_cost_usd, null);
  assert.equal(result.declared_model_binding.model_id, 'fixture-model');
  assert.equal(result.source_fingerprint, f.source_fingerprint);
  assert.match(result.boundary, /conversation history/);
});

test('integrated fallback submits a receipted rejected baseline without accepting the task', async () => {
  const f = await rejectedFixture();
  const brief: BriefInput = {
    run_id: 'fixture-driver',
    objective: 'Produce a bounded artifact.',
    domain: 'software-engineering',
    lead_context: 'supervisor',
    evidence_kind: 'simulation',
    constraints: [],
    acceptance: ['Artifact is checked.'],
    improvement: { enabled: true, scope: 'fixture' },
    work_items: [
      {
        id: 'artifact',
        objective: 'Produce the artifact.',
        task_type: 'implementation',
        difficulty: 'routine',
        skills: ['implementation'],
        depends_on: [],
        inputs: ['task_brief'],
        writes: ['artifact'],
        outputs: ['result'],
        acceptance: ['Artifact is checked.'],
      },
    ],
  };
  let run = createRun(null, brief);
  run = applyEvent(run, {
    id: 'assignment',
    expected_revision: 0,
    packet_id: 'handover',
    attempt: 1,
    actor_context: 'supervisor',
    type: 'assign',
    assignment: {
      owner_context: 'worker',
      reviewer_context: 'supervisor',
      contributor_contexts: [],
      writes: ['artifact'],
      model_id: 'fixture-model',
      route: 'fixture-route',
    },
  });
  run = applyEvent(run, {
    id: 'start',
    expected_revision: 1,
    packet_id: 'handover',
    attempt: 1,
    actor_context: 'worker',
    type: 'start',
  });
  const filename = path.join(f.root, 'fallback-run.json');
  await writeFile(filename, JSON.stringify(run));
  const result = (await commands.integrated_optimizer_fallback.run({
    run_file: filename,
    request: {
      job_file: f.jobFile,
      state_dir: f.state,
      session: f.session,
      expected_revision: 2,
      actor_context: 'supervisor',
    },
  })) as { status: string; revision: number };
  assert.equal(result.status, 'baseline-submitted-for-ordinary-review');
  assert.equal(result.revision, 3);
  const stored = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(stored.packets.handover.status, 'in_review');
  assert.equal(stored.packets.handover.result.outputs[0].reference, 'fixture:baseline');
});

test('rejected baseline recovery refuses changed response, missing claim or receipt, and changed snapshot', async () => {
  for (const fault of ['response', 'claim', 'receipt', 'snapshot']) {
    const f = await rejectedFixture();
    const name = `${f.inputs[0].request_id}.json`;
    if (fault === 'response') {
      const filename = path.join(f.responses, name);
      const response = (await read(filename)) as Record<string, unknown>;
      (response.outputs as Record<string, unknown>[])[0].summary = 'Changed baseline.';
      await writeFile(filename, JSON.stringify(response));
    }
    if (fault === 'claim')
      await rename(
        path.join(f.session, 'host-claims', name),
        path.join(f.session, 'host-claims', `${name}.held`),
      );
    if (fault === 'receipt')
      await rename(
        path.join(f.session, 'host-receipts', name),
        path.join(f.session, 'host-receipts', `${name}.held`),
      );
    if (fault === 'snapshot') await writeFile(path.join(f.snapshot, 'input.txt'), 'changed');
    const result = await rejectedHarness2Baseline({ ...f.options, session: f.session });
    assert.notEqual(result.status, 'baseline-ready-for-submission');
    assert.ok(result.status === 'blocked' || result.status === 'uncertain-execution');
  }
});

test('rejected baseline recovery refuses another job and non-rejected terminal state', async () => {
  const f = await rejectedFixture();
  const { job_id: _id, job_fingerprint: _fingerprint, ...content } = f.job;
  const another = { ...content, run_id: 'different-run' };
  const job_fingerprint = digest(another);
  const otherFile = path.join(f.root, 'other-job.json');
  await writeFile(
    otherFile,
    JSON.stringify({ ...another, job_fingerprint, job_id: `h2-${job_fingerprint.slice(0, 24)}` }),
  );
  assert.equal(
    (await rejectedHarness2Baseline({ ...f.options, job_file: otherFile, session: f.session }))
      .status,
    'blocked',
  );
  await writeFile(
    path.join(f.session, 'report.json'),
    JSON.stringify({ status: 'ready-for-submission' }),
  );
  assert.equal(
    (await rejectedHarness2Baseline({ ...f.options, session: f.session })).status,
    'blocked',
  );
});

test('real pinned core rejection exposes its receipted baseline without a new model call', {
  skip: !process.env.HAKENGAISYA_HARNESS2_SOURCE,
}, async () => {
  const f = await fixture();
  const options = {
    job_file: f.jobFile,
    state_dir: path.join(f.root, 'real-rejection-state'),
    upstream: process.env.HAKENGAISYA_HARNESS2_SOURCE,
  };
  await mkdir(options.state_dir);
  const snapshot = path.join(f.root, 'rejection-snapshot');
  await mkdir(snapshot);
  await writeFile(path.join(snapshot, 'input.txt'), 'frozen fixture');
  const source_fingerprint = await fingerprintHarness2Snapshot(snapshot);
  let session = '';
  let calls = 0;
  for (;;) {
    const next = await nextHarness2Step(options);
    if (next.status === 'rejected') break;
    assert.equal(
      next.status,
      'needs-host',
      next.status === 'blocked' || next.status === 'unavailable' ? next.reason : undefined,
    );
    if (next.status !== 'needs-host') return;
    session = next.session;
    for (const pending of next.requests) {
      let isolation: StepIsolation | undefined;
      if (pending.kind === 'execute') {
        const workspace = path.join(f.root, 'isolation', pending.request_id);
        await mkdir(workspace);
        await writeFile(path.join(workspace, 'input.txt'), 'frozen fixture');
        isolation = {
          root: path.join(f.root, 'isolation'),
          live_workspace: path.join(f.root, 'live'),
          snapshot,
          workspace,
          source_fingerprint,
        };
      }
      const claim = await claimHarness2Request({
        ...options,
        session,
        request_id: pending.request_id,
        isolation,
      });
      assert.equal(claim.status, 'claimed', claim.status === 'blocked' ? claim.reason : undefined);
      if (claim.status !== 'claimed') return;
      const request = claim.request;
      const common = {
        request_id: request.request_id,
        request_fingerprint: request.request_fingerprint,
        actor_context: request.actor_context,
        status: 'completed' as const,
        cost_usd: null,
      };
      const response =
        request.kind === 'execute'
          ? {
              ...common,
              model_id: 'fixture-model',
              outputs: [
                {
                  id: 'result',
                  reference:
                    request.label === 'base1' ? 'fixture:real-core-baseline' : 'fixture:candidate',
                  summary: 'Fixture artifact.',
                  text: 'Fixture content.',
                },
              ],
              evidence: [{ reference: 'fixture:check', summary: 'Fixture.' }],
              trajectory: 'Fixture trajectory.',
            }
          : request.kind === 'adoption-review'
            ? {
                ...common,
                decision: 'rejected',
                reason: 'No demonstrated improvement.',
                evidence: [{ reference: 'fixture:review', summary: 'Independent fixture review.' }],
              }
            : {
                ...common,
                text: '<notes>Fixture edit.</notes>',
                harness: {
                  ...f.job.base_harness,
                  'systemprompt.md': 'Complete the fixed fixture task and report evidence.\n',
                },
              };
      assert.equal(
        (
          await completeHarness2Request({
            ...options,
            session,
            request_id: pending.request_id,
            response,
          })
        ).status,
        'submitted',
      );
      calls++;
    }
  }
  const result = await rejectedHarness2Baseline({ ...options, session });
  assert.equal(
    result.status,
    'baseline-ready-for-submission',
    result.status === 'blocked' || result.status === 'uncertain-execution'
      ? result.reason
      : undefined,
  );
  if (result.status !== 'baseline-ready-for-submission') return;
  assert.equal(result.outputs[0].reference, 'fixture:real-core-baseline');
  assert.equal(result.host_reported_cost_usd, null);
  assert.equal(result.requires_supervisor_task_review, true);
  assert.equal(calls, 8);
});
