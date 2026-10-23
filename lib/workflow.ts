import { normalizeImprovement } from './learning.ts';
import { agentReview, assertDeiAssignment, normalizeDei } from './participation.ts';
import type { DispatchPlan } from './planning.ts';
import { normalizeWrites, planWork, scopesConflict, validateWorkGraph } from './planning.ts';
import {
  assertSupervisedReview,
  bindSupervisedAssignment,
  canManageWork,
  createSupervision,
} from './supervision.ts';
import { validateTriageForBrief } from './triage.ts';
import type {
  AssignEvent,
  Assignment,
  BatchEvent,
  BriefInput,
  CheckRecord,
  EventType,
  EvidenceKind,
  Packet,
  PacketStatus,
  ReasonEvent,
  ReviewEvent,
  Run,
  RunLimits,
  RunOrganization,
  StartEvent,
  SubmitEvent,
  Template,
  TemplateStage,
  WorkflowEvent,
  WorkItem,
} from './types.ts';
import { check, requireText, requireTexts, sameMembers } from './validate.ts';

const ACTIVE_TEMPLATES = new Set(['software-delivery', 'product-design']);
const TECHNICAL_DOMAINS = ['software-engineering', 'technical-product-design'];
const DIFFICULTIES = ['routine', 'standard', 'complex'];
const EVIDENCE_KINDS: readonly string[] = ['local_work', 'simulation'];
const LIMIT_KEYS = ['max_parallel', 'max_attempts', 'max_dispatches'];
const OCCUPYING_STATUSES: readonly PacketStatus[] = ['running', 'in_review', 'blocked'];
const CHECK_RESULTS = ['pass', 'fail', 'unverified'];
const EVENT_TYPES: readonly EventType[] = [
  'assign',
  'start',
  'submit',
  'review',
  'block',
  'resume',
  'reopen',
];
const DEFAULT_PARALLEL_CAP = 3;
const TERMINAL_PACKET = 'handover';

// Reference-template runs persisted before 0.8.5 carry no audit_sources. These were the
// built-in independence pairs at the time; newer runs read them from the template stage.
const LEGACY_TEMPLATE_AUDITS: Record<string, string[]> = {
  verification: ['implementation'],
  evaluation: ['prototype'],
};

type Mode = 'direct' | 'compact' | 'company';

const REFERENCE_REASONS: Record<Mode, string> = {
  direct: 'A bounded routine task can be completed directly.',
  compact:
    'Use the reference workflow with reused responsibility slots and independent review contexts.',
  company: 'Use the reference workflow with explicit work streams and bounded concurrency.',
};

const TASK_GRAPH_ORGANIZATION: RunOrganization = {
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

export interface StructureSelection {
  mode: Mode;
  template_id: string | null;
  max_parallel: number;
  reason: string;
  work_units?: number;
}

type AssignedPacket = Packet & { assignment: Assignment };

const isAssigned = (packet: Packet | undefined): packet is AssignedPacket =>
  packet?.assignment !== null && packet?.assignment !== undefined;

function requirePositive(value: unknown, name: string): asserts value is number {
  check(Number.isSafeInteger(value) && (value as number) > 0, `${name} must be a positive integer`);
}

function requireEvidenceKind(kind: unknown): asserts kind is EvidenceKind | undefined {
  check(kind === undefined || EVIDENCE_KINDS.includes(kind as string), 'Invalid evidence kind');
}

function requireLimits(limits: Record<string, unknown>): asserts limits is Record<string, number> {
  for (const [key, value] of Object.entries(limits)) {
    check(LIMIT_KEYS.includes(key), 'Unknown limit');
    requirePositive(value, key);
  }
}

const freshPacketState = () => ({
  status: 'pending' as const,
  attempt: 1,
  assignment: null,
  result: null,
  review: null,
  history: [],
});

// ---------------------------------------------------------------------------
// Structure selection

export function chooseStructure(task: BriefInput): StructureSelection {
  if (task.work_items) return taskGraphStructure(task, validateWorkGraph(task));
  requireText(task.objective, 'Objective');
  check(
    TECHNICAL_DOMAINS.includes(task.domain),
    'Only technical software and product tasks are active',
  );
  check(DIFFICULTIES.includes(task.difficulty ?? ''), 'Specify task difficulty');
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
  let templateId: string | null = null;
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

function referenceMode(task: BriefInput, streams: number): Mode {
  const routineSingle = task.difficulty === 'routine' && streams === 1;
  if (routineSingle && !task.product_discovery && !task.request_company) return 'direct';
  if (task.difficulty === 'complex' || streams > 1) return 'company';
  return 'compact';
}

function taskGraphStructure(task: BriefInput, graph: { items: WorkItem[] }): StructureSelection {
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
function usableParallelWidth(items: WorkItem[]): number {
  const done = new Set<string>();
  let width = 1;
  while (done.size < items.length) {
    const ready = items.filter(
      (work) => !done.has(work.id) && work.depends_on.every((id) => done.has(id)),
    );
    const batch: WorkItem[] = [];
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

export function createRun(template: Template | null, brief: BriefInput): Run {
  if (brief.work_items) return createWorkRun(brief);
  return createReferenceRun(template, brief);
}

function requireBriefBasics(brief: BriefInput, acceptanceMessage: string, acceptanceName: string) {
  check(Array.isArray(brief.acceptance) && brief.acceptance.length > 0, acceptanceMessage);
  requireTexts(brief.acceptance, acceptanceName);
}

function createReferenceRun(template: Template | null, brief: BriefInput): Run {
  check(
    !normalizeImprovement(brief.improvement).enabled,
    'Harness2 improvement requires task-first work_items',
  );
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
    template !== null && ACTIVE_TEMPLATES.has(template.id) && selection.template_id === template.id,
    'Template must match the selected active domain',
  );
  requireBriefBasics(brief, 'Supply observable task acceptance criteria', 'Acceptance criterion');
  const acceptance = brief.acceptance ?? [];
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
  const packets: Record<string, Packet> = Object.fromEntries(
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
    acceptance,
    constraints: brief.constraints,
    lead_context: brief.lead_context,
    evidence_kind: brief.evidence_kind ?? 'local_work',
    limits: limits as RunLimits,
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

function referencePacket(template: Template, stage: TemplateStage): Packet {
  const owner = template.roles.find((role) => role.id === stage.owner);
  check(owner, 'Template stage owner must be a declared role');
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
    objective: owner.purpose,
    ...freshPacketState(),
  };
}

function isAcyclic(packets: Record<string, Packet>): boolean {
  const reachable = new Set<string>();
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

export function createWorkRun(brief: BriefInput): Run {
  const intakeTriage = validateTriageForBrief(brief);
  const graph = validateWorkGraph(brief);
  const selection = taskGraphStructure(brief, graph);
  const dispatchPlan: DispatchPlan | null = brief.workers ? planWork(brief, brief.workers) : null;
  const plannedRoutes = dispatchPlan?.status === 'planned' ? dispatchPlan : null;
  const effectiveParallel = plannedRoutes
    ? Math.min(selection.max_parallel, plannedRoutes.peak_parallel)
    : selection.max_parallel;
  requireText(brief.run_id, 'Run identifier');
  requireText(brief.lead_context, 'Lead context');
  requireBriefBasics(brief, 'Supply final observable acceptance', 'User acceptance');
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
    limits.max_parallel <= (brief.planning_limits?.max_parallel ?? Number.POSITIVE_INFINITY) &&
      limits.max_parallel <= (brief.planning_limits?.max_workers ?? Number.POSITIVE_INFINITY),
    'Runtime concurrency must respect the planned pool and capacity',
  );
  check(
    limits.max_parallel <= effectiveParallel,
    'Runtime concurrency must respect the selected useful staffing',
  );
  const packetId = (workId: string) =>
    workId === graph.terminal ? TERMINAL_PACKET : `work_${workId}`;
  const qualificationOf = (workId: string) =>
    plannedRoutes?.assignments.find((item) => item.work_id === workId)?.qualification;
  const packets: Record<string, Packet> = Object.fromEntries(
    graph.items.map((work) => [
      packetId(work.id),
      workPacket(work, brief.lead_context ?? '', packetId, qualificationOf(work.id)),
    ]),
  );
  return {
    schema_version: 2,
    run_id: brief.run_id,
    template_id: 'task-graph',
    mode: effectiveParallel > 1 ? 'company' : 'compact',
    objective: brief.objective,
    domain: brief.domain,
    acceptance: brief.acceptance ?? [],
    constraints: brief.constraints,
    lead_context: brief.lead_context,
    evidence_kind: brief.evidence_kind ?? 'local_work',
    limits: limits as RunLimits,
    packets,
    revision: 0,
    dispatches: 0,
    artifacts: {},
    journal: [],
    intake_triage: intakeTriage,
    dei: normalizeDei(brief.dei),
    improvement: normalizeImprovement(brief.improvement),
    planning_limits: structuredClone(brief.planning_limits ?? {}),
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

function workPacket(
  work: WorkItem,
  leadContext: string,
  packetId: (id: string) => string,
  qualification: Packet['qualification'],
): Packet {
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
    supervisor_context: work.supervisor_context ?? leadContext,
    depends_on: work.depends_on.map(packetId),
    inputs: work.inputs,
    required_outputs: work.outputs,
    checks: work.acceptance,
    rework_to: packetId(work.id),
    audit_sources: work.audit_sources.map(packetId),
    objective: work.objective,
    declared_writes: work.writes,
    ...(qualification ? { qualification } : {}),
    ...freshPacketState(),
  };
}

// ---------------------------------------------------------------------------
// Scheduling guards

const dependenciesAccepted = (run: Run, packet: Packet) =>
  packet.depends_on.every((id) => run.packets[id]?.status === 'accepted');

const producersOf = (packet: Packet | undefined): string[] =>
  packet?.assignment
    ? [packet.assignment.owner_context, ...packet.assignment.contributor_contexts]
    : [];

export function assertStartable(
  run: Run,
  packet: Packet | undefined,
): asserts packet is AssignedPacket {
  check(
    isAssigned(packet) && packet.status === 'pending' && dependenciesAccepted(run, packet),
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
    (other): other is AssignedPacket =>
      other.id !== packet.id && OCCUPYING_STATUSES.includes(other.status) && isAssigned(other),
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

interface Draft {
  run: Run;
  packet(id: string): Packet;
}

function draftRun(current: Run): Draft {
  const run: Run = {
    ...current,
    packets: { ...current.packets },
    artifacts: { ...current.artifacts },
    journal: [...current.journal],
  };
  if (current.bound_execution_contexts) {
    run.bound_execution_contexts = { ...current.bound_execution_contexts };
  }
  const edited = new Set<string>();
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

function downstreamOf(run: Run, target: string): Set<string> {
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

function reopen(draft: Draft, target: string, reason: string): void {
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

function assignmentWrites(values: unknown): string[] {
  check(
    Array.isArray(values),
    'Write scope must be an array; use an empty list for read-only work',
  );
  return normalizeWrites(values);
}

function bindPlannedRoute(run: Run, packet: Packet, assignment: Assignment): void {
  const plan = run.dispatch_plan;
  check(plan?.status === 'planned', 'Resolve the estimated route plan before assigning work');
  const advice = plan.assignments.find((item) => item.work_id === packet.source_work_id);
  check(
    advice !== undefined &&
      assignment.worker_id === advice.worker_id &&
      assignment.model_id === advice.model_id &&
      assignment.route === advice.route &&
      assignment.effort === advice.effort,
    'Declare the selected model, route, effort and worker slot; inherited defaults do not prove the planned model was used',
  );
  if (advice.context_bound) {
    check(assignment.owner_context === advice.context_key, 'Use the preflighted actual context');
  }
  run.bound_execution_contexts ??= {};
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

function applyAssign(draft: Draft, packet: Packet, event: AssignEvent): void {
  const { run } = draft;
  check(
    packet.status === 'pending' && (run.supervision || event.actor_context === run.lead_context),
    'Only the lead may assign pending work',
  );
  const input = event.assignment;
  assertDeiAssignment(run.dei, input ?? {});
  requireText(input?.owner_context, 'Owner context');
  requireText(input?.reviewer_context, 'Reviewer context');
  check(
    Array.isArray(input.contributor_contexts) &&
      input.contributor_contexts.length === packet.contributor_roles.length,
    'Bind every declared contributor slot',
  );
  requireTexts(input.contributor_contexts, 'Contributor context');
  check(
    ![input.owner_context, ...input.contributor_contexts].includes(input.reviewer_context),
    'Reviewer context must differ from every producer context',
  );
  const assignment: Assignment = { ...input, writes: assignmentWrites(input.writes) };
  packet.assignment = assignment;
  if (run.supervision) {
    assignment.supervisor_context = bindSupervisedAssignment(
      run,
      packet,
      input,
      event.actor_context,
    );
  }
  if (packet.declared_writes) {
    check(
      sameMembers(assignment.writes, packet.declared_writes),
      'Assignment must preserve the work contract write scope',
    );
  }
  if (run.dispatch_plan) bindPlannedRoute(run, packet, assignment);
  if (packet.source_work_id && packet.attempt > 1) {
    requireText(input.fit_reason, 'Renewed ability-fit justification after rejection');
  }
  packet.assignment_attempt = packet.attempt;
  if (event.objective !== undefined) {
    requireText(event.objective, 'Packet objective');
    packet.objective = event.objective;
  }
}

function applyStart(draft: Draft, packet: Packet, event: StartEvent): void {
  assertStartable(draft.run, packet);
  check(
    event.actor_context === packet.assignment.owner_context,
    'Only the assigned owner can start work',
  );
  packet.status = 'running';
  draft.run.dispatches += 1;
}

function applySubmit(draft: Draft, packet: Packet, event: SubmitEvent): void {
  check(
    packet.status === 'running' && event.actor_context === packet.assignment?.owner_context,
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
    ...(draft.run.supervision && packet.supervisor_context
      ? { reports_to: packet.supervisor_context }
      : {}),
  };
  packet.status = 'in_review';
}

function requireGateChecks(packet: Packet, checks: CheckRecord[]): void {
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

function requireUserAcceptance(run: Run, taskChecks: CheckRecord[] | undefined): void {
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

function applyReview(draft: Draft, packet: Packet, event: ReviewEvent): void {
  const { run } = draft;
  assertSupervisedReview(run, packet);
  check(
    packet.status === 'in_review' &&
      packet.result !== null &&
      event.actor_context === packet.assignment?.reviewer_context,
    'Only the assigned independent reviewer can review submitted work',
  );
  const result = packet.result;
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
  for (const output of result.outputs) {
    run.artifacts[output.id] = { ...output, producer: packet.id, attempt: packet.attempt };
  }
}

function applyBlock(packet: Packet, event: ReasonEvent): void {
  check(
    ['running', 'in_review'].includes(packet.status) &&
      packet.assignment !== null &&
      [...producersOf(packet), packet.assignment.reviewer_context].includes(event.actor_context),
    'Only a packet participant may block active work',
  );
  requireText(event.reason, 'Blocker');
  packet.blocker = { reason: event.reason, previous_status: packet.status };
  packet.status = 'blocked';
}

function applyResume(draft: Draft, packet: Packet, event: ReasonEvent): void {
  const blocker = packet.blocker;
  check(
    packet.status === 'blocked' &&
      blocker &&
      canManageWork(draft.run, packet, event.actor_context) &&
      dependenciesAccepted(draft.run, packet),
    'Only the responsible supervision chain can resume a dependency-ready blocked packet',
  );
  requireText(event.reason, 'Resolution');
  packet.status = blocker.previous_status;
  packet.blocker = null;
}

function applyReopen(draft: Draft, packet: Packet, event: ReasonEvent): void {
  check(
    canManageWork(draft.run, packet, event.actor_context),
    'Only the responsible supervision chain may reopen changed work',
  );
  requireText(event.reason, 'Reopen reason');
  reopen(draft, packet.id, event.reason);
}

function applyTyped(draft: Draft, packet: Packet, event: WorkflowEvent): void {
  switch (event.type) {
    case 'assign':
      applyAssign(draft, packet, event);
      break;
    case 'start':
      applyStart(draft, packet, event);
      break;
    case 'submit':
      applySubmit(draft, packet, event);
      break;
    case 'review':
      applyReview(draft, packet, event);
      break;
    case 'block':
      applyBlock(packet, event);
      break;
    case 'resume':
      applyResume(draft, packet, event);
      break;
    case 'reopen':
      applyReopen(draft, packet, event);
      break;
  }
}

export function applyEvent(
  current: Run,
  input: WorkflowEvent,
  recordedAt: string = new Date().toISOString(),
): Run {
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
  check(EVENT_TYPES.includes(input.type), 'Unknown workflow event');
  const event = structuredClone(input);
  const draft = draftRun(current);
  applyTyped(draft, draft.packet(event.packet_id), event);
  const { run } = draft;
  run.revision += 1;
  run.journal.push({ revision: run.revision, recorded_at: recordedAt, event });
  return run;
}

export function applyEvents(current: Run, events: BatchEvent[], recordedAt?: string): Run {
  check(Array.isArray(events) && events.length > 0, 'Supply one or more events');
  check(
    events[0] && Number.isInteger(events[0].expected_revision),
    'The first event of a batch must state expected_revision',
  );
  let run = current;
  for (const event of events) {
    check(event && typeof event === 'object', 'Each batch entry must be an event object');
    const complete = {
      ...event,
      expected_revision: event.expected_revision ?? run.revision,
    } as WorkflowEvent;
    run = applyEvent(run, complete, recordedAt);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Next actions

// Reserve capacity packet by packet, so the proposed batch itself respects concurrency,
// write scopes and owner contexts. The reservation is a shallow overlay, never persisted.
function dispatchableBatch(run: Run): AssignedPacket[] {
  const reserved: Run = { ...run, packets: { ...run.packets } };
  const batch: AssignedPacket[] = [];
  for (const packet of Object.values(run.packets)) {
    // Cheap precondition first: most packets are finished or unassigned, and throwing is costly.
    if (packet.status !== 'pending' || !isAssigned(packet)) continue;
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

export function nextActions(run: Run) {
  const packets = Object.values(run.packets);
  const dispatchLimitReached = (packet: Packet) =>
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
        ...(packet.qualification === 'trial' ? { qualification: 'trial' as const } : {}),
      })),
    reviewing: packets
      .filter(
        (packet): packet is AssignedPacket => packet.status === 'in_review' && isAssigned(packet),
      )
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
      .map((packet) => ({ id: packet.id, reason: packet.blocker?.reason ?? '' })),
    evidence_boundary:
      'Recorded references and decisions require host inspection; this state machine does not execute agents or prove artifact contents.',
  };
}
