import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  aggregateFeedback,
  buildSurvey,
  collectSurvey,
  DIMENSIONS,
  digest,
  importLegacyChart,
  readDataConstant,
  reviewerWeight,
  stableJSON,
  surveyDue,
  validateFeedback,
} from '../lib/staff.mjs';

const policy = JSON.parse(await readFile(new URL('../staff/policy.json', import.meta.url), 'utf8'));
const context = {
  project_id: 'test-project',
  run_id: 'run-1',
  task_id: 'task-1',
  input_fingerprint: digest('test inputs'),
  template_id: 'software-delivery',
  role_id: 'delivery_team',
  task_class: 'implementation',
  difficulty: 'complex',
};
const scores = (value) => Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, value]));
const emptyRegistry = () => ({
  schema_version: 1,
  epoch: 'test-epoch',
  historical_seeds: [],
  local_capabilities: [],
});
function registry() {
  return {
    ...emptyRegistry(),
    local_capabilities: [9, 6].map((value, index) => ({
      model_id: index ? 'peer-C' : 'peer-B',
      context: { ...context },
      scores: scores(value),
      status: 'supported',
      supporting_tasks: 4,
    })),
  };
}
function feedback(id, peer, rating, overrides = {}) {
  return {
    schema_version: 1,
    feedback_id: id,
    created_at: '2026-10-10T10:00:00Z',
    reviewer: { model_id: peer, employee_id: `${peer}-employee`, role_id: 'assurance_team' },
    subject: {
      model_id: 'model-A',
      employee_id: 'employee-A',
      route_id: 'test-route',
      effort: 'high',
    },
    context: { ...context },
    relationship: 'direct_collaboration',
    attribution: 'model',
    summary: 'Synthetic test feedback; not a real model evaluation.',
    ratings: { D3: rating },
    evidence: [],
    ...overrides,
  };
}

test('a stronger relevant local peer gets more weight, and dissent remains visible', () => {
  const result = aggregateFeedback(
    [feedback('bad', 'peer-B', 3), feedback('good', 'peer-C', 8)],
    registry(),
    policy,
  );
  const dimension = result.profiles[0].dimensions.D3;
  assert.equal(dimension.score, 4.538);
  assert.equal(dimension.confidence, 'disputed');
  assert.equal(dimension.tasks[0].votes.length, 2);
  assert.ok(dimension.tasks[0].votes[0].weight > dimension.tasks[0].votes[1].weight);
});

test('routine success and complex difficulty produce separate ability contexts', () => {
  const easy = feedback('easy', 'peer-B', 9, { context: { ...context, difficulty: 'routine' } });
  const hard = feedback('hard', 'peer-B', 3);
  const result = aggregateFeedback([easy, hard], registry(), policy);
  assert.equal(result.profiles.length, 2);
  assert.deepEqual(
    result.profiles.map((profile) => [profile.context.difficulty, profile.dimensions.D3.score]),
    [
      ['routine', 9],
      ['complex', 3],
    ],
  );
});

test('a later comment by the same model replaces its earlier comment on the same task', () => {
  const later = feedback('later', 'peer-B', 4, { created_at: '2026-10-10T10:05:00Z' });
  const result = aggregateFeedback(
    [feedback('earlier', 'peer-B', 2), later, later],
    registry(),
    policy,
  );
  assert.equal(result.received_records, 2);
  assert.equal(result.retained_model_feedback, 1);
  assert.equal(result.profiles[0].dimensions.D3.score, 4);
  assert.equal(result.profiles[0].dimensions.D3.distinct_task_inputs, 1);
});

test('a model cannot gain another vote by using a different employee instance', () => {
  const later = feedback('other-instance', 'peer-B', 4, {
    created_at: '2026-10-10T10:05:00Z',
    reviewer: { model_id: 'peer-B', employee_id: 'second-employee', role_id: 'assurance_team' },
  });
  assert.equal(
    aggregateFeedback([feedback('first-instance', 'peer-B', 2), later], registry(), policy)
      .retained_model_feedback,
    1,
  );
});

test('changed task inputs contribute another sample, while repeated inputs do not', () => {
  const changed = feedback('changed', 'peer-B', 8, {
    context: { ...context, input_fingerprint: digest('changed inputs') },
  });
  const dimension = aggregateFeedback(
    [feedback('original', 'peer-B', 4), changed],
    registry(),
    policy,
  ).profiles[0].dimensions.D3;
  assert.equal(dimension.distinct_task_inputs, 2);
  assert.equal(dimension.score, 6);
  assert.equal(dimension.confidence, 'provisional');
});

test('missing dimensions remain null and do not create full role-fit coverage', () => {
  const profile = aggregateFeedback([feedback('partial', 'peer-B', 8)], registry(), policy)
    .profiles[0];
  assert.equal(profile.dimensions.D2.score, null);
  assert.equal(profile.dimensions.D2.confidence, 'unmeasured');
  assert.ok(profile.role_fit.coverage < 1);
  assert.equal(profile.role_fit.eligible_for_dispatch_advice, false);
});

test('route and environment complaints do not lower model capability', () => {
  const route = feedback('route-failed', 'peer-B', 0, { attribution: 'route' });
  const environment = feedback('environment-blocked', 'peer-C', 0, { attribution: 'environment' });
  const result = aggregateFeedback([route, environment], registry(), policy);
  assert.equal(result.profiles.length, 0);
  assert.equal(result.operational_feedback.length, 2);
});

test('projects remain separate even when model and task identifiers match', () => {
  const other = feedback('other-project', 'peer-B', 2, {
    context: { ...context, project_id: 'another-project' },
  });
  assert.equal(
    aggregateFeedback([feedback('this-project', 'peer-B', 9), other], registry(), policy).profiles
      .length,
    2,
  );
});

test('weights use an immutable epoch and do not bootstrap from current peer opinions', () => {
  const anchor = registry();
  const before = stableJSON(anchor);
  aggregateFeedback([feedback('epoch-check', 'peer-B', 0)], anchor, policy);
  assert.equal(stableJSON(anchor), before);
  assert.equal(
    reviewerWeight(feedback('weight', 'peer-B', 0), 'D3', anchor, policy).registry_epoch,
    'test-epoch',
  );
});

test('unknown peers receive a neutral startup weight; self-rating and injected weights fail', () => {
  assert.equal(
    reviewerWeight(feedback('unknown', 'new-peer', 5), 'D3', emptyRegistry(), policy).weight,
    0.25,
  );
  assert.throws(() => validateFeedback(feedback('self', 'model-A', 10)), /Self-rating/);
  assert.throws(
    () => validateFeedback(feedback('injected', 'peer-B', 5, { weight: 100 })),
    /unexpected field/,
  );
});

test('supported peer feedback needs distinct tasks and peer models', () => {
  const rows = ['peer-B', 'peer-C'].flatMap((peer) =>
    ['task-1', 'task-2'].map((task) =>
      feedback(`${peer}-${task}`, peer, 7, { context: { ...context, task_id: task } }),
    ),
  );
  const dimension = aggregateFeedback(rows, registry(), policy).profiles[0].dimensions.D3;
  assert.equal(dimension.confidence, 'supported-peer-feedback');
  assert.equal(dimension.distinct_peer_models, 2);
  assert.equal(dimension.distinct_task_inputs, 2);
});

test('conflicting IDs and equal-time contradictory opinions are rejected', () => {
  assert.throws(
    () =>
      aggregateFeedback(
        [feedback('same', 'peer-B', 3), feedback('same', 'peer-B', 8)],
        registry(),
        policy,
      ),
    /identifier/,
  );
  assert.throws(
    () =>
      aggregateFeedback(
        [feedback('one', 'peer-B', 3), feedback('two', 'peer-B', 8)],
        registry(),
        policy,
      ),
    /identical timestamps/,
  );
});

test('historical imports preserve route variants without treating counts as new evidence', () => {
  const html =
    'const DIMS = [{k:"D1",name:"Evidence"}]; const SUBJECTS = [{id:"claude-sonnet-5-5",name:"Synthetic original",route:"one",tier:"test",local:{D1:8,D2:null},obs:20,evidence:["Synthetic"],public:"ignored"},{id:"mzk1-sonnet-5-5-high",name:"Synthetic second route",route:"two",tier:"test",local:{D1:6,D2:null},obs:10,evidence:["Synthetic"],public:"ignored"}]; const OBS = [["synthetic log"]];';
  const imported = importLegacyChart(html, 'test-chart.html');
  assert.equal(imported.history.profiles.length, 2);
  assert.equal(imported.registry.historical_seeds.length, 1);
  assert.equal(imported.registry.historical_seeds[0].scores.D1, 7);
  assert.equal(imported.history.public_benchmarks_imported, false);
  assert.equal(imported.history.raw_observations_imported, 0);
  assert.equal(aggregateFeedback([], imported.registry, policy).profiles.length, 0);
});

test('the data importer handles quoted punctuation and refuses executable source expressions', () => {
  assert.deepEqual(readDataConstant('const X = [{key:"literal ] } : ", note:"value",},];', 'X'), [
    { key: 'literal ] } : ', note: 'value' },
  ]);
  assert.throws(
    () => readDataConstant('const X = [process.exit()];', 'X'),
    /Executable expression/,
  );
});

test('survey plans exclude self-model targets and preserve structured-response contracts', async () => {
  const participants = [
    {
      model_id: 'model-A',
      employee_id: 'employee-A',
      role_id: 'delivery_team',
      route_id: 'test-route',
      effort: 'high',
    },
    {
      model_id: 'peer-B',
      employee_id: 'peer-B-employee',
      role_id: 'assurance_team',
      route_id: 'route-B',
      effort: 'high',
    },
  ];
  const plan = buildSurvey(context, participants);
  assert.equal(plan.requests.length, 2);
  assert.ok(
    plan.requests.every((request) =>
      request.targets.every((target) => target.model_id !== request.reviewer.model_id),
    ),
  );
  assert.equal(plan.requests[1].response_record_template.ratings.D3, null);
  const result = await collectSurvey(plan, async (request) => {
    if (request.reviewer.model_id === 'model-A') throw new Error('Synthetic route unavailable');
    return [feedback('survey-response', 'peer-B', 8, { request_id: request.request_id })];
  });
  assert.equal(result.feedback.length, 1);
  assert.equal(result.failures.length, 1);
});

test('survey replies cannot impersonate another recipient or change task difficulty', async () => {
  const plan = buildSurvey(context, [
    {
      model_id: 'model-A',
      employee_id: 'employee-A',
      role_id: 'delivery_team',
      route_id: 'test-route',
      effort: 'high',
    },
    {
      model_id: 'peer-B',
      employee_id: 'peer-B-employee',
      role_id: 'assurance_team',
      route_id: 'route-B',
      effort: 'high',
    },
  ]);
  const result = await collectSurvey(plan, async (request) => [
    feedback('spoof', 'peer-B', 8, {
      request_id: request.request_id,
      context: { ...context, difficulty: 'routine' },
    }),
  ]);
  assert.equal(result.feedback.length, 0);
  assert.equal(result.failures.length, 2);
});

test('periodic surveys require both elapsed time and new completed tasks', () => {
  const state = { last_poll_at: '2026-10-10T10:00:00Z', completed_task_count: 2 };
  assert.equal(surveyDue(state, 5, '2026-10-10T10:31:00Z', policy), true);
  assert.equal(surveyDue(state, 4, '2026-10-10T10:31:00Z', policy), false);
  assert.equal(surveyDue(state, 5, '2026-10-10T10:10:00Z', policy), false);
});

test('inactive education scope, invalid scores, and non-English artifact text are rejected', () => {
  assert.throws(
    () =>
      validateFeedback(
        feedback('inactive', 'peer-B', 5, {
          context: { ...context, template_id: 'education-production' },
        }),
      ),
    /Only technical/,
  );
  assert.throws(() => validateFeedback(feedback('bad-score', 'peer-B', 11)), /0 to 10/);
  assert.throws(
    () => validateFeedback(feedback('cjk-handling', 'peer-B', 5, { summary: '\u6d4b\u8bd5' })),
    /English text/,
  );
});
