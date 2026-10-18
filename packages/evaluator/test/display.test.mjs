import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';
import { replayExample } from '../scripts/example.mjs';
import { dimensionDefinitions, modelDetail, publicReference, publicReferences } from '../src/display.mjs';
import { radarGeometry } from '../web/radar.mjs';

async function harness(t) {
  const store = new Store(':memory:'); const server = createApp(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = 'http://127.0.0.1:' + server.address().port; await replayExample(store, base);
  return { base, store };
}

test('all six dimension definitions explain the actual local evaluation scope', () => {
  assert.deepEqual(dimensionDefinitions.map(item => item.id), ['D1','D2','D3','D4','D5','D6']);
  assert.ok(dimensionDefinitions.every(item => item.name && item.evaluates.length > 40));
  assert.match(dimensionDefinitions[5].evaluates, /handoffs/);
});
test('public reference covers every example model with source, date, and test conditions', () => {
  const snapshot = publicReferences(); assert.equal(snapshot.models.length, 7);
  for (const model of snapshot.models) {
    assert.equal(model.dispatch_eligible, false); assert.equal(model.checked_on, '2026-10-10');
    assert.ok(model.source_url.startsWith('https://')); assert.ok(model.benchmarks.every(item => item.name && item.value && item.conditions));
    assert.ok(!Object.hasOwn(model, 'dimensions')); assert.ok(!Object.hasOwn(model, 'ratings'));
  }
  assert.equal(publicReference('unlisted-model'), null);
});
test('unknown local model ability remains unmeasured even when public benchmarks are available', async t => {
  const { base } = await harness(t);
  const data = await (await fetch(base + '/api/v1/model-details?model=claude-fable-5-1&kind=historical_summary')).json();
  assert.ok(Object.values(data.radar).every(value => value === null));
  assert.ok(data.public_reference.benchmarks.length > 0); assert.equal(data.public_reference.dispatch_eligible, false);
});
test('model details preserve comments, guidance, and one selected route context', async t => {
  const { base } = await harness(t);
  const data = await (await fetch(base + '/api/v1/model-details?model=claude-sonnet-5-5&kind=historical_summary&route=alternate-route')).json();
  assert.equal(data.contexts.length, 1); assert.equal(data.comments.length, 1);
  assert.equal(data.radar.D2, null); assert.equal(data.radar.D5, 9);
  assert.ok(data.comments[0].example); assert.ok(data.comments[0].guidance);
  assert.equal(data.profiles.length, 2);
});
test('different model routes are not silently merged into one radar', async t => {
  const { store } = await harness(t); const detail = modelDetail(store.projection().profiles, 'claude-sonnet-5-5', { evaluation_kind: 'historical_summary' });
  assert.equal(detail.contexts.length, 2); assert.ok(Object.values(detail.radar).every(value => value === null));
});
test('comments with the same identifier but different content remain distinct', () => {
  const base = { model_id: 'test-model', evaluation_kind: 'local_work', route: 'test', effort: 'standard', domain: 'software-engineering', task_type: 'implementation', difficulty: 'routine', dimensions: Object.fromEntries(['D1','D2','D3','D4','D5','D6'].map(id => [id, { score: 7 }])), observed_cost_usd: null, observed_wall_seconds: null };
  const profiles = ['first', 'second'].map((comment, index) => ({ ...base, skill: index ? 'implementation' : 'routine-scripting', guidance: [{ report_id: 'shared-id', comment, example: 'Synthetic example', guidance: 'Synthetic guidance' }] }));
  assert.equal(modelDetail(profiles, 'test-model').comments.length, 2);
});
test('radar geometry omits unknowns and preserves measured zero as a real point', () => {
  const shape = radarGeometry({ D1: 0, D2: null, D3: 8, D4: 7, D5: 6, D6: 9 });
  assert.deepEqual(shape.points[0].position, shape.center); assert.equal(shape.points[1].position, null);
  assert.equal(shape.complete, false); assert.deepEqual(shape.missing, ['D2']);
});
test('complete radar has six axes, a 0-10 scale, and rejects invalid scores', () => {
  const shape = radarGeometry({ D1: 10, D2: 10, D3: 10, D4: 10, D5: 10, D6: 10 });
  assert.equal(shape.complete, true); assert.equal(shape.points.length, 6); assert.deepEqual(shape.rings.map(ring => ring.value), [2,4,6,8,10]);
  assert.equal(shape.points[0].position[1], 54);
  assert.throws(() => radarGeometry({ D1: 11 }), /Invalid radar/);
});
test('ranking includes public coarse notes without changing local scores or live eligibility', async t => {
  const { base } = await harness(t);
  const ranks = await (await fetch(base + '/api/v1/rankings?kind=historical_summary')).json();
  assert.equal(ranks.rows.length, 8); assert.equal(ranks.rows[0].display_score, 8.833);
  assert.ok(ranks.rows.every(row => row.public_reference?.checked_on));
  const live = await (await fetch(base + '/api/v1/profiles?kind=local_work')).json(); assert.equal(live.total, 0);
  const recommendation = await (await fetch(base + '/api/v1/recommendations?skill=implementation&task_type=implementation&domain=software-engineering&difficulty=standard')).json(); assert.equal(recommendation.recommended, null);
});
test('public and detail endpoints are read-only and served with explanatory radar assets', async t => {
  const { base } = await harness(t);
  const taxonomy = await (await fetch(base + '/api/v1/taxonomy')).json(); assert.equal(taxonomy.dimension_definitions.length, 6);
  const refs = await (await fetch(base + '/api/v1/public-references')).json(); assert.equal(refs.models.length, 7);
  assert.equal((await fetch(base + '/api/v1/model-details?model=invalid/name')).status, 400);
  assert.equal((await fetch(base + '/api/v1/public-references', { method: 'PUT' })).status, 405);
  const asset = await fetch(base + '/radar.mjs'); assert.equal(asset.status, 200);
  const html = await (await fetch(base + '/')).text(); assert.match(html, /What D1-D6 evaluate/); assert.match(html, /Public coarse reference/); assert.match(html, /id="model-detail"/);
});
