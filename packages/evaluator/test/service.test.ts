import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { replayExample } from '../scripts/example.ts';
import type { SignedRequestOptions } from '../sdk/client.ts';
import {
  collectAndSubmit,
  prepareReport,
  signedRequest,
  signingText,
  submitReport,
} from '../sdk/client.ts';
import type { Report } from '../src/contract.ts';
import { canonical, sha256, validateReport } from '../src/contract.ts';
import { buildProfiles, recommend } from '../src/profiles.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';
import type {
  Profile,
  ProfilesResponse,
  RankingsResponse,
  Recommendation,
  RegistryEntry,
  ReportRow,
} from '../src/types.ts';

function report(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    report_id: randomUUID(),
    reviewer_model: 'reviewer-B',
    subject_model: 'worker-A',
    route: 'test-route',
    effort: 'standard',
    task_token: sha256('synthetic-task'),
    evaluation_kind: 'local_work',
    task: {
      domain: 'software-engineering',
      type: 'implementation',
      difficulty: 'routine',
      skills: ['routine-scripting'],
    },
    ratings: { D1: 8, D2: 8, D3: 8, D4: 8, D5: 8, D6: 8 },
    comment: 'Synthetic test opinion; not a real model evaluation.',
    example: 'Synthetic bounded implementation completed with review.',
    guidance: 'Consider this task type with normal review support.',
    relationship: 'direct',
    attribution: 'model',
    usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.002, wall_seconds: 8 },
    ...overrides,
  };
}
async function harness(t: TestContext) {
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const keys = generateKeyPairSync('ed25519');
  store.enroll({
    id: 'test-agent',
    collection_id: 'test-collection',
    model: 'reviewer-B',
    public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  return {
    store,
    base,
    credentials: { clientId: 'test-agent', privateKey: keys.privateKey },
    post: async (value: Report, credentialOverrides: Partial<SignedRequestOptions> = {}) =>
      fetch(
        `${base}/api/v1/evaluations`,
        signedRequest(value, {
          clientId: 'test-agent',
          privateKey: keys.privateKey,
          ...credentialOverrides,
        }),
      ),
  };
}

test('signed HTTP submission is persisted and read back as a tagged skill profile', async (t) => {
  const h = await harness(t);
  const value = report();
  const result = await h.post(value);
  assert.equal(result.status, 201);
  assert.equal(h.store.count(), 1);
  const response = await fetch(`${h.base}/api/v1/profiles`);
  const data = (await response.json()) as ProfilesResponse;
  assert.equal(data.total, 1);
  assert.equal(data.profiles[0].skill, 'routine-scripting');
  assert.equal(data.profiles[0].dimensions.D2.score, 8);
  assert.equal((await fetch(`${h.base}/`)).status, 200);
});
test('anonymous write and manual profile mutation are unavailable', async (t) => {
  const h = await harness(t);
  assert.equal(
    (await fetch(`${h.base}/api/v1/evaluations`, { method: 'POST', body: '{}' })).status,
    401,
  );
  assert.equal(
    (await fetch(`${h.base}/api/v1/profiles`, { method: 'PUT', body: '{}' })).status,
    405,
  );
  assert.equal(h.store.count(), 0);
});
test('tampered body and stale signatures are rejected', async (t) => {
  const h = await harness(t);
  const value = report();
  const request = signedRequest(value, h.credentials);
  request.body = request.body.replace('worker-A', 'worker-X');
  assert.equal((await fetch(`${h.base}/api/v1/evaluations`, request)).status, 401);
  assert.equal((await h.post(value, { timestamp: String(Date.now() - 600000) })).status, 401);
  assert.equal(h.store.count(), 0);
});
test('request nonce cannot be reused and report retries are idempotent', async (t) => {
  const h = await harness(t);
  const value = report();
  const request = signedRequest(value, h.credentials);
  assert.equal((await fetch(`${h.base}/api/v1/evaluations`, request)).status, 201);
  assert.equal((await fetch(`${h.base}/api/v1/evaluations`, request)).status, 409);
  assert.equal((await h.post(value)).status, 200);
  assert.equal(h.store.count(), 1);
  assert.equal((await h.post({ ...value, ratings: { D2: 4 } })).status, 409);
});
test('signed clients cannot impersonate another model', async (t) => {
  const h = await harness(t);
  assert.equal((await h.post(report({ reviewer_model: 'another-model' }))).status, 403);
  assert.equal(h.store.count(), 0);
});
test('self-evaluation and client-supplied weights are rejected', () => {
  assert.throws(() => validateReport(report({ subject_model: 'reviewer-B' })), /Self-evaluation/);
  assert.throws(() => validateReport({ ...report(), weight: 100 }), /Field not accepted/);
});
test('SDK removes local material and redacts known private content before transmission', () => {
  const local = {
    ...report(),
    local_task_identity: 'private-task-name',
    local_path: 'C:\\Private\\project',
    transcript: 'private discussion',
    source_code: 'private code',
    comment: 'Reviewed C:\\Private\\source.cs and person@example.org.',
    example: 'No local content needed.',
  };
  const prepared = prepareReport(local, 'synthetic-local-salt-at-least-32-characters');
  assert.ok(!canonical(prepared).includes('private-task-name'));
  assert.ok(!canonical(prepared).includes('Private'));
  assert.ok(!canonical(prepared).includes('example.org'));
  assert.ok(!Object.hasOwn(prepared, 'transcript'));
});
test('server-side privacy validation rejects paths, credentials, raw data fields, and email', async (t) => {
  const h = await harness(t);
  for (const comment of [
    'Local file C:\\Private\\code.cs',
    'Write to /home/private/data',
    'Contact person@example.org',
    'api_key=synthetic-credential-value',
  ])
    assert.throws(() => validateReport(report({ comment })), /private content/);
  const payload = { ...report(), local_path: 'private' };
  const request = signedRequest(report(), h.credentials);
  // Schema behavior is independently tested without manufacturing a forged valid signature.
  assert.throws(() => validateReport(payload), /Field not accepted/);
  assert.equal(h.store.count(), 0);
  assert.ok(request.headers['x-agent-signature']);
});
test('historical and simulated feedback are not mixed into live dispatch capability', () => {
  const rows: ReportRow[] = (['historical_summary', 'simulation'] as const).map((kind) => ({
    collection_id: 'test',
    report: report({ evaluation_kind: kind }),
  }));
  const projection = buildProfiles(rows);
  assert.equal(projection.profiles.length, 2);
  assert.equal(
    recommend(projection.profiles, { skill: 'routine-scripting', difficulty: 'routine' })
      .recommended,
    null,
  );
});
test('same reviewer cannot multiply its influence by changing the skill-list shape', () => {
  const first = report({ ratings: { D2: 3 } });
  const second: Report = {
    ...first,
    report_id: randomUUID(),
    ratings: { D2: 7 },
    task: { ...first.task, skills: ['routine-scripting', 'implementation'] },
  };
  const profile = buildProfiles([
    { collection_id: 'test', report: first },
    { collection_id: 'test', report: second },
  ]).profiles.find((item) => item.skill === 'routine-scripting');
  assert.ok(profile);
  assert.equal(profile.dimensions.D2.score, 7);
  assert.equal(profile.dimensions.D2.tasks[0].votes.length, 1);
});
test('stronger relevant credibility weights produce a transparent contextual estimate', () => {
  const rows: ReportRow[] = [
    report({ reviewer_model: 'strong-peer', ratings: { D3: 3 } }),
    report({ reviewer_model: 'ordinary-peer', ratings: { D3: 8 } }),
  ].map((value) => ({ collection_id: 'test', report: value }));
  const registry: RegistryEntry[] = [
    { model_id: 'strong-peer', scores: { D1: 9, D3: 9, D4: 9 } },
    { model_id: 'ordinary-peer', scores: { D1: 6, D3: 6, D4: 6 } },
  ];
  const estimate = buildProfiles(rows, registry).profiles[0].dimensions.D3;
  assert.ok((estimate.score as number) < 5.5);
  assert.equal(estimate.support, 'mixed-observations');
  assert.equal(estimate.tasks[0].votes.length, 2);
});
function dispatchProfiles(): Profile[] {
  const rows: ReportRow[] = [];
  for (const subject of ['economy-worker', 'frontier-worker'])
    for (const task of ['task-1', 'task-2'])
      for (const peer of ['peer-B', 'peer-C']) {
        rows.push({
          collection_id: 'test',
          report: report({
            reviewer_model: peer,
            subject_model: subject,
            task_token: sha256(task),
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cost_usd: subject === 'economy-worker' ? 0.002 : 0.08,
              wall_seconds: subject === 'economy-worker' ? 3 : 8,
            },
          }),
        });
      }
  return buildProfiles(rows).profiles;
}
test('lowest-cost adequate candidate wins over an unnecessary expensive model', () => {
  const result = recommend(dispatchProfiles(), {
    skill: 'routine-scripting',
    difficulty: 'routine',
    minimum_score: 7,
  });
  assert.ok(result.recommended);
  assert.equal(result.recommended.model_id, 'economy-worker');
  assert.equal(result.automatic_execution, false);
});

test('sub-millidollar costs and short durations retain precision for cost-first dispatch', () => {
  const rows: ReportRow[] = [];
  for (const subject of ['cheaper-worker', 'faster-worker'])
    for (const task of ['task-1', 'task-2'])
      for (const peer of ['peer-B', 'peer-C']) {
        rows.push({
          collection_id: 'precision-test',
          report: report({
            reviewer_model: peer,
            subject_model: subject,
            task_token: sha256(task),
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cost_usd: subject === 'cheaper-worker' ? 0.0001 : 0.0004,
              wall_seconds: subject === 'cheaper-worker' ? 0.0004 : 0.0001,
            },
          }),
        });
      }
  const profiles = buildProfiles(rows).profiles;
  const cheaper = profiles.find((profile) => profile.model_id === 'cheaper-worker');
  const faster = profiles.find((profile) => profile.model_id === 'faster-worker');
  assert.ok(cheaper);
  assert.ok(faster);
  assert.equal(cheaper.observed_cost_usd, 0.0001);
  assert.equal(faster.observed_wall_seconds, 0.0001);
  const result = recommend(profiles, { skill: 'routine-scripting', difficulty: 'routine' });
  assert.ok(result.recommended);
  assert.equal(result.recommended.model_id, 'cheaper-worker');
  assert.equal(
    recommend(profiles, {
      skill: 'routine-scripting',
      difficulty: 'routine',
      max_cost_usd: 0.00005,
    }).recommended,
    null,
  );
});

test('OAuth and app credential patterns are removed before reports can be uploaded', () => {
  for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
    const token = `${prefix}_syntheticPrivateValue1234567890`;
    assert.throws(
      () => validateReport(report({ comment: `Credential ${token}` })),
      /private content/,
    );
    const sanitized = prepareReport(
      { ...report(), local_task_identity: 'synthetic-task', comment: `Credential ${token}` },
      'synthetic-local-salt-at-least-32-characters',
    );
    assert.ok(!sanitized.comment.includes(token));
  }
});
test('a cheap model that cannot meet required ability is not chosen', () => {
  const profiles = dispatchProfiles();
  profiles[0].dimensions.D2.score = 4;
  const result = recommend(profiles, {
    skill: 'routine-scripting',
    difficulty: 'routine',
    minimum_score: 7,
  });
  assert.ok(result.recommended);
  assert.equal(result.recommended.model_id, 'frontier-worker');
});
test('unknown cost does not count as free, and difficult tasks do not borrow easy-task scores', () => {
  const profiles = dispatchProfiles();
  for (const profile of profiles) profile.observed_cost_usd = null;
  const result = recommend(profiles, { skill: 'routine-scripting', difficulty: 'routine' });
  assert.equal(result.recommended, null);
  assert.equal(result.unknown_cost_or_speed.length, 2);
  assert.equal(
    recommend(dispatchProfiles(), { skill: 'routine-scripting', difficulty: 'complex' })
      .recommended,
    null,
  );
});
test('budget and speed constraints are enforced before recommendation', () => {
  assert.equal(
    recommend(dispatchProfiles(), {
      skill: 'routine-scripting',
      difficulty: 'routine',
      max_cost_usd: 0.001,
    }).recommended,
    null,
  );
  assert.equal(
    recommend(dispatchProfiles(), {
      skill: 'routine-scripting',
      difficulty: 'routine',
      max_wall_seconds: 2,
    }).recommended,
    null,
  );
});
test('missing dimensions stay unmeasured and environment issues stay out of skill scores', () => {
  const rows: ReportRow[] = [
    report({ ratings: { D2: null }, attribution: 'model' }),
    report({ ratings: { D2: 0 }, attribution: 'environment' }),
  ].map((value) => ({ collection_id: 'test', report: value }));
  const result = buildProfiles(rows);
  assert.equal(result.profiles[0].dimensions.D2.score, null);
  assert.equal(result.operational.length, 1);
});
test('SQLite data survives a service restart', async () => {
  const dir = path.resolve('.local');
  await mkdir(dir, { recursive: true });
  const filename = path.join(dir, `test-${randomUUID()}.sqlite`);
  const keys = generateKeyPairSync('ed25519');
  let store = new Store(filename);
  store.enroll({
    id: 'durable-agent',
    collection_id: 'durable',
    model: 'reviewer-B',
    public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  });
  const durable = store.client('durable-agent');
  assert.ok(durable);
  store.append(durable, randomUUID(), report(), Date.now());
  store.close();
  store = new Store(filename);
  try {
    assert.equal(store.count(), 1);
    assert.equal(store.projection().profiles.length, 1);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm'])
      await unlink(filename + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
});
test('readback UI is read-only and protected by a same-origin script policy', async (t) => {
  const h = await harness(t);
  const response = await fetch(`${h.base}/`);
  assert.match(response.headers.get('content-security-policy') as string, /script-src 'self'/);
  const html = await response.text();
  assert.match(html, /read-only/);
  assert.ok(!html.includes('contenteditable'));
  assert.equal(
    (await fetch(`${h.base}/api/v1/recommendations?skill=invalid&difficulty=routine`)).status,
    400,
  );
});
test('sanitized local history replays through real HTTP without private credentials on disk', async (t) => {
  const h = await harness(t);
  const result = await replayExample(h.store, h.base);
  assert.equal(result.accepted_reports, 8);
  assert.equal(result.skill_profiles, 12);
  assert.equal(result.credentials_persisted, false);
  const fixture = await readFile(
    new URL('../fixtures/local-history.json', import.meta.url),
    'utf8',
  );
  assert.ok(!fixture.includes('source_path'));
  assert.ok(!fixture.includes('source_sha256'));
});
test('peer collection isolates a failed model callback and prevents impersonation', async () => {
  const value = report();
  const result = await collectAndSubmit({
    peers: [{ model_id: 'reviewer-B' }, { model_id: 'bad-peer' }],
    subject: { model_id: 'worker-A' },
    task: value.task,
    askPeer: async ({ peer }) => {
      if (peer.model_id === 'bad-peer') throw new Error('Synthetic unavailable route');
      return value;
    },
    upload: async () => ({ accepted: true }),
  });
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].status, 'rejected');
});
test('remote plaintext upload is refused by the SDK', async () => {
  await assert.rejects(submitReport('http://untrusted.example', report(), {} as never), /HTTPS/);
});

test('signed evaluation uploads refuse redirects without forwarding the report', async (t) => {
  let destinationRequests = 0;
  const destination = createServer((request, response) => {
    destinationRequests++;
    request.resume();
    response.end('{}');
  });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const redirect = createServer((request, response) => {
    request.resume();
    response.writeHead(307, {
      location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/forwarded`,
    });
    response.end();
  });
  redirect.listen(0, '127.0.0.1');
  await once(redirect, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
    await new Promise<void>((resolve) => destination.close(() => resolve()));
  });
  const keys = generateKeyPairSync('ed25519');
  await assert.rejects(
    submitReport(`http://127.0.0.1:${(redirect.address() as AddressInfo).port}`, report(), {
      clientId: 'fixture-client',
      privateKey: keys.privateKey,
    }),
  );
  assert.equal(destinationRequests, 0);
  await assert.rejects(
    submitReport('http://user:password@127.0.0.1', report(), {} as never),
    /clean service/,
  );
});

test('ranking is an optional human display and contains no manual matching interface', async (t) => {
  const h = await harness(t);
  await replayExample(h.store, h.base);
  const data = (await (
    await fetch(`${h.base}/api/v1/rankings?kind=historical_summary`)
  ).json()) as RankingsResponse;
  assert.equal(data.rows.length, 8);
  assert.equal(data.rows[0].display_score, 8.833);
  assert.ok(data.rows.find((row) => row.model_id === 'claude-fable-5-1')?.display_score === null);
  const html = await (await fetch(`${h.base}/`)).text();
  assert.match(html, /Staff Ranking/);
  assert.ok(!html.includes('Match the work'));
  assert.ok(!html.includes('Find an adequate model'));
});

test('machine recommendation API enforces capability, task context, budget and lowest adequate cost', async (t) => {
  const h = await harness(t);
  for (const peer of ['peer-B', 'peer-C']) {
    const keys = generateKeyPairSync('ed25519');
    h.store.enroll({
      id: peer,
      collection_id: 'dispatch-test',
      model: peer,
      public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    });
    for (const subject of ['economy-worker', 'frontier-worker'])
      for (const task of ['task-1', 'task-2']) {
        const value = report({
          reviewer_model: peer,
          subject_model: subject,
          task_token: sha256(task),
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: subject === 'economy-worker' ? 0.002 : 0.08,
            wall_seconds: 8,
          },
        });
        await submitReport(h.base, value, { clientId: peer, privateKey: keys.privateKey });
      }
  }
  const query =
    '/api/v1/recommendations?skill=routine-scripting&difficulty=routine&task_type=implementation&domain=software-engineering';
  const data = (await (await fetch(h.base + query)).json()) as Recommendation;
  assert.ok(data.recommended);
  assert.equal(data.recommended.model_id, 'economy-worker');
  const excluded = (await (
    await fetch(`${h.base + query}&max_cost_usd=0.001`)
  ).json()) as Recommendation;
  assert.equal(excluded.recommended, null);
  assert.equal(
    (await fetch(`${h.base}/api/v1/recommendations?skill=routine-scripting&difficulty=routine`))
      .status,
    400,
  );
});

test('privacy and size limits reject even correctly signed payloads without persistence', async (t) => {
  const h = await harness(t);
  async function sendRaw(value: unknown): Promise<Response> {
    const raw = canonical(value);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    return fetch(`${h.base}/api/v1/evaluations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-client': h.credentials.clientId,
        'x-agent-timestamp': timestamp,
        'x-agent-nonce': nonce,
        'x-agent-signature': sign(
          null,
          Buffer.from(signingText(timestamp, nonce, raw)),
          h.credentials.privateKey,
        ).toString('base64'),
      },
      body: raw,
    });
  }
  assert.equal((await sendRaw({ ...report(), local_path: 'private' })).status, 400);
  assert.equal((await sendRaw(report({ comment: 'Contact person@example.org' }))).status, 400);
  assert.equal((await sendRaw(report({ comment: 'x'.repeat(20000) }))).status, 413);
  assert.equal(h.store.count(), 0);
});

test('revoked agent cannot submit further evaluations', async (t) => {
  const h = await harness(t);
  h.store.disable(h.credentials.clientId);
  assert.equal((await h.post(report())).status, 401);
  assert.equal(h.store.count(), 0);
});
