import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFederation, prepareHandoff, proposeReceiptImport, publishExchange, readExchange, handoffDigest } from '../lib/federation.mjs';
import { createRun, applyEvent, nextActions } from '../lib/workflow.mjs';

const example = JSON.parse(await readFile(new URL('../examples/federation/local-outsourcing.json', import.meta.url)));
const project = () => structuredClone(example);
function harness(p = project()) {
  const plan = compileFederation(p); let run = createRun(null, plan.brief); let sequence = 0;
  const event = (packet, type, fields = {}) => { run = applyEvent(run, { id: 'federation-' + ++sequence, expected_revision: run.revision, packet_id: packet, attempt: run.packets[packet].attempt, actor_context: run.lead_context, type, ...fields }); };
  const assign = packetId => { const binding = plan.contracts.find(item => item.packet_id === packetId); event(packetId, 'assign', { assignment: { owner_context: binding.owner_context, reviewer_context: binding.reviewer_context, contributor_contexts: [], writes: run.packets[packetId].declared_writes } }); };
  const start = packet => event(packet, 'start', { actor_context: run.packets[packet].assignment.owner_context });
  const receipt = request => ({ request_id: request.request_id, request_digest: request.request_digest, team_id: request.team_id, attempt: request.attempt, status: 'delivered', outputs: request.dispatch.outputs.map(id => ({ id, reference: 'fixture:' + id, summary: 'Synthetic supplier output.', sha256: handoffDigest(id) })), evidence: [{ reference: 'fixture:check', summary: 'Synthetic supplier evidence only.' }] });
  return { p, plan, get run() { return run; }, event, assign, start, receipt, import(request, value) { const proposed = proposeReceiptImport(run, request, value); run = applyEvent(run, proposed.event); return proposed; } };
}

test('buyer controls supplier leads while each client declares its own delivery capability', () => {
  const h = harness(); assert.equal(h.plan.contracts.length, 3); assert.equal(h.plan.automatic_execution, false);
  assert.equal(h.plan.transport_adapters_connected, false);
  assert.ok(h.plan.contracts.every(item => item.reviewer_context === 'buyer-lead'));
  assert.deepEqual(h.run.supervision.reporting_lines.map(line => line.subordinate_context), ['engineering-agency-lead', 'client-agency-lead']);
  h.assign('work_client'); const request = prepareHandoff(h.run, h.p, 'work_client');
  assert.equal(request.transport, 'mailbox-pull'); assert.equal(request.supplier_context, 'client-agency-lead');
  assert.equal(request.dispatch.supervision.acceptance_authority, 'buyer-lead');
});

test('Desktop, CLI and mixed directions share one contract without assuming live adapters', () => {
  for (const [buyerSurface, supplierSurface] of [['desktop', 'desktop'], ['cli', 'cli'], ['desktop', 'cli'], ['cli', 'desktop']]) {
    const p = project(); p.clients[0].surface = buyerSurface; p.clients[1].surface = supplierSurface;
    const plan = compileFederation(p); assert.equal(plan.contracts[0].surface, supplierSurface); assert.equal(plan.transport_adapters_connected, false);
  }
  const p = project(); p.clients[0].surface = 'router'; p.clients[0].transport = 'router-api';
  assert.equal(compileFederation(p).automatic_execution, false);
});

test('handoff identifiers stay stable across unrelated buyer revisions and unavailable suppliers block', () => {
  const h = harness(); h.assign('work_service'); const first = prepareHandoff(h.run, h.p, 'work_service');
  h.assign('work_client'); const second = prepareHandoff(h.run, h.p, 'work_service');
  assert.equal(first.request_id, second.request_id); assert.notEqual(first.request_digest, second.request_digest);
  h.p.clients[1].capability_status = 'unavailable';
  assert.throws(() => prepareHandoff(h.run, h.p, 'work_service'), /unavailable/);
});

test('supplier delivery enters buyer review and cannot accept its own or dependent project work', () => {
  const h = harness(); h.assign('work_service'); const request = prepareHandoff(h.run, h.p, 'work_service'); h.start('work_service');
  const proposed = h.import(request, h.receipt(request));
  assert.equal(proposed.requires_buyer_review, true); assert.equal(proposed.artifact_checksums_verified, false);
  assert.equal(h.run.packets.work_service.status, 'in_review'); assert.equal(nextActions(h.run).complete, false);
  assert.equal(h.run.artifacts.service_component, undefined);
  assert.throws(() => h.event('work_service', 'review', { actor_context: request.supplier_context, decision: 'accepted', checks: [] }), /assigned independent reviewer/);
  assert.throws(() => h.import(request, h.receipt(request)), /not running/);
});

test('two agencies deliver accepted components before buyer-controlled final integration', () => {
  const h = harness(); h.assign('work_service'); h.assign('work_client');
  const requests = ['work_service', 'work_client'].map(id => prepareHandoff(h.run, h.p, id));
  for (const request of requests) h.start(request.packet_id);
  const accept = id => h.event(id, 'review', { decision: 'accepted', checks: [{ index: 0, result: 'pass', evidence_reference: 'fixture:buyer-check', note: 'Synthetic buyer verification.' }], task_checks: id === 'handover' ? [{ index: 0, result: 'pass', evidence_reference: 'fixture:integration', note: 'Synthetic final buyer acceptance.' }] : [] });
  for (const request of requests) { h.import(request, h.receipt(request)); accept(request.packet_id); }
  h.assign('handover'); const integrated = prepareHandoff(h.run, h.p, 'handover');
  assert.equal(integrated.dispatch.inputs.length, 2); h.start('handover'); h.import(integrated, h.receipt(integrated));
  assert.equal(nextActions(h.run).complete, false); accept('handover'); assert.equal(nextActions(h.run).complete, true);
});

test('changed registry work scope cannot silently redirect an existing buyer packet', () => {
  const h = harness(); h.assign('work_service'); h.p.contracts[0].work.writes = ['different-scope'];
  assert.throws(() => prepareHandoff(h.run, h.p, 'work_service'), /work scope differs/);
});

test('modified envelopes, wrong suppliers, stale attempts and injected actions cannot be imported', () => {
  const h = harness(); h.assign('work_service'); const request = prepareHandoff(h.run, h.p, 'work_service'); h.start('work_service'); const value = h.receipt(request);
  assert.throws(() => proposeReceiptImport(h.run, { ...request, supplier_context: 'impostor' }, value), /modified/);
  for (const change of [{ team_id: 'other-agency' }, { attempt: 2 }, { status: 'accepted' }, { raw_transcript: 'Unrequested local content.' }]) assert.throws(() => proposeReceiptImport(h.run, request, { ...value, ...change }));
  const incomplete = { ...value, outputs: [] }; assert.throws(() => proposeReceiptImport(h.run, request, incomplete), /contracted outputs/);
  const stale = structuredClone(h.run); stale.packets.work_service.attempt = 2;
  assert.throws(() => proposeReceiptImport(stale, request, value), /Stale receipt/);
});

test('a supplier blocker preserves buyer correction authority without a blind retry', () => {
  const h = harness(); h.assign('work_service'); const request = prepareHandoff(h.run, h.p, 'work_service'); h.start('work_service');
  h.import(request, { request_id: request.request_id, request_digest: request.request_digest, team_id: request.team_id, attempt: request.attempt, status: 'blocked', reason: 'The supplier lacks a required local tool.' });
  assert.equal(h.run.packets.work_service.status, 'blocked'); assert.equal(h.run.dispatches, 1);
  assert.equal(nextActions(h.run).complete, false);
});

test('same-host mailbox publication is atomic, idempotent and claimable only once', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-exchange-')); const value = { task: 'Synthetic bounded work.' };
  const first = await publishExchange(directory, 'inbox', 'agency', 'request-a', value);
  assert.equal(first.created, true); assert.equal((await publishExchange(directory, 'inbox', 'agency', 'request-a', value)).created, false);
  await assert.rejects(publishExchange(directory, 'inbox', 'agency', 'request-a', { task: 'Different scope.' }), /Conflicting exchange/);
  assert.deepEqual(await readExchange(directory, 'inbox', 'agency', 'request-a'), value);
  const claims = await Promise.all(Array.from({ length: 6 }, () => publishExchange(directory, 'claims', 'agency', 'request-a', { request_digest: handoffDigest(value) })));
  assert.equal(claims.filter(claim => claim.created).length, 1);
  await assert.rejects(publishExchange(directory, 'inbox', '../escape', 'request-a', value), /identifier/);
  await assert.rejects(publishExchange(directory, 'inbox', 'agency', 'oversize', { text: 'x'.repeat(66000) }), /bounded handoff/);
});

test('a separate fixture process exchanges a result; no actual AI client or model is invoked', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-process-exchange-'));
  const h = harness(); h.assign('work_service'); const request = prepareHandoff(h.run, h.p, 'work_service'); h.start('work_service');
  await publishExchange(directory, 'inbox', request.team_id, request.request_id, request);
  const moduleUrl = new URL('../lib/federation.mjs', import.meta.url).href;
  const script = `const { readExchange, publishExchange, handoffDigest } = await import(process.argv[1]); const [root, team, id] = process.argv.slice(2); const request = await readExchange(root, 'inbox', team, id); const claim = await publishExchange(root, 'claims', team, id, {request_digest:request.request_digest}); if (claim.created) await publishExchange(root, 'outbox', team, id, {request_id:id,request_digest:request.request_digest,team_id:team,attempt:request.attempt,status:'delivered',outputs:request.dispatch.outputs.map(id=>({id,reference:'fixture:'+id,summary:'Synthetic process output.',sha256:handoffDigest(id)})),evidence:[{reference:'fixture:process',summary:'Local transport simulation only.'}]});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, directory, request.team_id, request.request_id]);
  const value = await readExchange(directory, 'outbox', request.team_id, request.request_id); h.import(request, value);
  assert.equal(h.run.packets.work_service.status, 'in_review');
});

test('mailbox directory links cannot create supplier files outside the configured root', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hakengaisya-symlink-')); const outside = await mkdtemp(path.join(tmpdir(), 'hakengaisya-outside-'));
  await symlink(outside, path.join(directory, 'inbox'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishExchange(directory, 'inbox', 'agency', 'request-a', {}), /escapes/);
  await assert.rejects(lstat(path.join(outside, 'agency')), { code: 'ENOENT' });
});

test('packaged federation planning works from an unrelated directory', () => {
  const helper = fileURLToPath(new URL('../plugins/hakengaisya/runtime/scripts/workflow.mjs', import.meta.url));
  const input = fileURLToPath(new URL('../examples/federation/local-outsourcing.json', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [helper, 'federation-plan', input], { cwd: tmpdir(), encoding: 'utf8' }));
  assert.equal(result.brief.lead_context, 'buyer-lead'); assert.equal(result.automatic_execution, false);
});
