import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Recorder } from '../plugins/hakengaisya-evaluator/recorder.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

const form = () => ({
  subject_model: 'fixture-worker',
  task_type: 'basic-computation',
  difficulty: 'routine',
  tags: ['basic-computation'],
  ratings: { D1: 10, D2: null, D3: null, D4: null, D5: null, D6: null },
  comment: 'Synthetic recorder test observation.',
  example: 'The synthetic worker returned five for two plus three.',
  guidance: 'This test only demonstrates the recorder transport.',
  task_ref: 'synthetic-task',
  evaluation_kind: 'simulation',
});
async function setup(t, upload) {
  const home = path.resolve('.local', `recorder-test-${randomUUID()}`);
  await mkdir(home, { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = {
    version: 1,
    server_url: `http://127.0.0.1:${server.address().port}`,
    client_id: 'test-recorder',
    reviewer_model: 'test-reviewer',
  };
  await writeFile(path.join(home, 'connection.json'), JSON.stringify(config));
  await writeFile(path.join(home, 'task-salt'), 'synthetic-test-salt-at-least-32-characters');
  await writeFile(
    path.join(home, 'agent.key'),
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  store.enroll({
    id: config.client_id,
    collection_id: 'recorder-tests',
    model: config.reviewer_model,
    public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  return { home, store, recorder: new Recorder(home, upload), config };
}
test('a filled record is signed, accepted over HTTP, and archived locally', async (t) => {
  const h = await setup(t);
  const receipt = await h.recorder.record(form());
  assert.equal(receipt.status, 'accepted');
  assert.equal(h.store.count(), 1);
  const saved = await readFile(path.join(h.home, 'sent', `${receipt.report_id}.json`), 'utf8');
  assert.ok(!saved.includes('synthetic-task'));
  assert.ok(!saved.includes('PRIVATE KEY'));
  assert.equal(h.store.projection().profiles[0].evaluation_kind, 'simulation');
});
test('temporary upload failure queues a record and a later call retries it automatically', async (t) => {
  let offline = true;
  const h = await setup(t, async (url, report, credentials) => {
    if (offline) throw new Error('Synthetic offline');
    const { submitReport } = await import('../sdk/client.mjs');
    return submitReport(url, report, credentials);
  });
  const first = await h.recorder.record(form());
  assert.equal(first.status, 'queued');
  assert.equal(h.store.count(), 0);
  offline = false;
  const second = await h.recorder.record(form());
  assert.equal(second.status, 'accepted');
  assert.equal(h.store.count(), 1);
  assert.equal((await readdir(path.join(h.home, 'pending'))).length, 0);
});
test('a stable task record retries without adding another report or model vote', async (t) => {
  const h = await setup(t);
  const first = await h.recorder.record(form());
  const repeated = await h.recorder.record(form());
  assert.equal(first.report_id, repeated.report_id);
  assert.equal(repeated.repeated, true);
  assert.equal(h.store.count(), 1);
});
test('permanent server rejection is retained separately, not claimed as accepted', async (t) => {
  const h = await setup(t, async () => {
    throw Object.assign(new Error('Synthetic rejection'), { status: 400 });
  });
  const receipt = await h.recorder.record(form());
  assert.equal(receipt.status, 'rejected');
  assert.equal(h.store.count(), 0);
  assert.equal((await readdir(path.join(h.home, 'rejected'))).length, 1);
});
test('the recorder does not accept arbitrary upload destinations or raw data fields from AI input', async (t) => {
  const h = await setup(t);
  await assert.rejects(
    h.recorder.record({ ...form(), server_url: 'https://other.example' }),
    /Field not accepted/,
  );
  await assert.rejects(
    h.recorder.record({ ...form(), transcript: 'private' }),
    /Field not accepted/,
  );
  await assert.rejects(
    h.recorder.record({ ...form(), subject_model: 'test-reviewer' }),
    /Self-evaluation/,
  );
  assert.equal(h.store.count(), 0);
});
test('Codex-compatible stdio exposes one recorder tool and completes a real tool call', async (t) => {
  const h = await setup(t);
  const child = spawn(process.execPath, ['mcp.mjs'], {
    cwd: path.resolve('plugins/hakengaisya-evaluator'),
    env: { ...process.env, HAKENGAISYA_RECORDER_HOME: h.home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let buffer = '';
  const waits = new Map();
  let errorText = '';
  child.stderr.on('data', (data) => {
    errorText += data;
  });
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      waits.get(message.id)?.(message);
    }
  });
  async function rpc(id, method, params) {
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${errorText}`)), 5000);
      waits.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return result;
  }
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'hakengaisya-evaluator-recorder');
  const tools = await rpc(2, 'tools/list', {});
  assert.equal(tools.result.tools.length, 1);
  assert.equal(tools.result.tools[0].name, 'record_evaluation');
  const call = await rpc(3, 'tools/call', { name: 'record_evaluation', arguments: form() });
  assert.equal(call.result.isError, false);
  assert.equal(JSON.parse(call.result.content[0].text).status, 'accepted');
  assert.equal(h.store.count(), 1);
});
test('bundled runtime exactly matches the shared SDK and privacy contract', async () => {
  for (const file of ['sdk/client.mjs', 'src/contract.mjs'])
    assert.equal(
      await readFile(file, 'utf8'),
      await readFile(`plugins/hakengaisya-evaluator/runtime/${file}`, 'utf8'),
    );
  const manifest = JSON.parse(
    await readFile('plugins/hakengaisya-evaluator/.codex-plugin/plugin.json', 'utf8'),
  );
  assert.equal(manifest.mcpServers, './.mcp.json');
  const policy = await readFile(
    'plugins/hakengaisya-evaluator/skills/record-peer-evaluation/agents/openai.yaml',
    'utf8',
  );
  assert.match(policy, /allow_implicit_invocation: true/);
});
