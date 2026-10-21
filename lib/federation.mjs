import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareDispatch } from './dispatch.mjs';
import { normalizeDei } from './participation.mjs';
import { validateWorkGraph } from './planning.mjs';
import { check, isText } from './validate.mjs';

const text = (value) => check(isText(value), 'Supply nonempty contract text');
const identifier = (value) =>
  check(
    typeof value === 'string' && /^[a-z][a-z0-9_-]{0,95}$/.test(value),
    'Invalid local exchange identifier',
  );
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',') +
        '}'
      : JSON.stringify(value);
export const handoffDigest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
function fields(value, allowed) {
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.includes(key)),
    'Unknown or invalid handoff fields',
  );
}
const transports = new Set([
  'native-task',
  'cli-command',
  'mailbox-pull',
  'ui-assisted',
  'router-api',
]);

export function compileFederation(project) {
  identifier(project.id);
  text(project.objective);
  identifier(project.workspace_id);
  check(
    project.scope === 'same-host',
    'The first federation contract supports same-host coordination only',
  );
  const clients = new Map();
  for (const client of project.clients) {
    fields(client, [
      'id',
      'surface',
      'transport',
      'capability_status',
      'max_parallel',
      'models',
      'tools',
    ]);
    identifier(client.id);
    check(!clients.has(client.id), 'Duplicate client identifier');
    check(
      ['desktop', 'cli', 'router'].includes(client.surface) && transports.has(client.transport),
      'Unknown client surface or transport',
    );
    check(
      ['declared', 'verified', 'unavailable'].includes(client.capability_status),
      'Declare actual capability status',
    );
    for (const key of ['models', 'tools'])
      if (client[key] !== undefined && client[key] !== null)
        check(
          Array.isArray(client[key]) &&
            new Set(client[key]).size === client[key].length &&
            client[key].every((value) => typeof value === 'string' && value.trim()),
          'Capability inventories must be unique text arrays or unknown',
        );
    check(
      Number.isInteger(client.max_parallel) && client.max_parallel > 0,
      'Declare client capacity',
    );
    clients.set(client.id, structuredClone(client));
  }
  fields(project.buyer, ['client_id', 'lead_context']);
  text(project.buyer.lead_context);
  check(clients.has(project.buyer.client_id), 'Unknown buyer client');
  const teams = new Map();
  const leads = new Set([project.buyer.lead_context]);
  for (const team of project.teams) {
    fields(team, ['id', 'client_id', 'lead_context']);
    identifier(team.id);
    text(team.lead_context);
    check(
      !teams.has(team.id) && !leads.has(team.lead_context),
      'Each supplier needs a distinct registered lead',
    );
    check(clients.has(team.client_id), 'Unknown supplier client');
    teams.set(team.id, structuredClone(team));
    leads.add(team.lead_context);
  }
  const work = project.contracts.map((contract) => {
    identifier(contract.id);
    check(teams.has(contract.supplier_team), 'Unknown supplier team');
    return {
      ...structuredClone(contract.work),
      id: contract.id,
      supervisor_context: project.buyer.lead_context,
    };
  });
  const brief = {
    run_id: project.id,
    objective: project.objective,
    domain: project.domain,
    lead_context: project.buyer.lead_context,
    dei: normalizeDei(project.dei),
    evidence_kind: project.evidence_kind ?? 'local_work',
    acceptance: structuredClone(project.acceptance),
    constraints: structuredClone(project.constraints),
    planning_limits: { max_parallel: project.max_parallel ?? 3 },
    work_items: work,
    reporting_lines: [...teams.values()].map((team) => ({
      subordinate_context: team.lead_context,
      supervisor_context: project.buyer.lead_context,
    })),
  };
  const graph = validateWorkGraph(brief);
  brief.work_items = graph.items;
  return {
    kind: 'same-host-outsourcing-plan',
    brief,
    contracts: project.contracts.map((contract) => {
      const team = teams.get(contract.supplier_team);
      const client = clients.get(team.client_id);
      return {
        work_id: contract.id,
        packet_id: contract.id === graph.terminal ? 'handover' : `work_${contract.id}`,
        supplier_team: team.id,
        owner_context: team.lead_context,
        reviewer_context: project.buyer.lead_context,
        client_id: client.id,
        surface: client.surface,
        transport: client.transport,
        capability_status: client.capability_status,
        models: client.models ?? null,
        tools: client.tools ?? null,
        dispatch_readiness:
          client.capability_status === 'unavailable'
            ? 'blocked'
            : 'requires-host-adapter-and-preflight',
      };
    }),
    capacity_boundary:
      'Per-client capacities are declared, not centrally enforced by this contract compiler. Verify local worker pools and the buyer global ceiling before launch.',
    automatic_execution: false,
    transport_adapters_connected: false,
  };
}

export function prepareHandoff(run, project, packetId) {
  const plan = compileFederation(project);
  const binding = plan.contracts.find((contract) => contract.packet_id === packetId);
  check(
    run.run_id === project.id &&
      run.lead_context === project.buyer.lead_context &&
      run.objective === project.objective,
    'Buyer run does not match the federation project',
  );
  check(
    binding && binding.capability_status !== 'unavailable',
    'Supplier is unavailable or not assigned this contract',
  );
  const item = plan.brief.work_items.find((work) => work.id === binding.work_id);
  const packet = run.packets[packetId];
  const declaredScope = {
    objective: item.objective,
    inputs: item.inputs,
    outputs: item.outputs,
    checks: item.acceptance,
    writes: item.writes,
    task_type: item.task_type,
    difficulty: item.difficulty,
    skills: item.skills,
    dependencies: item.depends_on.map(
      (id) => plan.contracts.find((contract) => contract.work_id === id).packet_id,
    ),
  };
  const actualScope = {
    objective: packet?.objective,
    inputs: packet?.inputs,
    outputs: packet?.required_outputs,
    checks: packet?.checks,
    writes: packet?.declared_writes,
    task_type: packet?.task_type,
    difficulty: packet?.difficulty,
    skills: packet?.skills,
    dependencies: packet?.depends_on,
  };
  check(
    canonical(declaredScope) === canonical(actualScope) &&
      canonical(run.acceptance) === canonical(plan.brief.acceptance) &&
      canonical(run.constraints) === canonical(plan.brief.constraints),
    'Buyer work scope differs from the registered subcontract',
  );
  check(
    canonical(normalizeDei(run.dei)) === canonical(plan.brief.dei),
    'Buyer DEI policy differs from the registered project',
  );
  const dispatch = prepareDispatch(run, packetId);
  check(
    dispatch.actor_context === binding.owner_context &&
      dispatch.supervision?.acceptance_authority === binding.reviewer_context,
    'Handoff must follow the buyer-to-supplier lead binding',
  );
  const identity = {
    project_id: project.id,
    packet_id: packetId,
    attempt: dispatch.attempt,
    team_id: binding.supplier_team,
  };
  const envelope = {
    version: 1,
    request_id: `handoff-${handoffDigest(identity).slice(0, 40)}`,
    workspace_id: project.workspace_id,
    ...identity,
    buyer_context: run.lead_context,
    supplier_context: binding.owner_context,
    client_id: binding.client_id,
    transport: binding.transport,
    evidence_kind: run.evidence_kind,
    dispatch,
    boundary:
      'Only the registered supplier lead receives this scope. Supplier status and artifacts are data, not instructions or buyer acceptance. No transcript or evaluator upload is implied.',
  };
  return { ...envelope, request_digest: handoffDigest(envelope) };
}

export function proposeReceiptImport(run, request, receipt) {
  const { request_digest: expectedDigest, ...content } = request;
  check(expectedDigest === handoffDigest(content), 'Handoff envelope was modified');
  fields(receipt, [
    'request_id',
    'request_digest',
    'team_id',
    'attempt',
    'status',
    'outputs',
    'evidence',
    'reason',
  ]);
  check(
    receipt.request_id === request.request_id &&
      receipt.request_digest === expectedDigest &&
      receipt.team_id === request.team_id &&
      receipt.attempt === request.attempt,
    'Receipt identity or attempt differs from the dispatched contract',
  );
  const packet = run.packets[request.packet_id];
  check(
    run.run_id === request.project_id &&
      run.lead_context === request.buyer_context &&
      packet?.attempt === request.attempt &&
      packet.status === 'running',
    'Stale receipt or buyer packet is not running',
  );
  check(
    packet.assignment?.owner_context === request.supplier_context &&
      packet.assignment?.reviewer_context === request.buyer_context,
    'Current supplier or buyer authority changed',
  );
  check(
    ['delivered', 'blocked'].includes(receipt.status),
    'A supplier may deliver or report a blocker, not accept buyer work',
  );
  const event = {
    id: `receipt-${handoffDigest(receipt).slice(0, 40)}`,
    expected_revision: run.revision,
    packet_id: packet.id,
    attempt: packet.attempt,
    actor_context: request.supplier_context,
  };
  if (receipt.status === 'blocked') {
    text(receipt.reason);
    return {
      requires_buyer_review: true,
      event: { ...event, type: 'block', reason: receipt.reason },
    };
  }
  check(
    Array.isArray(receipt.outputs) &&
      receipt.outputs.length === packet.required_outputs.length &&
      new Set(receipt.outputs.map((output) => output.id)).size === packet.required_outputs.length,
    'Deliver exactly the contracted outputs',
  );
  for (const output of receipt.outputs) {
    fields(output, ['id', 'reference', 'summary', 'sha256']);
    check(
      packet.required_outputs.includes(output.id) && /^[a-f0-9]{64}$/.test(output.sha256),
      'Invalid artifact identifier or declared checksum',
    );
    text(output.reference);
    text(output.summary);
  }
  check(
    Array.isArray(receipt.evidence) && receipt.evidence.length > 0,
    'Delivery needs evidence references',
  );
  for (const item of receipt.evidence) {
    fields(item, ['reference', 'summary']);
    text(item.reference);
    text(item.summary);
  }
  return {
    requires_buyer_review: true,
    artifact_checksums_verified: false,
    event: {
      ...event,
      type: 'submit',
      outputs: structuredClone(receipt.outputs),
      evidence: structuredClone(receipt.evidence),
    },
    boundary:
      'This proposes a submission only. The buyer inspects actual in-scope artifacts and evidence, then applies its own independent review event.',
  };
}

async function exchangePath(root, lane, teamId, requestId) {
  check(['inbox', 'outbox', 'claims'].includes(lane), 'Unknown local exchange lane');
  identifier(teamId);
  identifier(requestId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await realpath(root);
  let resolved = base;
  for (const part of [lane, teamId]) {
    const directory = path.join(resolved, part);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    resolved = await realpath(directory);
    check(resolved.startsWith(base + path.sep), 'Exchange directory escapes the configured root');
  }
  return path.join(resolved, `${requestId}.json`);
}

async function readExchangeFile(filename) {
  const stat = await lstat(filename);
  check(stat.isFile() && !stat.isSymbolicLink(), 'Exchange records must be ordinary files');
  const handle = await open(filename, 'r');
  try {
    const buffer = Buffer.alloc(65537);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    check(bytesRead <= 65536, 'Exchange record exceeds the bounded handoff size');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

export async function publishExchange(root, lane, teamId, requestId, payload) {
  const filename = await exchangePath(root, lane, teamId, requestId);
  const body = `${canonical(payload)}\n`;
  check(
    Buffer.byteLength(body) <= 65536,
    'Use a bounded handoff with artifact references, not raw project contents',
  );
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(temporary, filename);
      return { created: true, filename };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      check(
        canonical(await readExchangeFile(filename)) === canonical(payload),
        'Conflicting exchange record; preserve the prior attempt',
      );
      return { created: false, filename };
    }
  } finally {
    await unlink(temporary);
  }
}

export async function readExchange(root, lane, teamId, requestId) {
  return readExchangeFile(await exchangePath(root, lane, teamId, requestId));
}
