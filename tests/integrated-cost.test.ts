import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareIntegratedPlan } from '../lib/integrated.ts';
import { prepareReport } from '../packages/evaluator/sdk/client.ts';

const dimensions = () =>
  Object.fromEntries(
    ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((id) => [
      id,
      ['D1', 'D2', 'D6'].includes(id)
        ? {
            score: 8,
            support: 'supported-peer-observations',
            samples: 2,
            peers: 2,
            tasks: [{}, {}],
          }
        : { score: null, support: 'unmeasured', samples: 0, peers: 0, tasks: [] },
    ]),
  );
const profile = (model: string, cost: number | null) => ({
  model_id: model,
  route: 'native',
  effort: 'medium',
  evaluation_kind: 'local_work',
  domain: 'software-engineering',
  task_type: 'implementation',
  difficulty: 'standard',
  skill: 'implementation',
  dimensions: dimensions(),
  observed_cost_usd: cost,
  observed_wall_seconds: 20,
});

test('qualified ability can use fresh locally estimated API cost without inventing a bill or score', async (t) => {
  const profiles = [profile('alpha', 0.02), profile('gamma', null)];
  const server = createServer((request, response) => {
    const kind = new URL(request.url as string, 'http://localhost').searchParams.get('kind');
    const values = kind === 'historical_summary' ? [] : profiles;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ total: values.length, offset: 0, profiles: values }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'hak-integrated-cost-'));
  const file = path.join(dir, 'cost-record.json');
  t.after(async () => {
    await unlink(file);
    await rmdir(dir);
  });
  const report = prepareReport(
    {
      report_id: 'cost-record',
      reviewer_model: 'reviewer',
      subject_model: 'gamma',
      route: 'native',
      effort: 'medium',
      local_task_identity: 'fixture-work',
      evaluation_kind: 'local_work',
      task: {
        domain: 'software-engineering',
        type: 'implementation',
        difficulty: 'standard',
        skills: ['implementation'],
      },
      ratings: { D1: 8 },
      comment: 'Fixture observation.',
      example: 'Fixture.',
      guidance: 'Fixture.',
      relationship: 'review',
      attribution: 'model',
      usage: { input_tokens: 100, output_tokens: 10, cost_usd: null, wall_seconds: 20 },
    },
    'synthetic-salt-with-more-than-thirty-two-characters',
  );
  const record = {
    kind: 'evaluator-report',
    report,
    task_token_scope: 'a'.repeat(64),
    local_cost_estimate: {
      usd: 0.005,
      basis: 'api-equivalent-estimate',
      usage_evidence: 'fixture-counter',
      source: {
        url: 'https://example.com/pricing',
        checked_at: new Date().toISOString(),
        assumptions: 'Fixture rates.',
      },
    },
  };
  await writeFile(file, JSON.stringify(record));
  const input = {
    brief: {
      run_id: 'cost-integration',
      objective: 'Deliver a fixture.',
      domain: 'software-engineering',
      lead_context: '/host',
      evidence_kind: 'local_work',
      acceptance: ['Checked.'],
      constraints: [],
      work_items: [
        {
          id: 'work',
          objective: 'Implement.',
          task_type: 'implementation',
          difficulty: 'standard',
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
      routes: ['alpha', 'gamma'].map((model) => ({
        id: model,
        model_id: model,
        route: 'native',
        effort: 'medium',
        available: true,
        tools_verified: true,
        tools: [],
      })),
    },
    evaluator_endpoint: endpoint,
    public_trials: { enabled: false, max_assignments: 1, require_research_for_all: false },
  };
  const without = await prepareIntegratedPlan(input);
  assert.equal(without.plan?.assignments[0].model_id, 'alpha');
  const withEstimate = await prepareIntegratedPlan({
    ...input,
    cost_observations: { queue_dir: dir, allow_use: true },
  });
  assert.equal(withEstimate.cost_observations.status, 'available');
  assert.equal(withEstimate.plan?.assignments[0].model_id, 'gamma');
  assert.equal(withEstimate.plan?.assignments[0].qualification, 'qualified');
  assert.equal(withEstimate.plan?.assignments[0].cost_basis, 'api-equivalent-estimate');
  assert.equal(withEstimate.plan?.assignments[0].estimated_cost_usd, 0.005);
  profiles[1] = {
    ...profile('gamma', null),
    dimensions: Object.fromEntries(
      ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((id) => [
        id,
        ['D1', 'D2', 'D6'].includes(id)
          ? { score: 8, support: 'limited-observations', samples: 1, peers: 1, tasks: [{}] }
          : { score: null, support: 'unmeasured', samples: 0, peers: 0, tasks: [] },
      ]),
    ),
  };
  const limited = await prepareIntegratedPlan({
    ...input,
    inventory: { complete: true, routes: [input.inventory.routes[1]] },
    public_trials: { enabled: true, max_assignments: 1, require_research_for_all: true },
    external_evidence: [
      {
        model_id: 'gamma',
        route: 'native',
        effort: 'medium',
        task: {
          domain: 'software-engineering',
          task_type: 'implementation',
          difficulty: 'standard',
          skill: 'implementation',
        },
        source: {
          url: 'https://example.com/model',
          title: 'Fixture',
          accessed_at: new Date().toISOString(),
        },
        assessment: {
          kind: 'qualitative',
          summary: 'Fixture supports a trial.',
          trial_fit: 'supports',
        },
        estimates: {
          kind: 'unobserved_estimate',
          cost_usd: 0.2,
          wall_seconds: 60,
          basis: 'Fixture estimate.',
        },
      },
    ],
    cost_observations: { queue_dir: dir, allow_use: true },
  });
  assert.equal(limited.plan?.assignments[0].qualification, 'trial');
  assert.equal(limited.plan?.assignments[0].cost_basis, 'api-equivalent-estimate');
  assert.equal(limited.plan?.assignments[0].estimated_cost_usd, 0.005);
  assert.equal(limited.plan?.assignments[0].end_seconds, 20);
  record.local_cost_estimate.source.checked_at = '2000-01-01T00:00:00Z';
  await writeFile(file, JSON.stringify(record));
  const stale = await prepareIntegratedPlan({
    ...input,
    cost_observations: { queue_dir: dir, allow_use: true },
  });
  assert.equal(stale.plan?.assignments[0].model_id, 'alpha');
  await assert.rejects(
    () =>
      prepareIntegratedPlan({
        ...input,
        brief: {
          ...input.brief,
          planning_limits: { ...input.brief.planning_limits, allow_api_cost_estimates: false },
        },
        cost_observations: { queue_dir: dir, allow_use: true },
      }),
    /cannot override/,
  );
});
