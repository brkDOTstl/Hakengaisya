import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commands } from '../lib/commands.ts';
import type { BriefInput, WorkItemInput } from '../lib/types.ts';
import { runtimeFiles, stagedFiles } from '../scripts/runtime-files.ts';

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: string; additionalProperties: boolean };
  annotations: { readOnlyHint: boolean };
}
interface JsonRpcResponse {
  id: number;
  result: {
    serverInfo: { name: string; version: string };
    tools: McpTool[];
    isError: boolean;
    content: { text: string }[];
  };
  error: { code: number };
}
interface ToolValue {
  run_file: string;
  revision: number;
  ready: { id: string }[];
  running: string[];
  error: string;
  mode: string;
}
type Rpc = (method: string, params: unknown) => Promise<JsonRpcResponse>;

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = path.join(root, 'plugins/hakengaisya');
const work = (id: string, fields: Partial<WorkItemInput> = {}): WorkItemInput => ({
  id,
  objective: `Deliver ${id}`,
  task_type: 'implementation',
  difficulty: 'routine',
  skills: ['implementation'],
  depends_on: [],
  inputs: ['task_brief'],
  writes: [`src/${id}`],
  outputs: [`${id}_artifact`],
  acceptance: ['Behavior works.'],
  ...fields,
});
const brief: BriefInput = {
  run_id: 'mcp-fixture',
  lead_context: 'host',
  domain: 'software-engineering',
  evidence_kind: 'simulation',
  objective: 'Deliver integrated behavior.',
  constraints: ['Keep work local.'],
  acceptance: ['Both components work together.'],
  planning_limits: { max_parallel: 2 },
  work_items: [
    work('a'),
    work('b'),
    work('integrated', {
      depends_on: ['a', 'b'],
      inputs: ['a_artifact', 'b_artifact'],
      writes: ['dist'],
    }),
  ],
};

function server(t: TestContext, env: Record<string, string | undefined>): Rpc {
  const child = spawn(process.execPath, ['mcp.ts'], {
    cwd: plugin,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let buffer = '';
  const waits = new Map<number, (message: JsonRpcResponse) => void>();
  let errorText = '';
  child.stderr.on('data', (data) => {
    errorText += data;
  });
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as JsonRpcResponse;
      waits.get(message.id)?.(message);
    }
  });
  let sequence = 0;
  return async function rpc(method: string, params: unknown) {
    const id = ++sequence;
    const result = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${errorText}`)), 8000);
      waits.set(id, (message: JsonRpcResponse) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return result;
  };
}
const call = async (rpc: Rpc, name: string, args: unknown) => {
  const message = await rpc('tools/call', { name, arguments: args });
  return {
    isError: message.result.isError,
    value: JSON.parse(message.result.content[0].text) as ToolValue,
  };
};

test('the workflow plugin exposes the controller as MCP tools and persists an atomic event batch', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hakengaisya-mcp-'));
  const rpc = server(t, { HAKENGAISYA_WORKSPACE: workspace });
  const manifest = JSON.parse(
    await readFile(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'),
  );
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'hakengaisya-workflow');
  assert.equal(init.result.serverInfo.version, manifest.version);
  const listed = await rpc('tools/list', {});
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    Object.keys(commands)
      .map((key) => `hakengaisya_${key}`)
      .sort(),
  );
  assert.ok(
    listed.result.tools.every(
      (tool) =>
        tool.inputSchema.type === 'object' &&
        tool.inputSchema.additionalProperties === false &&
        tool.description.length > 20,
    ),
  );
  assert.equal(
    listed.result.tools.find((tool) => tool.name === 'hakengaisya_next')?.annotations.readOnlyHint,
    true,
  );
  assert.equal(
    listed.result.tools.find((tool) => tool.name === 'hakengaisya_event')?.annotations.readOnlyHint,
    false,
  );
  const created = await call(rpc, 'hakengaisya_create_run', { run_file: 'runs/task.json', brief });
  assert.equal(created.isError, false);
  assert.equal(created.value.run_file, path.join(workspace, 'runs', 'task.json'));
  assert.deepEqual(
    created.value.ready.map((item) => item.id),
    ['work_a', 'work_b'],
  );
  assert.equal(
    (await call(rpc, 'hakengaisya_create_run', { run_file: 'runs/task.json', brief })).isError,
    true,
  );
  const events = [
    {
      id: 'assign-a',
      expected_revision: 0,
      type: 'assign',
      packet_id: 'work_a',
      attempt: 1,
      actor_context: 'host',
      assignment: {
        owner_context: 'worker-a',
        reviewer_context: 'host',
        contributor_contexts: [],
        writes: ['src/a'],
      },
    },
    { id: 'start-a', type: 'start', packet_id: 'work_a', attempt: 1, actor_context: 'worker-a' },
  ];
  const applied = await call(rpc, 'hakengaisya_event', { run_file: 'runs/task.json', events });
  assert.equal(applied.isError, false);
  assert.equal(applied.value.revision, 2);
  assert.deepEqual(applied.value.running, ['work_a']);
  const stale = await call(rpc, 'hakengaisya_event', { run_file: 'runs/task.json', events });
  assert.equal(stale.isError, true);
  assert.match(stale.value.error, /Stale run revision/);
  const snapshot = JSON.parse(await readFile(path.join(workspace, 'runs', 'task.json'), 'utf8'));
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.journal.length, 2);
  const next = await call(rpc, 'hakengaisya_next', {
    run_file: path.join(workspace, 'runs', 'task.json'),
  });
  assert.equal(next.value.revision, 2);
  assert.deepEqual(
    next.value.ready.map((item) => item.id),
    ['work_b'],
  );
  const dispatch = await call(rpc, 'hakengaisya_dispatch', {
    run_file: 'runs/task.json',
    packet_id: 'work_b',
  });
  assert.equal(dispatch.isError, true);
  assert.match(dispatch.value.error, /not assigned/);
  assert.equal((await call(rpc, 'hakengaisya_select', { brief })).value.mode, 'company');
  assert.match(
    (await call(rpc, 'hakengaisya_unknown', {})).value.error,
    /Unknown Hakengaisya tool/,
  );
  const unsupported = await rpc('resources/list', {});
  assert.equal(unsupported.error.code, -32601);
});

test('without a workspace base the server refuses relative run paths instead of writing beside the plugin', async (t) => {
  const env = { ...process.env };
  delete env.HAKENGAISYA_WORKSPACE;
  const child = spawn(process.execPath, ['mcp.ts'], {
    cwd: plugin,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const reply = new Promise<JsonRpcResponse>((resolve) => {
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)) as JsonRpcResponse);
    });
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'hakengaisya_create_run', arguments: { run_file: 'runs/task.json', brief } },
    })}\n`,
  );
  const message = await reply;
  assert.equal(message.result.isError, true);
  assert.match(JSON.parse(message.result.content[0].text).error, /absolute run_file/);
});

test('plugin manifest registers the workflow server and the staged runtime matches the shared library', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(
    manifest.version,
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  );
  const servers = JSON.parse(await readFile(path.join(plugin, '.mcp.json'), 'utf8'));
  assert.deepEqual(servers.mcpServers.workflow, { command: 'node', args: ['./mcp.ts'] });
  const expected = runtimeFiles();
  assert.ok(expected.includes('lib/validate.ts') && !expected.includes('lib/staff.ts'));
  assert.deepEqual(stagedFiles().sort(), [...expected].sort());
  for (const file of expected) {
    assert.equal(
      await readFile(path.join(root, file), 'utf8'),
      await readFile(path.join(plugin, 'runtime', file), 'utf8'),
    );
  }
});
