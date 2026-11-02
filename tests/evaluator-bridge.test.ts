import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { ExternalEvidence, HostInventory } from '../lib/evaluator-bridge.ts';
import { buildWorkerCatalog, fetchEvaluatorProfiles } from '../lib/evaluator-bridge.ts';
import { planWork } from '../lib/planning.ts';
import type { BriefInput } from '../lib/types.ts';

const inventory: HostInventory = {
  complete: true,
  routes: [
    {
      id: 'alpha-1',
      model_id: 'alpha',
      route: 'native',
      effort: 'medium',
      context_id: '/a',
      available: true,
      tools_verified: true,
      tools: ['filesystem'],
    },
    {
      id: 'alpha-2',
      model_id: 'alpha',
      route: 'native',
      effort: 'medium',
      context_id: '/b',
      available: true,
      tools_verified: true,
      tools: ['filesystem'],
    },
    { id: 'beta', model_id: 'beta', route: 'native', effort: 'low' },
  ],
};

function profile(model_id = 'alpha') {
  return {
    model_id,
    route: 'native',
    effort: 'medium',
    evaluation_kind: 'local_work',
    domain: 'software-engineering',
    task_type: 'implementation',
    difficulty: 'standard',
    skill: 'implementation',
    dimensions: {
      D1: {
        score: 8,
        support: 'supported-peer-observations',
        samples: 2,
        peers: 2,
        tasks: [{}, {}],
      },
      D2: {
        score: 8,
        support: 'supported-peer-observations',
        samples: 2,
        peers: 2,
        tasks: [{}, {}],
      },
      D3: { score: null, support: 'unmeasured', samples: 0, peers: 0, tasks: [] },
      D4: { score: null, support: 'unmeasured', samples: 0, peers: 0, tasks: [] },
      D5: { score: null, support: 'unmeasured', samples: 0, peers: 0, tasks: [] },
      D6: {
        score: 8,
        support: 'supported-peer-observations',
        samples: 2,
        peers: 2,
        tasks: [{}, {}],
      },
    },
    observed_cost_usd: 0.1,
    observed_wall_seconds: 25,
  };
}

const outside: ExternalEvidence = {
  model_id: 'beta',
  route: 'native',
  effort: 'low',
  task: {
    domain: 'software-engineering',
    task_type: 'implementation',
    difficulty: 'standard',
    skill: 'implementation',
  },
  source: {
    url: 'https://example.com/model-report',
    title: 'Public report',
    accessed_at: '2026-10-27T00:00:00Z',
  },
  assessment: { kind: 'qualitative', summary: 'Reported to be suitable for routine coding.' },
  estimates: {
    kind: 'unobserved_estimate',
    cost_usd: 0.02,
    wall_seconds: 10,
    basis: 'Declared estimate only.',
  },
};

const brief: BriefInput = {
  run_id: 'bridge-test',
  objective: 'Implement a bounded task.',
  domain: 'software-engineering',
  lead_context: '/root',
  evidence_kind: 'local_work',
  acceptance: ['Output is correct.'],
  constraints: [],
  work_items: [
    {
      id: 'work',
      objective: 'Implement the task.',
      task_type: 'implementation',
      difficulty: 'standard',
      skills: ['implementation'],
      depends_on: [],
      writes: ['output'],
      outputs: ['result'],
      acceptance: ['Correct result.'],
    },
  ],
  planning_limits: { max_parallel: 1, max_workers: 1 },
};

test('exposes historical evaluator records as advisory without upgrading them to live profiles', () => {
  const history = { ...profile(), evaluation_kind: 'historical_summary' };
  const catalog = buildWorkerCatalog(
    inventory,
    { status: 'available', profiles: [], total: 0 },
    [],
    { status: 'available', profiles: [history], total: 1 },
  );
  assert.equal(catalog.historical.status, 'available');
  assert.equal(catalog.historical.accepted, 1);
  assert.equal(catalog.historical_evidence[0].use, 'advisory_only');
  assert.deepEqual(catalog.historical_evidence[0].matching_worker_ids, ['alpha-1', 'alpha-2']);
  assert.equal(catalog.workers[0].profiles?.length, 0);
  assert.equal(planWork(brief, catalog.workers).status, 'needs-evidence');
});

test('joins actual routes only to exact local-work profiles and preserves missing host fields', () => {
  const valid = profile();
  const wrongKind = { ...profile('beta'), evaluation_kind: 'simulation' };
  const wrongRoute = { ...profile(), route: 'different' };
  const result = buildWorkerCatalog(inventory, {
    status: 'available',
    profiles: [valid, wrongKind, wrongRoute],
    total: 3,
  });
  assert.equal(result.inventory_status, 'complete');
  assert.equal(result.evaluator.data_quality, 'partial');
  assert.equal(result.evaluator.rejected, 1);
  assert.deepEqual(
    result.workers.map((worker) => worker.profiles?.length),
    [1, 1, 0],
  );
  assert.equal(result.workers[0].context_id, '/a');
  assert.equal(result.workers[1].context_id, '/b');
  assert.equal(result.workers[0].model_id, result.workers[1].model_id);
  assert.equal(result.workers[2].available, undefined);
  assert.deepEqual(result.inventory_unknown_fields, [
    { worker_id: 'beta', fields: ['available', 'tools_verified', 'tools'] },
  ]);
  assert.equal(result.workers[0].profiles?.[0].dimensions?.D3, undefined);
  assert.notEqual(result.workers[0].profiles?.[0], result.workers[1].profiles?.[0]);
});

test('does not invent missing cost, elapsed time, model effort or candidate availability', () => {
  const unknown = { ...profile(), observed_cost_usd: null, observed_wall_seconds: null };
  const missingEffort: HostInventory = {
    complete: false,
    routes: [{ id: 'a', model_id: 'alpha', route: 'native', available: true }],
  };
  const result = buildWorkerCatalog(missingEffort, {
    status: 'available',
    profiles: [unknown],
    total: 1,
  });
  assert.equal(result.inventory_status, 'incomplete');
  assert.deepEqual(result.workers[0].profiles, []);
  assert.ok(result.inventory_unknown_fields[0].fields.includes('effort'));
  const withEffort = buildWorkerCatalog(
    { complete: true, routes: [inventory.routes[0]] },
    { status: 'available', profiles: [unknown], total: 1 },
  );
  assert.equal(withEffort.workers[0].profiles?.[0].observed_cost_usd, undefined);
  assert.equal(withEffort.workers[0].profiles?.[0].observed_wall_seconds, undefined);
  assert.equal(planWork(brief, withEffort.workers).status, 'needs-evidence');
});

test('external-only evidence remains advisory and cannot silently qualify a local-work route', () => {
  const ready: HostInventory = {
    complete: true,
    routes: [{ ...inventory.routes[2], available: true, tools_verified: true, tools: [] }],
  };
  const result = buildWorkerCatalog(ready, { status: 'unavailable', reason: 'Offline' }, [outside]);
  assert.equal(result.evaluator.data_quality, 'unknown');
  assert.deepEqual(result.workers[0].profiles, []);
  assert.equal(result.external_evidence[0].use, 'advisory_only');
  assert.deepEqual(result.external_evidence[0].matching_worker_ids, ['beta']);
  assert.equal(planWork(brief, result.workers).status, 'needs-evidence');
  const invalid = { ...outside, source: { ...outside.source, url: 'file:///private' } };
  const invalidResult = buildWorkerCatalog(
    ready,
    { status: 'not_requested', reason: 'Not requested' },
    [invalid],
  );
  assert.equal(invalidResult.rejected_external_evidence, 1);
  assert.equal(invalidResult.incomplete_external_evidence[0].use, 'advisory_only');
  assert.equal(invalidResult.incomplete_external_evidence[0].evidence, invalid);
});

test('rejects malformed and ambiguous duplicate profiles and incomplete available snapshots', () => {
  const valid = profile();
  const malformed = {
    ...profile('beta'),
    dimensions: { D1: { score: 99, support: 'supported-peer-observations' } },
  };
  const result = buildWorkerCatalog(inventory, {
    status: 'available',
    profiles: [valid, { ...valid }, malformed],
    total: 3,
  });
  assert.equal(result.evaluator.rejected, 3);
  assert.equal(result.evaluator.accepted, 0);
  assert.deepEqual(result.workers[0].profiles, []);
  assert.throws(
    () => buildWorkerCatalog(inventory, { status: 'available', profiles: [valid], total: 2 }),
    /complete/,
  );
  assert.throws(
    () =>
      buildWorkerCatalog(
        { complete: true, routes: [inventory.routes[0], inventory.routes[0]] },
        { status: 'not_requested', reason: 'Not requested' },
      ),
    /unique/,
  );
});

test('fetches complete paginated local-work profiles with GET only and no credentials', async () => {
  const seen: Array<{ method?: string; path?: string; authorization?: string }> = [];
  const rows = Array.from({ length: 101 }, (_, index) => ({
    ...profile(),
    model_id: `model-${index}`,
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization,
    });
    assert.equal(url.searchParams.get('kind'), 'local_work');
    const offset = Number(url.searchParams.get('offset'));
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ total: rows.length, offset, profiles: rows.slice(offset, offset + 100) }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await fetchEvaluatorProfiles(`http://127.0.0.1:${port}`, { timeout_ms: 2000 });
    assert.equal(result.status, 'available');
    if (result.status === 'available') assert.equal(result.profiles.length, 101);
    assert.equal(seen.length, 2);
    assert.ok(
      seen.every(
        (item) => item.method === 'GET' && item.path === '/api/v1/profiles' && !item.authorization,
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('invalid pages, inaccessible endpoint and non-loopback origins are not mistaken for an empty evaluator', async () => {
  const server = createServer((_request, response) =>
    response.end(JSON.stringify({ total: 1, offset: 0, profiles: [] })),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal(
      (await fetchEvaluatorProfiles(`http://127.0.0.1:${port}`)).status,
      'invalid_response',
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  assert.equal(
    (await fetchEvaluatorProfiles(`http://127.0.0.1:${port}`, { timeout_ms: 200 })).status,
    'unavailable',
  );
  await assert.rejects(fetchEvaluatorProfiles('https://example.com'), /loopback/);
  await assert.rejects(fetchEvaluatorProfiles('http://user:pass@127.0.0.1:4317'), /clean origin/);
});
