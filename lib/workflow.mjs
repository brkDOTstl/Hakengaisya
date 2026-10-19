import path from 'node:path';
import { validateWorkGraph, scopesConflict, planWork } from './planning.mjs';
import { validateTriageForBrief } from './triage.mjs';
import { createSupervision, bindSupervisedAssignment, assertSupervisedReview, canManageWork } from './supervision.mjs';
import { normalizeDei, assertDeiAssignment, agentReview } from './participation.mjs';

const activeTemplates = new Set(['software-delivery', 'product-design']);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, name) => requireValue(typeof value === 'string' && value.trim().length > 0, `${name} must be nonempty text`);
const positive = (value, name) => requireValue(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);

export function chooseStructure(task) {
  if (task.work_items) {
    const graph = validateWorkGraph(task);
    const done = new Set(); let width = 1;
    while (done.size < graph.items.length) {
      const ready = graph.items.filter(work => !done.has(work.id) && work.depends_on.every(id => done.has(id)));
      const batch = [];
      for (const work of ready) if (!batch.some(other => scopesConflict(work.writes, other.writes))) batch.push(work);
      width = Math.max(width, batch.length); ready.forEach(work => done.add(work.id));
    }
    return { mode: width === 1 ? 'compact' : 'company', template_id: 'task-graph', max_parallel: Math.min(width, task.limits?.max_parallel ?? 3, task.planning_limits?.max_parallel ?? 3, task.planning_limits?.max_workers ?? 3), work_units: graph.items.length, reason: 'Responsibilities follow deliverable dependencies and usable parallel work; no administrative departments are added.' };
  }
  text(task.objective, 'Objective');
  requireValue(['software-engineering', 'technical-product-design'].includes(task.domain), 'Only technical software and product tasks are active');
  requireValue(['routine', 'standard', 'complex'].includes(task.difficulty), 'Specify task difficulty');
  positive(task.independent_streams ?? 1, 'Independent streams');
  requireValue(task.product_discovery === undefined || typeof task.product_discovery === 'boolean', 'Product discovery must be boolean');
  requireValue(task.request_company === undefined || typeof task.request_company === 'boolean', 'Company request must be boolean');
  const mode = task.difficulty === 'routine' && (task.independent_streams ?? 1) === 1 && !task.product_discovery && !task.request_company
    ? 'direct' : task.difficulty === 'complex' || (task.independent_streams ?? 1) > 1 ? 'company' : 'compact';
  return {
    mode, template_id: mode === 'direct' ? null : task.domain === 'technical-product-design' ? 'product-design' : 'software-delivery',
    max_parallel: mode === 'company' ? 3 : 1,
    reason: mode === 'direct' ? 'A bounded routine task can be completed directly.' : mode === 'compact' ? 'Use the reference workflow with reused responsibility slots and independent review contexts.' : 'Use the reference workflow with explicit work streams and bounded concurrency.'
  };
}

export function createRun(template, brief) {
  if (brief.work_items) return createWorkRun(brief);
  requireValue(!normalizeDei(brief.dei).enabled, 'DEI requires task-first work_items, not a reference-template rehearsal');
  requireValue(brief.reference_workflow === true, 'Supply work_items for task-first execution; reference_workflow:true is only for an explicit full-template rehearsal');
  text(brief.run_id, 'Run identifier');
  const selection = chooseStructure(brief);
  requireValue(selection.mode !== 'direct', 'Direct work does not need a company run; set request_company only when appropriate');
  requireValue(activeTemplates.has(template.id) && selection.template_id === template.id, 'Template must match the selected active domain');
  requireValue(Array.isArray(brief.acceptance) && brief.acceptance.length > 0, 'Supply observable task acceptance criteria');
  brief.acceptance.forEach(value => text(value, 'Acceptance criterion'));
  requireValue(Array.isArray(brief.constraints), 'Supply task constraints, including an empty list when none apply');
  brief.constraints.forEach(value => text(value, 'Constraint'));
  text(brief.lead_context, 'Lead context');
  requireValue(brief.evidence_kind === undefined || ['local_work', 'simulation'].includes(brief.evidence_kind), 'Invalid evidence kind');
  const limits = { max_parallel: selection.max_parallel, max_attempts: 3, max_dispatches: 24, ...brief.limits };
  Object.entries(limits).forEach(([key, value]) => { requireValue(['max_parallel', 'max_attempts', 'max_dispatches'].includes(key), 'Unknown limit'); positive(value, key); });
  const packets = Object.fromEntries(template.workflow.stages.map(stage => [stage.id, {
    id: stage.id, role: stage.owner, contributor_roles: stage.contributors, reviewer_role: stage.gate.reviewer,
    depends_on: stage.depends_on, inputs: stage.inputs, required_outputs: stage.outputs,
    checks: stage.gate.checks, rework_to: stage.gate.rework_to,
    objective: template.roles.find(role => role.id === stage.owner).purpose,
    status: 'pending', attempt: 1, assignment: null, result: null, review: null, history: []
  }]));
  requireValue(Object.keys(packets).length === template.workflow.stages.length, 'Duplicate packet identifiers');
  for (const packet of Object.values(packets)) {
    requireValue(packet.role !== packet.reviewer_role && !packet.contributor_roles.includes(packet.reviewer_role), 'Template permits producer self-review');
    requireValue(packet.depends_on.every(id => packets[id]) && packets[packet.rework_to], 'Unknown dependency or rework target');
  }
  const reachable = new Set();
  while (true) {
    const next = Object.values(packets).filter(packet => !reachable.has(packet.id) && packet.depends_on.every(id => reachable.has(id)));
    if (!next.length) break;
    next.forEach(packet => reachable.add(packet.id));
  }
  requireValue(reachable.size === Object.keys(packets).length, 'Cyclic workflow');
  return {
    schema_version: 1, run_id: brief.run_id, template_id: template.id, mode: selection.mode,
    objective: brief.objective, acceptance: brief.acceptance, constraints: brief.constraints,
    lead_context: brief.lead_context, evidence_kind: brief.evidence_kind ?? 'local_work', limits,
    organization: { root: template.root, roles: template.roles, authority: template.authority, interactions: template.interactions },
    external_inputs: { task_brief: brief.objective, constraints: brief.constraints, existing_assets: brief.existing_assets ?? [] },
    revision: 0, dispatches: 0, packets, artifacts: {}, journal: []
  };
}

export function createWorkRun(brief) {
  const intakeTriage = validateTriageForBrief(brief);
  const graph = validateWorkGraph(brief); const selection = chooseStructure(brief);
  const dispatchPlan = brief.workers ? planWork(brief, brief.workers) : null;
  const effectiveParallel = dispatchPlan?.status === 'planned' ? Math.min(selection.max_parallel, dispatchPlan.peak_parallel) : selection.max_parallel;
  text(brief.run_id, 'Run identifier'); text(brief.lead_context, 'Lead context');
  requireValue(Array.isArray(brief.acceptance) && brief.acceptance.length > 0, 'Supply final observable acceptance');
  brief.acceptance.forEach(value => text(value, 'User acceptance'));
  requireValue(Array.isArray(brief.constraints), 'Supply task constraints'); brief.constraints.forEach(value => text(value, 'Constraint'));
  requireValue(brief.evidence_kind === undefined || ['local_work', 'simulation'].includes(brief.evidence_kind), 'Invalid evidence kind');
  const limits = { max_parallel: effectiveParallel, max_attempts: brief.workers ? 2 : 1, max_dispatches: Math.max(2, graph.items.length * 2), ...brief.limits };
  Object.entries(limits).forEach(([key, value]) => { requireValue(['max_parallel', 'max_attempts', 'max_dispatches'].includes(key), 'Unknown limit'); positive(value, key); });
  const mapped = id => id === graph.terminal ? 'handover' : 'work_' + id;
  requireValue(limits.max_parallel <= (brief.planning_limits?.max_parallel ?? Infinity) && limits.max_parallel <= (brief.planning_limits?.max_workers ?? Infinity), 'Runtime concurrency must respect the planned pool and capacity');
  requireValue(limits.max_parallel <= effectiveParallel, 'Runtime concurrency must respect the selected useful staffing');
  const packets = Object.fromEntries(graph.items.map(work => [mapped(work.id), {
    id: mapped(work.id), source_work_id: work.id, task_type: work.task_type, difficulty: work.difficulty, skills: work.skills, required_tools: work.required_tools,
    role: 'execution', contributor_roles: [], reviewer_role: 'direct_supervisor', supervisor_context: work.supervisor_context ?? brief.lead_context,
    depends_on: work.depends_on.map(mapped), inputs: work.inputs, required_outputs: work.outputs,
    checks: work.acceptance, rework_to: mapped(work.id), audit_sources: work.audit_sources.map(mapped),
    objective: work.objective, declared_writes: work.writes,
    status: 'pending', attempt: 1, assignment: null, result: null, review: null, history: []
  }]));
  return {
    schema_version: 2, run_id: brief.run_id, template_id: 'task-graph', mode: effectiveParallel > 1 ? 'company' : 'compact',
    objective: brief.objective, acceptance: brief.acceptance, constraints: brief.constraints, lead_context: brief.lead_context,
    evidence_kind: brief.evidence_kind ?? 'local_work', limits, packets, revision: 0, dispatches: 0, artifacts: {}, journal: [],
    intake_triage: intakeTriage,
    dei: normalizeDei(brief.dei),
    supervision: createSupervision(brief.lead_context, brief.reporting_lines),
    organization: { root: 'task_lead', roles: [
      { id: 'task_lead', purpose: 'Root supervisor owns final acceptance and allocates bounded authority; the existing host may fill this role.' },
      { id: 'execution', purpose: 'Own deliverable work; bind one or several workers according to actual parallel work.' },
      { id: 'review', purpose: 'The direct supervisor checks, accepts or returns subordinate work; independent specialists supply evidence without taking signoff authority.' }
    ], authority: [{ from: 'task_lead', to: 'execution' }, { from: 'task_lead', to: 'review' }], interactions: [], separate_management_agent_required: false },
    external_inputs: { task_brief: brief.objective, constraints: brief.constraints, existing_assets: brief.existing_assets ?? [], ...brief.external_inputs },
    dispatch_plan: dispatchPlan, bound_execution_contexts: {},
    routing_status: brief.workers ? 'estimated-advice; host must verify and bind the permitted model' : 'unpriced-host-work; no optimized-cost claim'
  };
}

function writeScope(values) {
  requireValue(Array.isArray(values), 'Write scope must be an array; use an empty list for read-only work');
  return [...new Set(values.map(value => {
    text(value, 'Write path');
    const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
    requireValue(normalized && !path.posix.isAbsolute(normalized) && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').some(part => part === '..' || part === '.' || !part), 'Write paths must be normalized workspace-relative paths');
    return normalized;
  }))];
}

const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const depsAccepted = (run, packet) => packet.depends_on.every(id => run.packets[id].status === 'accepted');
const producers = packet => packet.assignment ? [packet.assignment.owner_context, ...packet.assignment.contributor_contexts] : [];

export function assertStartable(run, packet) {
  requireValue(packet && packet.status === 'pending' && packet.assignment && depsAccepted(run, packet), 'Packet is not assigned and dependency-ready');
  assertDeiAssignment(run.dei, packet.assignment);
  assertSupervisedReview(run, packet);
  if (packet.source_work_id) requireValue(packet.assignment_attempt === packet.attempt, 'Rework needs a renewed assignment; do not blindly restart the failed worker');
  requireValue(packet.attempt <= run.limits.max_attempts && run.dispatches < run.limits.max_dispatches, 'Run retry or dispatch limit reached; revise the plan before more work');
  const occupied = Object.values(run.packets).filter(other => other.id !== packet.id && ['running', 'in_review', 'blocked'].includes(other.status));
  requireValue(occupied.length < run.limits.max_parallel, 'Parallel work limit reached');
  for (const other of occupied) {
    requireValue(!packet.assignment.writes.some(a => other.assignment.writes.some(b => overlaps(a.toLowerCase(), b.toLowerCase()))), 'Concurrent write scopes overlap');
    requireValue(packet.assignment.owner_context !== other.assignment.owner_context, 'One owner context cannot perform two active packets at once');
  }
  const audited = packet.audit_sources ?? (packet.id === 'verification' ? ['implementation'] : packet.id === 'evaluation' ? ['prototype'] : []);
  for (const id of audited) requireValue(!producers(run.packets[id]).includes(packet.assignment.owner_context), 'Independent verification cannot be performed by the implementation producer');
}

function invalidated(run, target) {
  const result = new Set([target]);
  while (true) {
    const next = Object.values(run.packets).filter(packet => !result.has(packet.id) && packet.depends_on.some(id => result.has(id)));
    if (!next.length) return result;
    next.forEach(packet => result.add(packet.id));
  }
}

function reopen(run, target, reason) {
  for (const id of invalidated(run, target)) {
    const packet = run.packets[id];
    if (packet.status !== 'pending' || packet.result) {
      packet.history.push({ attempt: packet.attempt, status: packet.status, assignment: packet.assignment, result: packet.result, review: packet.review, invalidated_by: reason });
      packet.attempt++;
    }
    packet.status = 'pending'; packet.result = null; packet.review = null; packet.blocker = null;
    for (const output of packet.required_outputs) delete run.artifacts[output];
  }
}

export function applyEvent(current, event) {
  requireValue(event.expected_revision === current.revision, 'Stale run revision; reload before applying an event');
  text(event.id, 'Event identifier');
  requireValue(!current.journal.some(item => item.event.id === event.id), 'Event identifier already recorded');
  const run = structuredClone(current);
  const packet = run.packets[event.packet_id];
  requireValue(packet, 'Unknown packet');
  requireValue(event.attempt === packet.attempt, 'Stale packet attempt; do not accept a late worker result');
  text(event.actor_context, 'Actor context');
  switch (event.type) {
    case 'assign': {
      requireValue(packet.status === 'pending' && (run.supervision || event.actor_context === run.lead_context), 'Only the lead may assign pending work');
      const assignment = event.assignment;
      assertDeiAssignment(run.dei, assignment ?? {});
      text(assignment?.owner_context, 'Owner context'); text(assignment?.reviewer_context, 'Reviewer context');
      requireValue(Array.isArray(assignment.contributor_contexts) && assignment.contributor_contexts.length === packet.contributor_roles.length, 'Bind every declared contributor slot');
      assignment.contributor_contexts.forEach(value => text(value, 'Contributor context'));
      requireValue(![assignment.owner_context, ...assignment.contributor_contexts].includes(assignment.reviewer_context), 'Reviewer context must differ from every producer context');
      packet.assignment = { ...assignment, writes: writeScope(assignment.writes) };
      if (run.supervision) packet.assignment.supervisor_context = bindSupervisedAssignment(run, packet, assignment, event.actor_context);
      if (packet.declared_writes) requireValue(JSON.stringify(packet.assignment.writes.slice().sort()) === JSON.stringify(packet.declared_writes.slice().sort()), 'Assignment must preserve the work contract write scope');
      if (run.dispatch_plan) {
        requireValue(run.dispatch_plan.status === 'planned', 'Resolve the estimated route plan before assigning work');
        const advice = run.dispatch_plan.assignments.find(item => item.work_id === packet.source_work_id);
        requireValue(assignment.worker_id === advice.worker_id && assignment.model_id === advice.model_id && assignment.route === advice.route && assignment.effort === advice.effort, 'Declare the selected model, route, effort and worker slot; inherited defaults do not prove the planned model was used');
        if (advice.context_bound) requireValue(assignment.owner_context === advice.context_key, 'Use the preflighted actual context');
        const prior = run.bound_execution_contexts[advice.context_key];
        requireValue(!prior || prior === assignment.owner_context, 'A planned context slot cannot silently become a new employee');
        requireValue(!Object.entries(run.bound_execution_contexts).some(([key, value]) => key !== advice.context_key && value === assignment.owner_context), 'Distinct planned slots cannot silently share one actual context');
        run.bound_execution_contexts[advice.context_key] = assignment.owner_context;
      }
      if (packet.source_work_id && packet.attempt > 1) text(assignment.fit_reason, 'Renewed ability-fit justification after rejection');
      packet.assignment_attempt = packet.attempt;
      if (event.objective !== undefined) { text(event.objective, 'Packet objective'); packet.objective = event.objective; }
      break;
    }
    case 'start': {
      assertStartable(run, packet);
      requireValue(event.actor_context === packet.assignment.owner_context, 'Only the assigned owner can start work');
      packet.status = 'running'; run.dispatches++;
      break;
    }
    case 'submit': {
      requireValue(packet.status === 'running' && event.actor_context === packet.assignment.owner_context, 'Only the running packet owner can submit');
      requireValue(Array.isArray(event.outputs) && event.outputs.length === packet.required_outputs.length, 'Supply every required output exactly once');
      requireValue(new Set(event.outputs.map(item => item.id)).size === event.outputs.length, 'Duplicate output');
      for (const output of event.outputs) {
        requireValue(packet.required_outputs.includes(output.id), 'Unexpected output'); text(output.reference, 'Artifact reference'); text(output.summary, 'Artifact summary');
      }
      requireValue(Array.isArray(event.evidence) && event.evidence.length > 0, 'Supply checkable work evidence');
      event.evidence.forEach(item => { text(item.reference, 'Evidence reference'); text(item.summary, 'Evidence summary'); });
      packet.result = { outputs: event.outputs, evidence: event.evidence, attempt: packet.attempt, ...(run.supervision ? { reports_to: packet.supervisor_context } : {}) };
      packet.status = 'in_review';
      break;
    }
    case 'review': {
      assertSupervisedReview(run, packet);
      requireValue(packet.status === 'in_review' && event.actor_context === packet.assignment.reviewer_context, 'Only the assigned independent reviewer can review submitted work');
      requireValue(!producers(packet).includes(event.actor_context), 'A producer cannot accept its own packet');
      requireValue(['accepted', 'rejected'].includes(event.decision), 'Review must accept or reject');
      requireValue(Array.isArray(event.checks) && event.checks.length === packet.checks.length, 'Review every gate check');
      requireValue(new Set(event.checks.map(item => item.index)).size === packet.checks.length, 'Duplicate gate check');
      event.checks.forEach(item => {
        requireValue(Number.isInteger(item.index) && item.index >= 0 && item.index < packet.checks.length, 'Invalid gate check index');
        requireValue(['pass', 'fail', 'unverified'].includes(item.result), 'Invalid check result'); text(item.evidence_reference, 'Review evidence reference'); text(item.note, 'Review note');
      });
      const passed = event.checks.every(item => item.result === 'pass');
      requireValue(event.decision !== 'accepted' || passed, 'Failed or unverified checks cannot pass a gate');
      requireValue(event.decision !== 'rejected' || !passed, 'Rejection must identify a failed or unverified check');
      if (packet.id === 'handover' && event.decision === 'accepted') {
        requireValue(Array.isArray(event.task_checks) && event.task_checks.length === run.acceptance.length && new Set(event.task_checks.map(item => item.index)).size === run.acceptance.length, 'Final handover must check every user acceptance criterion');
        event.task_checks.forEach(item => {
          requireValue(Number.isInteger(item.index) && item.index >= 0 && item.index < run.acceptance.length && item.result === 'pass', 'Unverified user acceptance prevents completion');
          text(item.evidence_reference, 'User acceptance evidence'); text(item.note, 'User acceptance note');
        });
      }
      packet.review = { reviewer_context: event.actor_context, decision: event.decision, checks: event.checks, task_checks: event.task_checks ?? [], attempt: packet.attempt };
      if (packet.id === 'handover' && event.decision === 'accepted' && run.dei?.enabled) packet.review.agent_review = agentReview(run, true);
      if (event.decision === 'accepted') {
        packet.status = 'accepted';
        for (const output of packet.result.outputs) run.artifacts[output.id] = { ...output, producer: packet.id, attempt: packet.attempt };
      } else reopen(run, packet.rework_to, `Rejected ${packet.id} attempt ${packet.attempt}`);
      break;
    }
    case 'block': {
      requireValue(['running', 'in_review'].includes(packet.status) && [...producers(packet), packet.assignment.reviewer_context].includes(event.actor_context), 'Only a packet participant may block active work');
      text(event.reason, 'Blocker'); packet.blocker = { reason: event.reason, previous_status: packet.status }; packet.status = 'blocked'; break;
    }
    case 'resume': {
      requireValue(packet.status === 'blocked' && canManageWork(run, packet, event.actor_context) && depsAccepted(run, packet), 'Only the responsible supervision chain can resume a dependency-ready blocked packet');
      text(event.reason, 'Resolution'); packet.status = packet.blocker.previous_status; packet.blocker = null; break;
    }
    case 'reopen': {
      requireValue(canManageWork(run, packet, event.actor_context), 'Only the responsible supervision chain may reopen changed work'); text(event.reason, 'Reopen reason'); reopen(run, packet.id, event.reason); break;
    }
    default: throw new Error('Unknown workflow event');
  }
  run.revision++;
  run.journal.push({ revision: run.revision, event: structuredClone(event) });
  return run;
}

export function nextActions(run) {
  const packets = Object.values(run.packets);
  const reserved = structuredClone(run); const dispatchable = [];
  for (const packet of packets) {
    try {
      const candidate = reserved.packets[packet.id]; assertStartable(reserved, candidate);
      dispatchable.push(packet); candidate.status = 'running'; reserved.dispatches++;
    } catch { /* Leave occupied or unresolved work for a later scheduling snapshot. */ }
  }
  return {
    run_id: run.run_id, revision: run.revision,
    complete: packets.every(packet => packet.status === 'accepted'),
    dispatchable: dispatchable.map(packet => ({ id: packet.id, attempt: packet.attempt, owner_context: packet.assignment.owner_context })),
    ready: packets.filter(packet => packet.status === 'pending' && depsAccepted(run, packet)).map(packet => ({ id: packet.id, attempt: packet.attempt, role: packet.role, objective: packet.objective, assigned: Boolean(packet.assignment), inputs: packet.inputs, outputs: packet.required_outputs, checks: packet.checks, dispatch_limit_reached: packet.attempt > run.limits.max_attempts || run.dispatches >= run.limits.max_dispatches })),
    reviewing: packets.filter(packet => packet.status === 'in_review').map(packet => ({ id: packet.id, attempt: packet.attempt, reviewer_context: packet.assignment.reviewer_context, supervisor_context: packet.supervisor_context ?? null, checks: packet.checks, result: packet.result })),
    agent_review: agentReview(run),
    running: packets.filter(packet => packet.status === 'running').map(packet => packet.id),
    blocked: packets.filter(packet => packet.status === 'blocked').map(packet => ({ id: packet.id, reason: packet.blocker.reason })),
    evidence_boundary: 'Recorded references and decisions require host inspection; this state machine does not execute agents or prove artifact contents.'
  };
}
