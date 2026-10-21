import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planWork } from '../lib/planning.mjs';
import { finishTriage, prepareTriage, TRIAGE_QUESTIONS, triageWithJev } from '../lib/triage.mjs';
import { createRun } from '../lib/workflow.mjs';

const intake = {
  objective: 'Deliver a small local timer.',
  acceptance: ['Start and pause work.'],
  constraints: ['Keep it local.'],
};
function response(task = intake, changes = {}) {
  const choices = {
    domain: 'software-engineering',
    task_type: 'implementation',
    difficulty: 'routine',
    scope: 'bounded',
    risk: 'low',
    primary_skill: 'implementation',
    ...changes,
  };
  return {
    input_fingerprint: prepareTriage(task).input_fingerprint,
    answers: Object.fromEntries(
      Object.entries(choices).map(([key, value]) => [key, { choice: value, confidence: 0.95 }]),
    ),
  };
}
const brief = () => ({
  ...intake,
  run_id: 'triage-fixture',
  lead_context: 'host',
  domain: 'software-engineering',
  work_items: [
    {
      id: 'timer',
      objective: 'Implement the timer.',
      task_type: 'implementation',
      difficulty: 'routine',
      skills: ['implementation'],
      depends_on: [],
      inputs: ['task_brief'],
      writes: ['app'],
      outputs: ['app'],
      acceptance: intake.acceptance,
    },
  ],
});
const enabled = { enabled: true, allow_external_summary: true, api_key: 'fixture-key' };

test('bounded intake routes to an execution responsibility without adding management', () => {
  const result = finishTriage(intake, response());
  assert.equal(result.decision, 'direct');
  assert.equal(result.next_role, 'responsible_supervisor');
  assert.equal(result.extra_management_contexts, 0);
  assert.equal(result.automatic_execution, false);
  assert.equal(result.requirements.difficulty, 'routine');
  assert.deepEqual(result.requirements.skills, ['implementation']);
  assert.equal(
    finishTriage(intake, response(intake, { difficulty: 'standard' })).decision,
    'direct',
  );
});

test('complexity, multiple deliverables and elevated risk need planning without fixed staffing', () => {
  for (const changes of [{ difficulty: 'complex' }, { scope: 'multiple' }, { risk: 'elevated' }]) {
    const result = finishTriage(intake, response(intake, changes));
    assert.equal(result.decision, 'plan');
    assert.equal(result.next_role, 'existing_host');
    assert.equal(result.extra_management_contexts, 0);
  }
});

test('uncertainty returns to the existing host once and other domains stay outside the workflow', () => {
  assert.equal(finishTriage(intake, response(intake, { scope: 'unknown' })).decision, 'escalate');
  const uncertain = response();
  uncertain.answers.difficulty.confidence = 0.74;
  assert.equal(finishTriage(intake, uncertain).decision, 'escalate');
  assert.equal(
    finishTriage(intake, response(intake, { domain: 'other' })).decision,
    'out-of-scope',
  );
  assert.equal(
    finishTriage(
      intake,
      response(intake, {
        domain: 'technical-product-design',
        primary_skill: 'technical-product-design',
      }),
    ).requirements.domain,
    'technical-product-design',
  );
});

test('short intake excludes unrelated local data and stale scope cannot reuse classification', () => {
  const withPrivateFields = {
    ...intake,
    source_code: 'LOCAL_PRIVATE_FIXTURE',
    existing_assets: ['private/path'],
    workers: [{ secret: 'NOT_SENT' }],
  };
  assert.deepEqual(prepareTriage(withPrivateFields).state, intake);
  assert.throws(
    () =>
      finishTriage({ ...intake, constraints: ['Production deployment is required.'] }, response()),
    /Stale/,
  );
  assert.throws(
    () => finishTriage({ ...intake, acceptance: ['Different behavior.'] }, response()),
    /Stale/,
  );
  assert.throws(() => prepareTriage({ objective: 'x'.repeat(6001) }), /short intake/);
});

test('invalid choices and confidence cannot dispatch', () => {
  for (const confidence of [-1, 1.01, null, '0.99', NaN]) {
    const invalid = response();
    invalid.answers.scope.confidence = confidence;
    assert.throws(() => finishTriage(intake, invalid), /Invalid triage answer/);
  }
  assert.throws(
    () => finishTriage(intake, response(intake, { difficulty: 'cheap' })),
    /Invalid triage answer/,
  );
  const missing = response();
  delete missing.answers.risk;
  assert.throws(() => finishTriage(intake, missing), /Invalid triage answer/);
});

test('controller records canonical triage without adding a packet and blocks unresolved live work', () => {
  const b = brief();
  b.intake_triage = finishTriage(b, response(b));
  b.intake_triage.decision = 'forged-decision';
  const run = createRun(null, b);
  assert.equal(run.intake_triage.decision, 'direct');
  assert.deepEqual(Object.keys(run.packets), ['handover']);
  const unresolved = brief();
  unresolved.intake_triage = finishTriage(
    unresolved,
    response(unresolved, { difficulty: 'unknown' }),
  );
  assert.throws(() => createRun(null, unresolved), /Resolve intake/);
  assert.throws(() => planWork(unresolved, []), /Resolve intake/);
  const simulation = brief();
  simulation.intake_triage = finishTriage(simulation, {
    ...response(simulation),
    source: { kind: 'simulation', model_id: 'fixture' },
  });
  assert.throws(() => createRun(null, simulation), /Simulated triage/);
  const stale = { ...b, objective: 'A changed request.' };
  assert.throws(() => createRun(null, stale), /Stale/);
});

test('Jev sends one typed request with only the permitted summary fields', async () => {
  let calls = 0;
  const result = await triageWithJev(
    { ...intake, source_code: 'LOCAL_PRIVATE_FIXTURE' },
    enabled,
    async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer fixture-key');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.questions, TRIAGE_QUESTIONS);
      assert.deepEqual(body.state.task, intake);
      assert.ok(!options.body.includes('LOCAL_PRIVATE_FIXTURE'));
      return {
        ok: true,
        json: async () => ({ answers: response().answers, model: 'fixture-jev-model' }),
      };
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 'classified');
  assert.deepEqual(result.result.source, { kind: 'jev', model_id: 'fixture-jev-model' });
});

test('disabled or missing Jev access hands off a native request without making a call', async () => {
  const neverCall = () => assert.fail('Disabled route must not access a provider');
  assert.equal((await triageWithJev(intake, {}, neverCall)).reason, 'external-summary-not-enabled');
  assert.equal(
    (await triageWithJev(intake, { ...enabled, api_key: '' }, neverCall)).reason,
    'jev-key-unavailable',
  );
});

test('Jev errors, malformed answers and uncertainty fall back once without leaking response bodies', async () => {
  const cases = [
    async () => ({ ok: false, text: async () => 'PRIVATE_PROVIDER_BODY' }),
    async () => {
      throw new Error('PRIVATE_PROVIDER_BODY');
    },
    async () => ({ ok: true, json: async () => ({ answers: {} }) }),
    async () => ({
      ok: true,
      json: async () => ({ answers: response(intake, { scope: 'unknown' }).answers }),
    }),
  ];
  for (const fetcher of cases) {
    let calls = 0;
    const result = await triageWithJev(intake, enabled, (...args) => {
      calls++;
      return fetcher(...args);
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'native-fallback-required');
    assert.equal(result.request.role, 'intake_triage');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_BODY'));
  }
});

test('Jev timeout aborts one request and returns the native fallback', async () => {
  const result = await triageWithJev(
    intake,
    { ...enabled, timeout_ms: 15 },
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
  assert.equal(result.reason, 'jev-timeout');
});

test('packaged triage runs from an unrelated workspace without a provider or project path dependency', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-triage-'));
  const taskFile = path.join(directory, 'intake.json');
  const responseFile = path.join(directory, 'response.json');
  await writeFile(taskFile, JSON.stringify(intake));
  await writeFile(responseFile, JSON.stringify(response()));
  const helper = fileURLToPath(
    new URL('../plugins/hakengaisya/runtime/scripts/workflow.mjs', import.meta.url),
  );
  const call = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [helper, ...args], { cwd: directory, encoding: 'utf8' }),
    );
  assert.equal(call('triage-request', taskFile).role, 'intake_triage');
  assert.equal(call('triage', taskFile, responseFile).decision, 'direct');
});
