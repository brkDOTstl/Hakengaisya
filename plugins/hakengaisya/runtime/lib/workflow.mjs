import { agentReview, assertDeiAssignment, normalizeDei } from './participation.mjs';
import { normalizeWrites, planWork, scopesConflict, validateWorkGraph } from './planning.mjs';
import {
  assertSupervisedReview,
  bindSupervisedAssignment,
  canManageWork,
  createSupervision,
} from './supervision.mjs';
import { validateTriageForBrief } from './triage.mjs';
import { check, requireText, requireTexts, sameMembers } from './validate.mjs';

const ACTIVE_TEMPLATES = new Set(['software-delivery', 'product-design']);
const TECHNICAL_DOMAINS = ['software-engineering', 'technical-product-design'];
const DIFFICULTIES = ['routine', 'standard', 'complex'];
const EVIDENCE_KINDS = ['local_work', 'simulation'];
const LIMIT_KEYS = ['max_parallel', 'max_attempts', 'max_dispatches'];
const OCCUPYING_STATUSES = ['running', 'in_review', 'blocked'];
const CHECK_RESULTS = ['pass', 'fail', 'unverified'];
const DEFAULT_PARALLEL_CAP = 3;
const TERMINAL_PACKET = 'handover';

// Reference-template runs persisted before 0.8.5 carry no audit_sources. These were the
// built-in independence pairs at the time; newer runs read them from the template stage.
const LEGACY_TEMPLATE_AUDITS = { verification: ['implementation'], evaluation: ['prototype'] };

const REFERENCE_REASONS = {
  direct: 'A bounded routine task can be completed directly.',
  compact:
    'Use the reference workflow with reused responsibility slots and independent review contexts.',
  company: 'Use the reference workflow with explicit work streams and bounded concurrency.',
};

const TASK_GRAPH_ORGANIZATION = {
  root: 'task_lead',
  roles: [
    {
      id: 'task_lead',
      purpose:
        'Root supervisor owns final acceptance and allocates bounded authority; the existing host may fill this role.',
    },
    {
      id: 'execution',
      purpose:
        'Own deliverable work; bind one or several workers according to actual parallel work.',
    },
    {
      id: 'review',
      purpose:
        'The direct supervisor checks, accepts or returns subordinate work; independent specialists supply evidence without taking signoff authority.',
    },
  ],
  authority: [
    { from: 'task_lead', to: 'execution' },
    { from: 'task_lead', to: 'review' },
  ],
  interactions: [],
  separate_management_agent_required: false,
};

const requirePositive = (value, name) =>
  check(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);

const requireEvidenceKind = (kind) =>
  check(kind === undefined || EVIDENCE_KINDS.includes(kind), 'Invalid evidence kind');

function requireLimits(limits) {
  for (const [key, value] of Object.entries(limits)) {
    check(LIMIT_KEYS.includes(key), 'Unknown limit');
    requirePositive(value, key);
  }
}

const freshPacketState = () => ({
  status: 'pending',
  attempt: 1,
  assignment: null,
  result: null,
  review: null,
  history: [],
});

// ---------------------------------------------------------------------------
// Structure selection

export function chooseStructure(task) {
  if (task.work_items) return taskGraphStructure(task, validateWorkGraph(task));
  requireText(task.objective, 'Objective');
  check(
    TECHNICAL_DOMAINS.includes(task.domain),
    'Only technical software and product tasks are active',
  );
  check(DIFFICULTIES.includes(task.difficulty), 'Specify task difficulty');
  const streams = task.independent_streams ?? 1;
  requirePositive(streams, 'Independent streams');
  check(
    task.product_discovery === undefined || typeof task.product_discovery === 'boolean',
    'Product discovery must be boolean',
  );
  check(
    task.request_company === undefined || typeof task.request_company === 'boolean',
    'Company request must be boolean',
  );
  const mode = referenceMode(task, streams);
  let templateId = null;
  if (mode !== 'direct') {
    templateId =
      task.domain === 'technical-product-design' ? 'product-design' : 'software-delivery';
  }
  return {
    mode,
    template_id: templateId,
    max_parallel: mode === 'company' ? DEFAULT_PARALLEL_CAP : 1,
    reason: REFERENCE_REASONS[mode],
  };
}

function referenceMode(task, streams) {
  const routineSingle = task.difficulty === 'routine' && streams === 1;
  if (routineSingle && !task.product_discovery && !task.request_company) return 'direct';
  if (task.difficulty === 'complex' || streams > 1) return 'company';
  return 'compact';
}

function taskGraphStructure(task, graph) {
  const width = usableParallelWidth(graph.items);
  return {
    mode: width === 1 ? 'compact' : 'company',
    template_id: 'task-graph',
    max_parallel: Math.min(
      width,
      task.limits?.max_parallel ?? DEFAULT_PARALLEL_CAP,
      task.planning_limits?.max_parallel ?? DEFAULT_PARALLEL_CAP,
      task.planning_limits?.max_workers ?? DEFAULT_PARALLEL_CAP,
    ),
    work_units: graph.items.length,
    reason:
      'Responsibilities follow deliverable dependencies and usable parallel work; no administrative departments are added.',
  };
}

// Width of the widest dependency layer whose members can run together with disjoint writes.
function usableParallelWidth(items) {
  const done = new Set();
  let width = 1;
  while (done.size < items.length) {
    const ready = items.filter(
      (work) => !done.has(work.id) && work.depends_on.every((id) => done.has(id)),
    );
    const batch = [];
    for (const work of ready) {
      if (!batch.some((other) => scopesConflict(work.writes, other.writes))) batch.push(work);
    }
    width = Math.max(width, batch.length);
    for (const work of ready) done.add(work.id);
  }
  return width;
}

// ---------------------------------------------------------------------------
// Run creation

export function createRun(template, brief) {
  if (brief.work_items) return createWorkRun(brief);
  return createReferenceRun(template, brief);
}

function createReferenceRun(template, brief) {
  check(
    !normalizeDei(brief.dei).enabled,
    'DEI requires task-first work_items, not a reference-template rehearsal',
  );
  check(
    brief.reference_workflow === true,
    'Supply work_items for task-first execution; reference_workflow:true is only for an explicit full-template rehearsal',
  );
  requireText(brief.run_id, 'Run identifier');
  const selection = chooseStructure(brief);
  check(
    selection.mode !== 'direct',
    'Direct work does not need a company run; set request_company only when appropriate',
  );
  check(
    ACTIVE_TEMPLATES.has(template.id) && selection.template_id === template.id,
    'Template must match the selected active domain',
  );
  check(
    Array.isArray(brief.acceptance) && brief.acceptance.length > 0,
    'Supply observable task acceptance criteria',
  );
  requireTexts(brief.acceptance, 'Acceptance criterion');
  check(
    Array.isArray(brief.constraints),
    'Supply task constraints, including an empty list when none apply',
  );
  requireTexts(brief.constraints, 'Constraint');
  requireText(brief.lead_context, 'Lead context');
  requireEvidenceKind(brief.evidence_kind);
  const limits = {
    max_parallel: selection.max_parallel,
    max_attempts: 3,
    max_dispatches: 24,
    ...brief.limits,
  };
  requireLimits(limits);
  const packets = Object.fromEntries(
    template.workflow.stages.map((stage) => [stage.id, referencePacket(template, stage)]),
  );
  check(
    Object.keys(packets).length === template.workflow.stages.length,
    'Duplicate packet identifiers',
  );
  for (const packet of Object.values(packets)) {
    check(
      packet.role !== packet.reviewer_role &&
        !packet.contributor_roles.includes(packet.reviewer_role),
      'Template permits producer self-review',
    );
    check(
      packet.depends_on.every((id) => packets[id]) && packets[packet.rework_to],
      'Unknown dependency or rework target',
    );
  }
  check(isAcyclic(packets), 'Cyclic workflow');
  return {
    schema_version: 1,
    run_id: brief.run_id,
    template_id: template.id,
    mode: selection.mode,
    objective: brief.objective,
    acceptance: brief.acceptance,
    constraints: brief.constraints,
    lead_context: brief.lead_context,
    evidence_kind: brief.evidence_kind ?? 'local_work',
    limits,
    organization: {
      root: template.root,
      roles: template.roles,
      authority: template.authority,
      interactions: template.interactions,
    },
    external_inputs: {
      task_brief: brief.objective,
      constraints: brief.constraints,
      existing_assets: brief.existing_assets ?? [],
    },
    revision: 0,
    dispatches: 0,
    packets,
    artifacts: {},
    journal: [],
  };
}

function referencePacket(template, stage) {
  return {
    id: stage.id,
    role: stage.owner,
    contributor_roles: stage.contributors,
    reviewer_role: stage.gate.reviewer,
    depends_on: stage.depends_on,
    inputs: stage.inputs,
    required_outputs: stage.outputs,
    checks: stage.gate.checks,
    rework_to: stage.gate.rework_to,
    audit_sources: stage.audits ?? [],
    objective: template.roles.find((role) => role.id === stage.owner).purpose,
    ...freshPacketState(),
  };
}

function isAcyclic(packets) {
  const reachable = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const packet of Object.values(packets)) {
      if (reachable.has(packet.id) || !packet.depends_on.every((id) => reachable.has(id))) continue;
      reachable.add(packet.id);
      grew = true;
    }
  }
  return reachable.size === Object.keys(packets).length;
}

export function createWorkRun(brief) {
  const intakeTriage = validateTriageForBrief(brief);
  const graph = validateWorkGraph(brief);
  const selection = taskGraphStructure(brief, graph);
  const dispatchPlan = brief.workers ? planWork(brief, brief.workers) : null;
  const effectiveParallel =
    dispatchPlan?.status === 'planned'
      ? Math.min(selection.max_parallel, dispatchPlan.peak_parallel)
      : selection.max_parallel;
  requireText(brief.run_id, 'Run identifier');
  requireText(brief.lead_context, 'Lead context');
  check(
    Array.isArray(brief.acceptance) && brief.acceptance.length > 0,
    'Supply final observable acceptance',
  );
  requireTexts(brief.acceptance, 'User acceptance');
  check(Array.isArray(brief.constraints), 'Supply task constraints');
  requireTexts(brief.constraints, 'Constraint');
  requireEvidenceKind(brief.evidence_kind);
  const limits = {
    max_parallel: effectiveParallel,
    max_attempts: brief.workers ? 2 : 1,
    max_dispatches: Math.max(2, graph.items.length * 2),
    ...brief.limits,
  };
  requireLimits(limits);
  check(
    limits.max_parallel <= (brief.planning_limits?.max_parallel ?? Infinity) &&
      limits.max_parallel <= (brief.planning_limits?.max_workers ?? Infinity),
    'Runtime concurrency must respect the planned pool and capacity',
  );
  check(
    limits.max_parallel <= effectiveParallel,
    'Runtime concurrency must respect the selected useful staffing',
  );
  const packetId = (workId) => (workId === graph.terminal ? TERMINAL_PACKET : `work_${workId}`);
  const packets = Object.fromEntries(
    graph.items.map((work) => [packetId(work.id), workPacket(work, brief, packetId)]),
  );
  return {
    schema_version: 2,
    run_id: brief.run_id,
    template_id: 'task-graph',
    mode: effectiveParallel > 1 ? 'company' : 'compact',
    objective: brief.objective,
    acceptance: brief.acceptance,
    constraints: brief.constraints,
    lead_context: brief.lead_context,
    evidence_kind: brief.evidence_kind ?? 'local_work',
    limits,
    packets,
    revision: 0,
    dispatches: 0,
    artifacts: {},
    journal: [],
    intake_triage: intakeTriage,
    dei: normalizeDei(brief.dei),
    supervision: createSupervision(brief.lead_context, brief.reporting_lines),
    organization: structuredClone(TASK_GRAPH_ORGANIZATION),
    external_inputs: {
      task_brief: brief.objective,
      constraints: brief.constraints,
      existing_assets: brief.existing_assets ?? [],
      ...brief.external_inputs,
    },
    dispatch_plan: dispatchPlan,
    bound_execution_contexts: {},
    routing_status: brief.workers
      ? 'estimated-advice; host must verify and bind the permitted model'
      : 'unpriced-host-work; no optimized-cost claim',
  };
}

function workPacket(work, brief, packetId) {
  return {
    id: packetId(work.id),
    source_work_id: work.id,
    task_type: work.task_type,
    difficulty: work.difficulty,
    skills: work.skills,
    required_tools: work.required_tools,
    role: 'execution',
    contributor_roles: [],
    reviewer_role: 'direct_supervisor',
    supervisor_context: work.supervisor_context ?? brief.lead_context,
    depends_on: work.depends_on.map(packetId),
    inputs: work.inputs,
    required_outputs: work.outputs,
    checks: work.acceptance,
    rework_to: packetId(work.id),
    audit_sources: work.audit_sources.map(packetId),
    objective: work.objective,
    declared_writes: work.writes,
    ...freshPacketState(),
  };
}

// ---------------------------------------------------------------------------
// Scheduling guards

const dependenciesAccepted = (run, packet) =>
  packet.depends_on.every((id) => run.packets[id].status === 'accepted');

const producersOf = (packet) =>
  packet.assignment
    ? [packet.assignment.owner_context, ...packet.assignment.contributor_contexts]
    : [];

export function assertStartable(run, packet) {
  check(
    packet && packet.status === 'pending' && packet.assignment && dependenciesAccepted(run, packet),
    'Packet is not assigned and dependency-ready',
  );
  assertDeiAssignment(run.dei, packet.assignment);
  assertSupervisedReview(run, packet);
  if (packet.source_work_id) {
    check(
      packet.assignment_attempt === packet.attempt,
      'Rework needs a renewed assignment; do not blindly restart the failed worker',
    );
  }
  check(
    packet.attempt <= run.limits.max_attempts && run.dispatches < run.limits.max_dispatches,
    'Run retry or dispatch limit reached; revise the plan before more work',
  );
  const occupied = Object.values(run.packets).filter(
    (other) => other.id !== packet.id && OCCUPYING_STATUSES.includes(other.status),
  );
  check(occupied.length < run.limits.max_parallel, 'Parallel work limit reached');
  for (const other of occupied) {
    check(
      !scopesConflict(packet.assignment.writes, other.assignment.writes),
      'Concurrent write scopes overlap',
    );
    check(
      packet.assignment.owner_context !== other.assignment.owner_context,
      'One owner context cannot perform two active packets at once',
    );
  }
  const audited = packet.audit_sources ?? LEGACY_TEMPLATE_AUDITS[packet.id] ?? [];
  for (const id of audited) {
    check(
      !producersOf(run.packets[id]).includes(packet.assignment.owner_context),
      'Independent verification cannot be performed by the implementation producer',
    );
  }
}

// ---------------------------------------------------------------------------
// Event application
//
// Runs are treated as immutable snapshots. An event works on a draft that shares every
// untouched packet with the previous snapshot and deep-copies only the packets it edits,
// so the cost of an event does not grow with the size of the journal or the whole run.

function draftRun(current) {
  const run = {
    ...current,
    packets: { ...current.packets },
    artifacts: { ...current.artifacts },
    journal: [...current.journal],
  };
  if (current.bound_execution_contexts) {
    run.bound_execution_contexts = { ...current.bound_execution_contexts };
  }
  const edited = new Set();
  return {
    run,
    packet(id) {
      if (!edited.has(id)) {
        run.packets[id] = structuredClone(current.packets[id]);
        edited.add(id);
      }
      return run.packets[id];
    },
  };
}

function downstreamOf(run, target) {
  const result = new Set([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const packet of Object.values(run.packets)) {
      if (result.has(packet.id) || !packet.depends_on.some((id) => result.has(id))) continue;
      result.add(packet.id);
      grew = true;
    }
  }
  return result;
}

function reopen(draft, target, reason) {
  for (const id of downstreamOf(draft.run, target)) {
    const packet = draft.packet(id);
    if (packet.status !== 'pending' || packet.result) {
      packet.history.push({
        attempt: packet.attempt,
        status: packet.status,
        assignment: packet.assignment,
        result: packet.result,
        review: packet.review,
        invalidated_by: reason,
      });
      packet.attempt += 1;
    }
    packet.status = 'pending';
    packet.result = null;
    packet.review = null;
    packet.blocker = null;
    for (const output of packet.required_outputs) delete draft.run.artifacts[output];
  }
}

function assignmentWrites(values) {
  check(
    Array.isArray(values),
    'Write scope must be an array; use an empty list for read-only work',
  );
  return normalizeWrites(values);
}

function bindPlannedRoute(run, packet, assignment) {
  check(
    run.dispatch_plan.status === 'planned',
    'Resolve the estimated route plan before assigning work',
  );
  const advice = run.dispatch_plan.assignments.find(
    (item) => item.work_id === packet.source_work_id,
  );
  check(
    assignment.worker_id === advice.worker_id &&
      assignment.model_id === advice.model_id &&
      assignment.route === advice.route &&
      assignment.effort === advice.effort,
    'Declare the selected model, route, effort and worker slot; inherited defaults do not prove the planned model was used',
  );
  if (advice.context_bound) {
    check(assignment.owner_context === advice.context_key, 'Use the preflighted actual context');
  }
  const bound = run.bound_execution_contexts;
  const prior = bound[advice.context_key];
  check(
    !prior || prior === assignment.owner_context,
    'A planned context slot cannot silently become a new employee',
  );
  check(
    !Object.entries(bound).some(
      ([key, value]) => key !== advice.context_key && value === assignment.owner_context,
    ),
    'Distinct planned slots cannot silently share one actual context',
  );
  bound[advice.context_key] = assignment.owner_context;
}

function applyAssign(draft, packet, event) {
  const { run } = draft;
  check(
    packet.status === 'pending' && (run.supervision || event.actor_context === run.lead_context),
    'Only the lead may assign pending work',
  );
  const assignment = event.assignment;
  assertDeiAssignment(run.dei, assignment ?? {});
  requireText(assignment?.owner_context, 'Owner context');
  requireText(assignment?.reviewer_context, 'Reviewer context');
  check(
    Array.isArray(assignment.contributor_contexts) &&
      assignment.contributor_contexts.length === packet.contributor_roles.length,
    'Bind every declared contributor slot',
  );
  requireTexts(assignment.contributor_contexts, 'Contributor context');
  check(
    ![assignment.owner_context, ...assignment.contributor_contexts].includes(
      assignment.reviewer_context,
    ),
    'Reviewer context must differ from every producer context',
  );
  packet.assignment = { ...assignment, writes: assignmentWrites(assignment.writes) };
  if (run.supervision) {
    packet.assignment.supervisor_context = bindSupervisedAssignment(
      run,
      packet,
      assignment,
      event.actor_context,
    );
  }
  if (packet.declared_writes) {
    check(
      sameMembers(packet.assignment.writes, packet.declared_writes),
      'Assignment must preserve the work contract write scope',
    );
  }
  if (run.dispatch_plan) bindPlannedRoute(run, packet, assignment);
  if (packet.source_work_id && packet.attempt > 1) {
    requireText(assignment.fit_reason, 'Renewed ability-fit justification after rejection');
  }
  packet.assignment_attempt = packet.attempt;
  if (event.objective !== undefined) {
    requireText(event.objective, 'Packet objective');
    packet.objective = event.objective;
  }
}

function applyStart(draft, packet, event) {
  assertStartable(draft.run, packet);
  check(
    event.actor_context === packet.assignment.owner_context,
    'Only the assigned owner can start work',
  );
  packet.status = 'running';
  draft.run.dispatches += 1;
}

function applySubmit(draft, packet, event) {
  check(
    packet.status === 'running' && event.actor_context === packet.assignment.owner_context,
    'Only the running packet owner can submit',
  );
  check(
    Array.isArray(event.outputs) && event.outputs.length === packet.required_outputs.length,
    'Supply every required output exactly once',
  );
  check(
    new Set(event.outputs.map((item) => item.id)).size === event.outputs.length,
    'Duplicate output',
  );
  for (const output of event.outputs) {
    check(packet.required_outputs.includes(output.id), 'Unexpected output');
    requireText(output.reference, 'Artifact reference');
    requireText(output.summary, 'Artifact summary');
  }
  check(
    Array.isArray(event.evidence) && event.evidence.length > 0,
    'Supply checkable work evidence',
  );
  for (const item of event.evidence) {
    requireText(item.reference, 'Evidence reference');
    requireText(item.summary, 'Evidence summary');
  }
  packet.result = {
    outputs: event.outputs,
    evidence: event.evidence,
    attempt: packet.attempt,
    ...(draft.run.supervision ? { reports_to: packet.supervisor_context } : {}),
  };
  packet.status = 'in_review';
}

function requireGateChecks(packet, checks) {
  check(Array.isArray(checks) && checks.length === packet.checks.length, 'Review every gate check');
  check(
    new Set(checks.map((item) => item.index)).size === packet.checks.length,
    'Duplicate gate check',
  );
  for (const item of checks) {
    check(
      Number.isInteger(item.index) && item.index >= 0 && item.index < packet.checks.length,
      'Invalid gate check index',
    );
    check(CHECK_RESULTS.includes(item.result), 'Invalid check result');
    requireText(item.evidence_reference, 'Review evidence reference');
    requireText(item.note, 'Review note');
  }
}

function requireUserAcceptance(run, taskChecks) {
  check(
    Array.isArray(taskChecks) &&
      taskChecks.length === run.acceptance.length &&
      new Set(taskChecks.map((item) => item.index)).size === run.acceptance.length,
    'Final handover must check every user acceptance criterion',
  );
  for (const item of taskChecks) {
    check(
      Number.isInteger(item.index) &&
        item.index >= 0 &&
        item.index < run.acceptance.length &&
        item.result === 'pass',
      'Unverified user acceptance prevents completion',
    );
    requireText(item.evidence_reference, 'User acceptance evidence');
    requireText(item.note, 'User acceptance note');
  }
}

function applyReview(draft, packet, event) {
  const { run } = draft;
  assertSupervisedReview(run, packet);
  check(
    packet.status === 'in_review' && event.actor_context === packet.assignment.reviewer_context,
    'Only the assigned independent reviewer can review submitted work',
  );
  check(
    !producersOf(packet).includes(event.actor_context),
    'A producer cannot accept its own packet',
  );
  check(['accepted', 'rejected'].includes(event.decision), 'Review must accept or reject');
  requireGateChecks(packet, event.checks);
  const passed = event.checks.every((item) => item.result === 'pass');
  const accepted = event.decision === 'accepted';
  check(!accepted || passed, 'Failed or unverified checks cannot pass a gate');
  check(accepted || !passed, 'Rejection must identify a failed or unverified check');
  const finalAcceptance = packet.id === TERMINAL_PACKET && accepted;
  if (finalAcceptance) requireUserAcceptance(run, event.task_checks);
  packet.review = {
    reviewer_context: event.actor_context,
    decision: event.decision,
    checks: event.checks,
    task_checks: event.task_checks ?? [],
    attempt: packet.attempt,
  };
  if (finalAcceptance && run.dei?.enabled) packet.review.agent_review = agentReview(run, true);
  if (!accepted) {
    reopen(draft, packet.rework_to, `Rejected ${packet.id} attempt ${packet.attempt}`);
    return;
  }
  packet.status = 'accepted';
  for (const output of packet.result.outputs) {
    run.artifacts[output.id] = { ...output, producer: packet.id, attempt: packet.attempt };
  }
}

function applyBlock(_draft, packet, event) {
  check(
    ['running', 'in_review'].includes(packet.status) &&
      [...producersOf(packet), packet.assignment.reviewer_context].includes(event.actor_context),
    'Only a packet participant may block active work',
  );
  requireText(event.reason, 'Blocker');
  packet.blocker = { reason: event.reason, previous_status: packet.status };
  packet.status = 'blocked';
}

function applyResume(draft, packet, event) {
  check(
    packet.status === 'blocked' &&
      canManageWork(draft.run, packet, event.actor_context) &&
      dependenciesAccepted(draft.run, packet),
    'Only the responsible supervision chain can resume a dependency-ready blocked packet',
  );
  requireText(event.reason, 'Resolution');
  packet.status = packet.blocker.previous_status;
  packet.blocker = null;
}

function applyReopen(draft, packet, event) {
  check(
    canManageWork(draft.run, packet, event.actor_context),
    'Only the responsible supervision chain may reopen changed work',
  );
  requireText(event.reason, 'Reopen reason');
  reopen(draft, packet.id, event.reason);
}

const EVENT_HANDLERS = {
  assign: applyAssign,
  start: applyStart,
  submit: applySubmit,
  review: applyReview,
  block: applyBlock,
  resume: applyResume,
  reopen: applyReopen,
};

export function applyEvent(current, input, recordedAt = new Date().toISOString()) {
  check(
    input.expected_revision === current.revision,
    'Stale run revision; reload before applying an event',
  );
  requireText(input.id, 'Event identifier');
  check(
    !current.journal.some((entry) => entry.event.id === input.id),
    'Event identifier already recorded',
  );
  check(Object.hasOwn(current.packets, input.packet_id), 'Unknown packet');
  check(
    input.attempt === current.packets[input.packet_id].attempt,
    'Stale packet attempt; do not accept a late worker result',
  );
  requireText(input.actor_context, 'Actor context');
  check(Object.hasOwn(EVENT_HANDLERS, input.type), 'Unknown workflow event');
  const event = structuredClone(input);
  const draft = draftRun(current);
  EVENT_HANDLERS[event.type](draft, draft.packet(event.packet_id), event);
  const { run } = draft;
  run.revision += 1;
  run.journal.push({ revision: run.revision, recorded_at: recordedAt, event });
  return run;
}

export function applyEvents(current, events, recordedAt) {
  check(Array.isArray(events) && events.length > 0, 'Supply one or more events');
  check(
    events[0] && Number.isInteger(events[0].expected_revision),
    'The first event of a batch must state expected_revision',
  );
  let run = current;
  for (const event of events) {
    check(event && typeof event === 'object', 'Each batch entry must be an event object');
    run = applyEvent(
      run,
      { ...event, expected_revision: event.expected_revision ?? run.revision },
      recordedAt,
    );
  }
  return run;
}

// ---------------------------------------------------------------------------
// Next actions

// Reserve capacity packet by packet, so the proposed batch itself respects concurrency,
// write scopes and owner contexts. The reservation is a shallow overlay, never persisted.
function dispatchableBatch(run) {
  const reserved = { ...run, packets: { ...run.packets } };
  const batch = [];
  for (const packet of Object.values(run.packets)) {
    // Cheap precondition first: most packets are finished or unassigned, and throwing is costly.
    if (packet.status !== 'pending' || !packet.assignment) continue;
    try {
      assertStartable(reserved, reserved.packets[packet.id]);
    } catch {
      continue;
    }
    batch.push(packet);
    reserved.packets[packet.id] = { ...packet, status: 'running' };
    reserved.dispatches += 1;
  }
  return batch;
}

export function nextActions(run) {
  const packets = Object.values(run.packets);
  const dispatchLimitReached = (packet) =>
    packet.attempt > run.limits.max_attempts || run.dispatches >= run.limits.max_dispatches;
  return {
    run_id: run.run_id,
    revision: run.revision,
    complete: packets.every((packet) => packet.status === 'accepted'),
    dispatchable: dispatchableBatch(run).map((packet) => ({
      id: packet.id,
      attempt: packet.attempt,
      owner_context: packet.assignment.owner_context,
    })),
    ready: packets
      .filter((packet) => packet.status === 'pending' && dependenciesAccepted(run, packet))
      .map((packet) => ({
        id: packet.id,
        attempt: packet.attempt,
        role: packet.role,
        objective: packet.objective,
        assigned: Boolean(packet.assignment),
        inputs: packet.inputs,
        outputs: packet.required_outputs,
        checks: packet.checks,
        dispatch_limit_reached: dispatchLimitReached(packet),
      })),
    reviewing: packets
      .filter((packet) => packet.status === 'in_review')
      .map((packet) => ({
        id: packet.id,
        attempt: packet.attempt,
        reviewer_context: packet.assignment.reviewer_context,
        supervisor_context: packet.supervisor_context ?? null,
        checks: packet.checks,
        result: packet.result,
      })),
    agent_review: agentReview(run),
    running: packets.filter((packet) => packet.status === 'running').map((packet) => packet.id),
    blocked: packets
      .filter((packet) => packet.status === 'blocked')
      .map((packet) => ({ id: packet.id, reason: packet.blocker.reason })),
    evidence_boundary:
      'Recorded references and decisions require host inspection; this state machine does not execute agents or prove artifact contents.',
  };
}
