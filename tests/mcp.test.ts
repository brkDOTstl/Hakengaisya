import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commands } from '../lib/commands.ts';
import type { Harness2Job } from '../lib/learning.ts';
import type { expandPreset, PresetRequest } from '../lib/presets.ts';
import type { BriefInput, SubmitEvent, WorkItemInput } from '../lib/types.ts';
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

test('optimizer tools prepare a bounded job and propose submission without accepting or mutating work', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hakengaisya-mcp-optimizer-'));
  const rpc = server(t, { HAKENGAISYA_WORKSPACE: workspace });
  const runFile = 'run.json';
  const input: BriefInput = {
    ...brief,
    run_id: 'optimizer-mcp',
    work_items: [work('one')],
    improvement: { enabled: true, scope: 'fixture-project' },
  };
  assert.equal(
    (await call(rpc, 'hakengaisya_create_run', { run_file: runFile, brief: input })).isError,
    false,
  );
  const assignment = {
    owner_context: 'worker',
    reviewer_context: 'host',
    contributor_contexts: [],
    writes: ['src/one'],
    model_id: 'fixture-model',
    route: 'fixture-route',
  };
  await call(rpc, 'hakengaisya_event', {
    run_file: runFile,
    events: [
      {
        id: 'assign',
        type: 'assign',
        expected_revision: 0,
        packet_id: 'handover',
        attempt: 1,
        actor_context: 'host',
        assignment,
      },
    ],
  });
  const prepared = await rpc('tools/call', {
    name: 'hakengaisya_optimizer_job',
    arguments: { run_file: runFile, packet_id: 'handover' },
  });
  assert.equal(prepared.result.isError, false);
  const job = JSON.parse(prepared.result.content[0].text) as Harness2Job;
  assert.equal(job.supervisor_context, 'host');
  assert.equal(job.policy.max_host_calls, 9);
  await call(rpc, 'hakengaisya_event', {
    run_file: runFile,
    events: [
      {
        id: 'start',
        type: 'start',
        expected_revision: 1,
        packet_id: 'handover',
        attempt: 1,
        actor_context: 'worker',
      },
    ],
  });
  const report = {
    status: 'ready-for-submission',
    job_id: job.job_id,
    job_fingerprint: job.job_fingerprint,
    evidence_kind: job.evidence_kind,
    supervisor_review: {
      actor_context: 'host',
      decision: 'accepted',
      reason: 'Inspected the synthetic contrast.',
      evidence: [{ reference: 'fixture:contrast', summary: 'Synthetic comparison.' }],
    },
    outputs: job.dispatch.outputs.map((id) => ({
      id,
      reference: 'fixture:output',
      summary: 'Synthetic deliverable.',
    })),
    evidence: [{ reference: 'fixture:check', summary: 'Synthetic check.' }],
  };
  const result = await rpc('tools/call', {
    name: 'hakengaisya_optimizer_result',
    arguments: { run_file: runFile, job, report },
  });
  assert.equal(result.result.isError, false);
  const proposal = JSON.parse(result.result.content[0].text) as {
    event: SubmitEvent;
    requires_supervisor_task_review: boolean;
  };
  assert.equal(proposal.requires_supervisor_task_review, true);
  assert.equal(proposal.event.type, 'submit');
  const before = JSON.parse(await readFile(path.join(workspace, runFile), 'utf8'));
  assert.equal(before.packets.handover.status, 'running');
  await call(rpc, 'hakengaisya_event', { run_file: runFile, events: [proposal.event] });
  const after = JSON.parse(await readFile(path.join(workspace, runFile), 'utf8'));
  assert.equal(after.packets.handover.status, 'in_review');
  assert.deepEqual(after.artifacts, {});
});

test('preset MCP tools select and expand a draft then create a run without adding staff or dispatching', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hakengaisya-mcp-presets-'));
  const rpc = server(t, { HAKENGAISYA_WORKSPACE: workspace });
  const request: PresetRequest = JSON.parse(
    await readFile(new URL('../examples/presets/micro.json', import.meta.url), 'utf8'),
  );
  const listed = await rpc('tools/call', { name: 'hakengaisya_presets_list', arguments: {} });
  assert.equal(listed.result.isError, false);
  assert.ok(listed.result.content[0].text.includes('bounded-software'));
  const selected = await rpc('tools/call', {
    name: 'hakengaisya_preset_select',
    arguments: { request },
  });
  assert.equal(selected.result.isError, false);
  assert.equal(JSON.parse(selected.result.content[0].text).variant, 'micro');
  const response = await rpc('tools/call', {
    name: 'hakengaisya_preset_expand',
    arguments: { preset_id: 'bounded-software', request },
  });
  assert.equal(response.result.isError, false);
  const expanded = JSON.parse(response.result.content[0].text) as ReturnType<typeof expandPreset>;
  assert.equal(expanded.automatic_execution, false);
  assert.equal(expanded.staffing.execution_pool_ceiling, 1);
  const created = await call(rpc, 'hakengaisya_create_run', {
    run_file: 'preset.json',
    brief: expanded.brief,
  });
  assert.equal(created.isError, false);
  assert.equal(created.value.ready.length, 1);
  assert.deepEqual(created.value.running, []);
  const invalid = await call(rpc, 'hakengaisya_preset_expand', { preset_id: '../escape', request });
  assert.equal(invalid.isError, true);
  assert.match(invalid.value.error, /Unknown registered preset/);
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
