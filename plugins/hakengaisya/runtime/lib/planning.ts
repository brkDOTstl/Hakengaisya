import { normalizeDei, reserveDeiWork } from './participation.ts';
import { assertRegisteredSupervisor, createSupervision } from './supervision.ts';
import { validateTriageForBrief } from './triage.ts';
import type {
  BriefInput,
  DeiPolicy,
  Difficulty,
  EvidenceKind,
  PlanningLimitsInput,
  RouteProfile,
  Supervision,
  TrialEstimate,
  WorkerInput,
  WorkGraph,
  WorkItem,
  WorkItemInput,
} from './types.ts';
import { check, isRecord, requireText, requireUniqueTexts } from './validate.ts';

const DIFFICULTY_RANK: Record<Difficulty, number> = { routine: 0, standard: 1, complex: 2 };
const TECHNICAL_DOMAINS = ['software-engineering', 'technical-product-design'];
const BUILT_IN_INPUTS = ['task_brief', 'constraints', 'existing_assets'];
const DEFAULT_DIMENSIONS = ['D1', 'D2', 'D6'];
const DEFAULT_MINIMUM_SCORE = 7;
const DEFAULT_PARALLEL_CAP = 3;
const DEFAULT_PARALLEL_PREMIUM = 0.1;
const SUPPORTED_EVIDENCE = 'supported-peer-observations';
const OVERHEAD_KEYS = [
  'parallel_cost_premium',
  'overhead_seconds',
  'overhead_cost_usd',
  'context_startup_seconds',
  'context_startup_cost_usd',
] as const;
const UNPROVEN_ROUTE_POLICIES = ['refuse', 'trial'] as const;
// Trials fill evidence gaps for bounded work only; complex work still needs proven ability.
const TRIAL_DIFFICULTIES: readonly Difficulty[] = ['routine', 'standard'];
// Evidence gaps that a trial may cover. Availability, tools, reporting lines and confirmed
// failures are never bypassed.
const TRIAL_COVERABLE = new Set(['ability-or-context-unproven', 'cost-or-time-unknown']);
const EPSILON = 1e-9;

export type Qualification = 'qualified' | 'trial';

const isNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
// Estimates are reported in whole nano-dollars so float noise never reaches a reader.
const roundUsd = (value: number) => Math.round(value * 1e9) / 1e9;
const minOf = (values: number[]) => Math.min(...values);
const maxOf = (values: number[]) => Math.max(...values);

// ---------------------------------------------------------------------------
// Write scopes

export function normalizeWrites(values: unknown): string[] {
  return requireUniqueTexts(values, 'Write scope').map((value) => {
    const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
    const segments = normalized.split('/');
    check(
      normalized &&
        !/^(?:\/|[A-Za-z]:)/.test(normalized) &&
        !segments.some((part) => !part || part === '.' || part === '..') &&
        !/[?*]/.test(normalized),
      'Declare exact workspace-relative write paths',
    );
    return normalized;
  });
}

const covers = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// Case-insensitive, so Windows paths that differ only by case still serialize.
export function scopesConflict(left: readonly string[], right: readonly string[]): boolean {
  const others = right.map((path) => path.toLowerCase());
  return left.some((path) => {
    const own = path.toLowerCase();
    return others.some((other) => covers(own, other));
  });
}

// ---------------------------------------------------------------------------
// Work graph validation

function normalizeWorkItem(
  item: WorkItemInput,
  brief: BriefInput,
  supervision: Supervision | null,
): WorkItem {
  check(/^[a-z][a-z0-9_-]*$/.test(item.id), 'Invalid work identifier');
  requireText(item.objective, 'Work objective');
  requireText(item.task_type, 'Task type');
  check(Object.hasOwn(DIFFICULTY_RANK, item.difficulty), 'Each work item needs its own difficulty');
  const skills = requireUniqueTexts(item.skills, 'Skills');
  check(skills.length > 0, 'Each work item needs a skill');
  requireUniqueTexts(item.depends_on, 'Dependencies');
  const outputs = requireUniqueTexts(item.outputs, 'Outputs');
  const acceptance = requireUniqueTexts(item.acceptance, 'Work acceptance');
  check(
    outputs.length > 0 && acceptance.length > 0,
    'Each work item needs a deliverable and observable acceptance',
  );
  requireUniqueTexts(item.inputs ?? [], 'Inputs');
  requireUniqueTexts(item.audit_sources ?? [], 'Audited work');
  requireUniqueTexts(item.required_tools ?? [], 'Required tools');
  const minimum = item.minimum_score ?? DEFAULT_MINIMUM_SCORE;
  check(Number.isFinite(minimum) && minimum >= 0 && minimum <= 10, 'Invalid ability threshold');
  const dimensions = requireUniqueTexts(
    item.dimensions ?? DEFAULT_DIMENSIONS,
    'Required dimensions',
  );
  if (supervision) {
    assertRegisteredSupervisor(supervision, item.supervisor_context ?? brief.lead_context ?? '');
  }
  check(
    dimensions.length > 0 && dimensions.every((key) => /^D[1-6]$/.test(key)),
    'Supply observed required dimensions',
  );
  return {
    ...item,
    difficulty: item.difficulty as Difficulty,
    writes: normalizeWrites(item.writes),
    inputs: item.inputs ?? [],
    audit_sources: item.audit_sources ?? [],
    required_tools: item.required_tools ?? [],
    minimum_score: minimum,
    dimensions,
  };
}

function orderGraph(items: WorkItem[], external: Set<string>, producerOf: Map<string, string>) {
  const order: string[] = [];
  const ancestors = new Map<string, Set<string>>();
  while (ancestors.size < items.length) {
    const ready = items.filter(
      (item) => !ancestors.has(item.id) && item.depends_on.every((id) => ancestors.has(id)),
    );
    check(ready.length, 'Cyclic work dependencies');
    for (const item of ready) {
      const prior = new Set(item.depends_on.flatMap((id) => [id, ...(ancestors.get(id) ?? [])]));
      check(
        item.audit_sources.every((id) => prior.has(id)),
        'Independent audit must depend on the audited work',
      );
      check(
        item.inputs.every((input) => external.has(input) || prior.has(producerOf.get(input) ?? '')),
        'Input artifact must come from an accepted dependency or declared external input',
      );
      ancestors.set(item.id, prior);
      order.push(item.id);
    }
  }
  return order;
}

export function validateWorkGraph(brief: BriefInput): WorkGraph {
  normalizeDei(brief.dei);
  requireText(brief.objective, 'Objective');
  check(TECHNICAL_DOMAINS.includes(brief.domain), 'Only technical domains are active');
  check(
    Array.isArray(brief.work_items) && brief.work_items.length > 0,
    'Supply deliverable work items before creating an organization',
  );
  const supervision = brief.lead_context
    ? createSupervision(brief.lead_context, brief.reporting_lines)
    : null;
  check(
    supervision ||
      (brief.reporting_lines === undefined &&
        !brief.work_items.some((item) => item.supervisor_context !== undefined)),
    'Explicit supervision needs a root lead context',
  );
  const items = brief.work_items.map((item) => normalizeWorkItem(item, brief, supervision));
  const byId = new Map(items.map((item) => [item.id, item]));
  check(byId.size === items.length, 'Duplicate work identifier');
  const producerOf = new Map<string, string>();
  for (const item of items) {
    check(
      item.depends_on.every((id) => byId.has(id) && id !== item.id),
      'Unknown or self dependency',
    );
    for (const output of item.outputs) {
      check(!producerOf.has(output), 'Artifact needs one accountable producer');
      producerOf.set(output, item.id);
    }
  }
  const external = new Set([...BUILT_IN_INPUTS, ...Object.keys(brief.external_inputs ?? {})]);
  const order = orderGraph(items, external, producerOf);
  const referenced = new Set(items.flatMap((item) => item.depends_on));
  const terminals = items.filter((item) => !referenced.has(item.id));
  check(
    terminals.length === 1,
    'Supply one integrated terminal deliverable instead of a disconnected department chart',
  );
  const [terminal] = terminals;
  if (supervision) {
    check(
      (terminal.supervisor_context ?? brief.lead_context) === brief.lead_context,
      'The terminal delivery must report to the root supervisor',
    );
  }
  return { items, order, terminal: terminal.id };
}

// ---------------------------------------------------------------------------
// Planning limits

interface ResolvedLimits {
  max_parallel: number;
  max_workers: number;
  parallel_cost_premium: number;
  overhead_seconds: number;
  overhead_cost_usd: number;
  context_startup_seconds: number;
  context_startup_cost_usd: number;
  budget_usd?: number;
  deadline_seconds?: number;
  unproven_routes: (typeof UNPROVEN_ROUTE_POLICIES)[number];
  trial_estimate?: TrialEstimate;
  max_trial_assignments: number;
}

interface KnownOverheads {
  startupCost: boolean;
  startupTime: boolean;
  cost: boolean;
  time: boolean;
}

function requireTrialEstimate(value: unknown): asserts value is TrialEstimate {
  check(
    isRecord(value) &&
      isNonNegative(value.wall_seconds) &&
      value.wall_seconds > 0 &&
      isNonNegative(value.cost_usd),
    'Trial routes need an explicit trial_estimate with positive wall_seconds and nonnegative cost_usd',
  );
}

function planningLimits(brief: BriefInput): { limits: ResolvedLimits; known: KnownOverheads } {
  const declared: PlanningLimitsInput = brief.planning_limits ?? {};
  const merged = {
    max_parallel: DEFAULT_PARALLEL_CAP,
    parallel_cost_premium: DEFAULT_PARALLEL_PREMIUM,
    overhead_seconds: 0,
    overhead_cost_usd: 0,
    context_startup_seconds: 0,
    context_startup_cost_usd: 0,
    unproven_routes: 'refuse',
    ...declared,
  };
  const maxWorkers = merged.max_workers ?? merged.max_parallel;
  check(
    Number.isInteger(merged.max_parallel) && merged.max_parallel > 0,
    'Invalid concurrency limit',
  );
  check(Number.isInteger(maxWorkers) && maxWorkers > 0, 'Invalid execution pool limit');
  for (const key of OVERHEAD_KEYS) {
    check(isNonNegative(merged[key]), 'Invalid planning overhead or premium');
  }
  if (merged.budget_usd !== undefined) {
    check(isNonNegative(merged.budget_usd), 'Invalid estimated budget');
  }
  if (merged.deadline_seconds !== undefined) {
    check(isNonNegative(merged.deadline_seconds), 'Invalid estimated deadline');
  }
  const policy = merged.unproven_routes;
  check(
    (UNPROVEN_ROUTE_POLICIES as readonly string[]).includes(policy),
    'unproven_routes must be refuse or trial',
  );
  if (policy === 'trial') requireTrialEstimate(merged.trial_estimate);
  const maxTrials = merged.max_trial_assignments ?? Number.POSITIVE_INFINITY;
  check(
    maxTrials === Number.POSITIVE_INFINITY || (Number.isInteger(maxTrials) && maxTrials > 0),
    'max_trial_assignments must be a positive integer',
  );
  // Defaults of zero are placeholders. Only declared overheads count toward complete estimates.
  const knownStartupCost = Object.hasOwn(declared, 'context_startup_cost_usd');
  const knownStartupTime = Object.hasOwn(declared, 'context_startup_seconds');
  return {
    limits: {
      ...merged,
      max_workers: maxWorkers,
      unproven_routes: policy as ResolvedLimits['unproven_routes'],
      max_trial_assignments: maxTrials,
    },
    known: {
      startupCost: knownStartupCost,
      startupTime: knownStartupTime,
      cost: Object.hasOwn(declared, 'overhead_cost_usd') && knownStartupCost,
      time: Object.hasOwn(declared, 'overhead_seconds') && knownStartupTime,
    },
  };
}

// ---------------------------------------------------------------------------
// Route fit

interface Fit {
  worker_id: string;
  context_key: string;
  context_bound: boolean;
  model_id: string;
  route: string;
  effort: string;
  cost: number;
  seconds: number;
  qualification: Qualification;
  trial_basis?: string;
}

type FitResult = Fit | { reason: string };

function reportingLineAllows(work: WorkItem, worker: WorkerInput, brief: BriefInput): boolean {
  if (!brief.lead_context || worker.context_id === undefined) return true;
  const supervisor = work.supervisor_context ?? brief.lead_context;
  const parent = brief.reporting_lines?.find(
    (line) => line.subordinate_context === worker.context_id,
  )?.supervisor_context;
  return (
    worker.context_id !== brief.lead_context &&
    worker.context_id !== supervisor &&
    (parent === undefined || parent === supervisor)
  );
}

const hasRequiredTools = (work: WorkItem, worker: WorkerInput) =>
  !work.required_tools.length ||
  (worker.tools_verified === true &&
    work.required_tools.every((tool) => worker.tools?.includes(tool)));

const hasConfirmedModelFailure = (work: WorkItem, worker: WorkerInput, brief: BriefInput) =>
  Boolean(
    brief.failures?.some(
      (failure) =>
        failure.work_id === work.id &&
        failure.worker_id === worker.id &&
        failure.confirmed === true &&
        failure.attribution === 'model',
    ),
  );

function meetsDimensions(profile: RouteProfile, work: WorkItem): boolean {
  return work.dimensions.every((key) => {
    const dimension = profile.dimensions?.[key];
    return (
      dimension !== undefined &&
      Number.isFinite(dimension.score) &&
      dimension.score >= work.minimum_score &&
      dimension.score <= 10 &&
      dimension.support === SUPPORTED_EVIDENCE
    );
  });
}

// A profile only qualifies the exact route, effort, evidence kind and task context it observed.
function findProfile(
  work: WorkItem,
  worker: WorkerInput,
  brief: BriefInput,
  skill: string,
): RouteProfile | undefined {
  const kind = brief.evidence_kind ?? 'local_work';
  const domain = brief.domain === 'technical-product-design' ? 'technical-product' : brief.domain;
  return (worker.profiles ?? []).find(
    (profile) =>
      profile.model_id === worker.model_id &&
      profile.route === worker.route &&
      profile.effort === (worker.effort ?? 'unknown') &&
      profile.evaluation_kind === kind &&
      profile.domain === domain &&
      profile.task_type === work.task_type &&
      profile.difficulty === work.difficulty &&
      profile.skill === skill &&
      meetsDimensions(profile, work),
  );
}

type PricedProfile = RouteProfile & { observed_cost_usd: number; observed_wall_seconds: number };

const hasKnownCostAndTime = (profile: RouteProfile | undefined): profile is PricedProfile =>
  profile !== undefined &&
  isNonNegative(profile.observed_cost_usd) &&
  isNonNegative(profile.observed_wall_seconds) &&
  profile.observed_wall_seconds > 0;

function routeIdentity(worker: WorkerInput) {
  return {
    worker_id: worker.id,
    context_key: worker.context_id ?? worker.id,
    context_bound: worker.context_id !== undefined,
    model_id: worker.model_id,
    route: worker.route,
    effort: worker.effort ?? 'unknown',
  };
}

function fit(work: WorkItem, worker: WorkerInput, brief: BriefInput): FitResult {
  if (worker.available !== true) return { reason: 'route-unavailable' };
  if (!reportingLineAllows(work, worker, brief)) return { reason: 'reporting-line-incompatible' };
  if (!hasRequiredTools(work, worker)) return { reason: 'required-tool-unavailable' };
  if (hasConfirmedModelFailure(work, worker, brief)) {
    return { reason: 'confirmed-failure-needs-reassignment' };
  }
  const profiles = work.skills.map((skill) => findProfile(work, worker, brief, skill));
  if (profiles.some((profile) => !profile)) return { reason: 'ability-or-context-unproven' };
  if (!profiles.every(hasKnownCostAndTime)) return { reason: 'cost-or-time-unknown' };
  return {
    ...routeIdentity(worker),
    cost: maxOf(profiles.map((profile) => profile.observed_cost_usd)),
    seconds: maxOf(profiles.map((profile) => profile.observed_wall_seconds)),
    qualification: 'qualified',
  };
}

function trialFit(worker: WorkerInput, estimate: TrialEstimate, basis: string): Fit {
  return {
    ...routeIdentity(worker),
    cost: estimate.cost_usd,
    seconds: estimate.wall_seconds,
    qualification: 'trial',
    trial_basis: basis,
  };
}

// ---------------------------------------------------------------------------
// Plan shapes

export interface Exclusion {
  work_id: string;
  worker_id: string;
  reason: string;
}

export interface PlannedAssignment {
  work_id: string;
  worker_id: string;
  context_key: string;
  context_bound: boolean;
  model_id: string;
  route: string;
  effort: string;
  difficulty: Difficulty;
  supervisor_context: string | null;
  writes: string[];
  start_seconds: number;
  end_seconds: number;
  estimated_cost_usd: number;
  context_startup_seconds: number | null;
  context_startup_cost_usd: number | null;
  qualification: Qualification;
}

interface ContextAllocation {
  context_key: string;
  route_ids: string[];
  work: string[];
}

interface RoutingAuditCandidate {
  worker_id: string;
  model_id: string;
  model_family: string | null;
  route: string;
  outcome: 'selected' | 'excluded' | 'eligible-not-selected';
  reason: string;
}

export interface RoutingAudit {
  scope: string;
  family_filter_applied: boolean;
  boundary: string;
  work: { work_id: string; candidates: RoutingAuditCandidate[] }[];
}

interface PlanAnnotations {
  routing_audit?: RoutingAudit;
  dei?: DeiPolicy & { assigned_model_ids: string[]; missing_model_ids: string[] };
}

export interface UnplannedPlan extends PlanAnnotations {
  status: 'needs-evidence' | 'constraints-unmet';
  reason?: string;
  unassigned?: string[];
  missing_model_ids?: string[];
  assignments: PlannedAssignment[];
  organization?: ContextAllocation[];
  exclusions?: Exclusion[];
  automatic_execution: false;
}

export interface TrialSummary {
  work_ids: string[];
  estimate: TrialEstimate;
  requirement: string;
}

export interface ScheduledPlan extends PlanAnnotations {
  status: 'planned' | 'constraints-unmet';
  reason: string | null;
  evidence_kind: EvidenceKind | string;
  assignments: PlannedAssignment[];
  organization: ContextAllocation[];
  exclusions: Exclusion[];
  estimated_cost_usd: number | null;
  estimated_makespan_seconds: number | null;
  known_components_cost_usd: number;
  known_components_schedule_seconds: number;
  overheads_accounted: {
    cost: boolean;
    time: boolean;
    context_startup_cost: boolean;
    context_startup_time: boolean;
  };
  peak_parallel: number;
  serial_estimate_seconds: number;
  decomposition_warnings: { work_id: string; reason: string }[];
  trials: TrialSummary | null;
  method: string;
  estimate_basis: string;
  automatic_execution: false;
  staffing_comparison?: StaffingComparison;
}

export interface StaffingComparison {
  selected_pool_cap: number;
  minimum_parallel_savings_seconds: number;
  estimates_complete: boolean;
  alternatives: {
    pool_cap: number;
    status: DispatchPlan['status'];
    contexts: number | null;
    estimated_cost_usd: number | null;
    estimated_makespan_seconds: number | null;
  }[];
  basis: string;
}

export type DispatchPlan = ScheduledPlan | UnplannedPlan;

// planWork always attaches its route inventory audit.
export type AuditedPlan = DispatchPlan & { routing_audit: RoutingAudit };

// ---------------------------------------------------------------------------
// Pool-independent preparation

function validateWorkers(workers: unknown): asserts workers is WorkerInput[] {
  check(Array.isArray(workers) && workers.length > 0, 'Supply permitted execution routes');
  requireUniqueTexts(
    workers.map((worker) => worker?.id),
    'Worker identifiers',
  );
  for (const worker of workers) {
    requireText(worker.model_id, 'Model label');
    requireText(worker.route, 'Route');
  }
  for (const worker of workers) {
    if (worker.model_family !== undefined)
      requireText(worker.model_family, 'Declared model family');
  }
}

interface RouteInventory {
  graph: WorkGraph;
  reasons: Map<string, Map<string, string | null>>;
  exclusions: Exclusion[];
}

interface ReadyRouting extends RouteInventory {
  brief: BriefInput;
  limits: ResolvedLimits;
  known: KnownOverheads;
  matches: Map<string, Fit[]>;
  minimumSeconds: Map<string, number>;
  minimumCost: Map<string, number>;
  tails: Map<string, number>;
  trials: string[];
}

type Prepared = { inventory: RouteInventory } & (
  | { ready: ReadyRouting; unplanned?: undefined }
  | { ready?: undefined; unplanned: UnplannedPlan }
);

const unplanned = (
  fields: Omit<UnplannedPlan, 'assignments' | 'automatic_execution'> & {
    assignments?: PlannedAssignment[];
  },
): UnplannedPlan => ({
  ...fields,
  assignments: fields.assignments ?? [],
  organization: [],
  automatic_execution: false,
});

// Collect qualified routes per work item. When the policy allows trials, a work item without any
// qualified route may use routes whose only gap is evidence; qualified routes always win.
function collectRoutes(
  graph: WorkGraph,
  workers: WorkerInput[],
  brief: BriefInput,
  limits: ResolvedLimits,
  dei: DeiPolicy,
) {
  const reasons = new Map<string, Map<string, string | null>>();
  const matches = new Map<string, Fit[]>();
  const exclusions: Exclusion[] = [];
  const trials: string[] = [];
  for (const work of graph.items) {
    const byWorker = new Map<string, string | null>();
    const qualified: Fit[] = [];
    const trialable: Fit[] = [];
    for (const worker of workers) {
      const outsideRoster = dei.enabled && !dei.model_ids.includes(worker.model_id);
      const result = outsideRoster
        ? { reason: 'outside-selected-dei-roster' }
        : fit(work, worker, brief);
      if (!('reason' in result)) {
        qualified.push(result);
        byWorker.set(worker.id, null);
        continue;
      }
      byWorker.set(worker.id, result.reason);
      exclusions.push({ work_id: work.id, worker_id: worker.id, reason: result.reason });
      if (limits.trial_estimate && TRIAL_COVERABLE.has(result.reason)) {
        trialable.push(trialFit(worker, limits.trial_estimate, result.reason));
      }
    }
    const trialAllowed =
      limits.unproven_routes === 'trial' &&
      !qualified.length &&
      trialable.length > 0 &&
      TRIAL_DIFFICULTIES.includes(work.difficulty) &&
      trials.length < limits.max_trial_assignments;
    if (trialAllowed) {
      trials.push(work.id);
      for (const candidate of trialable) byWorker.set(candidate.worker_id, null);
    }
    reasons.set(work.id, byWorker);
    matches.set(work.id, trialAllowed ? trialable : qualified);
  }
  return { reasons, matches, exclusions, trials };
}

// Everything that does not depend on the pool cap: validation, route fit, DEI reservations,
// minimum costs and critical-path tails. Computed once and shared by every pool alternative.
function prepareRouting(brief: BriefInput, workers: unknown, dei: DeiPolicy): Prepared {
  validateTriageForBrief(brief);
  const graph = validateWorkGraph(brief);
  validateWorkers(workers);
  const { limits, known } = planningLimits(brief);
  const { reasons, matches, exclusions, trials } = collectRoutes(
    graph,
    workers,
    brief,
    limits,
    dei,
  );
  const inventory = { graph, reasons, exclusions };
  const needsOverheads =
    (limits.budget_usd !== undefined && !known.cost) ||
    (limits.deadline_seconds !== undefined && !known.time);
  if (needsOverheads) {
    return {
      inventory,
      unplanned: unplanned({
        status: 'needs-evidence',
        reason: 'measure-or-explicitly-estimate-handoff-review-and-context-startup',
      }),
    };
  }
  const coverage = reserveDeiWork(dei, graph, matches);
  if (coverage.missing.length) {
    return {
      inventory,
      unplanned: unplanned({
        status: 'constraints-unmet',
        reason: 'dei-coverage-unresolved',
        missing_model_ids: coverage.missing,
        exclusions,
      }),
    };
  }
  for (const [id, model] of coverage.reservations) {
    matches.set(
      id,
      (matches.get(id) ?? []).filter((candidate) => candidate.model_id === model),
    );
  }
  const candidatesOf = (id: string) => matches.get(id) ?? [];
  const unproven = graph.items
    .filter((work) => !candidatesOf(work.id).length)
    .map((work) => work.id);
  if (unproven.length) {
    return {
      inventory,
      unplanned: unplanned({ status: 'needs-evidence', unassigned: unproven, exclusions }),
    };
  }
  const minimumSeconds = new Map(
    graph.items.map((work) => [work.id, minOf(candidatesOf(work.id).map((item) => item.seconds))]),
  );
  const minimumCost = new Map(
    graph.items.map((work) => [
      work.id,
      minOf(candidatesOf(work.id).map((item) => item.cost)) + limits.overhead_cost_usd,
    ]),
  );
  return {
    inventory,
    ready: {
      ...inventory,
      brief,
      limits,
      known,
      matches,
      minimumSeconds,
      minimumCost,
      tails: criticalTails(graph, minimumSeconds, limits.overhead_seconds),
      trials,
    },
  };
}

// Longest remaining path from each work item to the terminal, using the fastest eligible route.
function criticalTails(
  graph: WorkGraph,
  minimumSeconds: Map<string, number>,
  overheadSeconds: number,
): Map<string, number> {
  const children = new Map<string, string[]>(graph.items.map((work) => [work.id, []]));
  for (const work of graph.items) {
    for (const id of work.depends_on) children.get(id)?.push(work.id);
  }
  const tails = new Map<string, number>();
  for (const id of [...graph.order].reverse()) {
    const own = (minimumSeconds.get(id) ?? 0) + overheadSeconds;
    const downstream = (children.get(id) ?? []).map((child) => tails.get(child) ?? 0);
    tails.set(id, own + maxOf([0, ...downstream]));
  }
  return tails;
}

// ---------------------------------------------------------------------------
// Scheduling for one pool cap

interface Candidate extends Fit {
  startup: number;
  startupCost: number;
  start: number;
  end: number;
}

function earliestSlot(
  work: WorkItem,
  contextKey: string,
  duration: number,
  dependencyEnd: number,
  assignments: PlannedAssignment[],
  maxParallel: number,
): number {
  let start = maxOf([
    dependencyEnd,
    ...assignments
      .filter((item) => item.context_key === contextKey)
      .map((item) => item.end_seconds),
    0,
  ]);
  for (let step = 0; step <= assignments.length * 2 + 1; step++) {
    const overlapping = assignments.filter(
      (item) => item.start_seconds < start + duration && item.end_seconds > start,
    );
    const conflicts = overlapping.filter((item) => scopesConflict(work.writes, item.writes));
    if (conflicts.length) {
      start = maxOf(conflicts.map((item) => item.end_seconds));
      continue;
    }
    const activeAt = (point: number) =>
      overlapping.filter((item) => item.start_seconds <= point && item.end_seconds > point);
    const points = [
      ...new Set([
        start,
        ...overlapping.map((item) => item.start_seconds).filter((value) => value > start),
      ]),
    ].sort((a, b) => a - b);
    const full = points.find((point) => activeAt(point).length >= maxParallel);
    if (full === undefined) return start;
    start = minOf(activeAt(full).map((item) => item.end_seconds));
  }
  throw new Error('Unable to find bounded schedule slot');
}

function readyOrder(routing: ReadyRouting, pending: Set<string>): WorkItem[] {
  const { graph, matches, tails } = routing;
  const options = (id: string) => matches.get(id)?.length ?? 0;
  const tail = (id: string) => tails.get(id) ?? 0;
  return graph.items
    .filter((work) => pending.has(work.id) && work.depends_on.every((id) => !pending.has(id)))
    .sort(
      (a, b) =>
        options(a.id) - options(b.id) ||
        DIFFICULTY_RANK[b.difficulty] - DIFFICULTY_RANK[a.difficulty] ||
        tail(b.id) - tail(a.id),
    );
}

function chooseRoute(
  candidates: Candidate[],
  limits: ResolvedLimits,
  tailAfter: number,
): Candidate {
  const deadline = limits.deadline_seconds;
  const onTime = candidates.filter(
    (item) => deadline === undefined || item.end + tailAfter <= deadline,
  );
  const pool = onTime.length ? onTime : candidates;
  const cheapest = minOf(pool.map((item) => item.cost));
  const boundedPremium = pool.filter(
    (item) => item.cost <= cheapest * (1 + limits.parallel_cost_premium) + EPSILON,
  );
  boundedPremium.sort(
    (a, b) => a.end - b.end || a.cost - b.cost || a.worker_id.localeCompare(b.worker_id),
  );
  return boundedPremium[0];
}

function scheduleForPool(routing: ReadyRouting, maxWorkers: number): DispatchPlan {
  const { brief, graph, known, matches, exclusions, minimumCost, minimumSeconds, tails } = routing;
  const limits = { ...routing.limits, max_workers: maxWorkers };
  const budget = limits.budget_usd;
  const assignments: PlannedAssignment[] = [];
  const pending = new Set(graph.order);
  let totalCost = 0;
  while (pending.size) {
    const ready = readyOrder(routing, pending);
    check(ready.length, 'No ready work');
    for (const work of ready) {
      const dependencyEnd = maxOf([
        0,
        ...assignments
          .filter((item) => work.depends_on.includes(item.work_id))
          .map((item) => item.end_seconds),
      ]);
      let reserve = 0;
      for (const id of pending) if (id !== work.id) reserve += minimumCost.get(id) ?? 0;
      const usedContexts = new Set(assignments.map((item) => item.context_key));
      const auditedContexts = new Set(
        assignments
          .filter((item) => work.audit_sources.includes(item.work_id))
          .map((item) => item.context_key),
      );
      const supervisor = work.supervisor_context ?? brief.lead_context ?? null;
      const allowed = (item: Fit) =>
        !auditedContexts.has(item.context_key) &&
        !assignments.some(
          (prior) =>
            prior.context_key === item.context_key && prior.supervisor_context !== supervisor,
        ) &&
        (usedContexts.has(item.context_key) || usedContexts.size < limits.max_workers);
      const candidates = (matches.get(work.id) ?? [])
        .filter(allowed)
        .map((item): Candidate => {
          const reused = usedContexts.has(item.context_key);
          const startup = reused ? 0 : limits.context_startup_seconds;
          const startupCost = reused ? 0 : limits.context_startup_cost_usd;
          const duration = item.seconds + limits.overhead_seconds + startup;
          const start = earliestSlot(
            work,
            item.context_key,
            duration,
            dependencyEnd,
            assignments,
            limits.max_parallel,
          );
          return {
            ...item,
            cost: item.cost + limits.overhead_cost_usd + startupCost,
            startup,
            startupCost,
            start,
            end: start + duration,
          };
        })
        .filter(
          (item) => budget === undefined || totalCost + item.cost + reserve <= budget + EPSILON,
        );
      if (!candidates.length) {
        return {
          status: 'constraints-unmet',
          reason: auditedContexts.size ? 'independence-pool-or-budget' : 'pool-or-estimated-budget',
          unassigned: [...pending],
          assignments,
          exclusions,
          automatic_execution: false,
        };
      }
      const tailAfter =
        (tails.get(work.id) ?? 0) - (minimumSeconds.get(work.id) ?? 0) - limits.overhead_seconds;
      const choice = chooseRoute(candidates, limits, tailAfter);
      totalCost += choice.cost;
      assignments.push({
        work_id: work.id,
        worker_id: choice.worker_id,
        context_key: choice.context_key,
        context_bound: choice.context_bound,
        model_id: choice.model_id,
        route: choice.route,
        effort: choice.effort,
        difficulty: work.difficulty,
        supervisor_context: supervisor,
        writes: work.writes,
        start_seconds: choice.start,
        end_seconds: choice.end,
        estimated_cost_usd: roundUsd(choice.cost),
        context_startup_seconds: known.startupTime ? choice.startup : null,
        context_startup_cost_usd: known.startupCost ? choice.startupCost : null,
        qualification: choice.qualification,
      });
      pending.delete(work.id);
    }
  }
  return summarizePlan(routing, limits, assignments, totalCost);
}

const TRIAL_REQUIREMENT =
  'A trial route has no qualifying observation for this work. The direct supervisor reviews it as usual, and the host records the observed result with the evaluator before the route counts as qualified.';

function summarizePlan(
  routing: ReadyRouting,
  limits: ResolvedLimits,
  assignments: PlannedAssignment[],
  totalCost: number,
): ScheduledPlan {
  const { brief, graph, known, exclusions, minimumSeconds, trials } = routing;
  const duration = maxOf(assignments.map((item) => item.end_seconds));
  const late = limits.deadline_seconds !== undefined && duration > limits.deadline_seconds;
  const contextKeys = [...new Set(assignments.map((item) => item.context_key))];
  const organization = contextKeys.map((key) => {
    const owned = assignments.filter((item) => item.context_key === key);
    return {
      context_key: key,
      route_ids: [...new Set(owned.map((item) => item.worker_id))],
      work: owned.map((item) => item.work_id),
    };
  });
  const activeAt = (time: number) =>
    assignments.filter((other) => other.start_seconds <= time && other.end_seconds > time).length;
  const cost = roundUsd(totalCost);
  const trialEstimate = limits.trial_estimate;
  return {
    status: late ? 'constraints-unmet' : 'planned',
    reason: late ? 'estimated-deadline' : null,
    evidence_kind: brief.evidence_kind ?? 'local_work',
    assignments,
    organization,
    exclusions,
    estimated_cost_usd: known.cost ? cost : null,
    estimated_makespan_seconds: known.time ? duration : null,
    known_components_cost_usd: cost,
    known_components_schedule_seconds: duration,
    overheads_accounted: {
      cost: known.cost,
      time: known.time,
      context_startup_cost: known.startupCost,
      context_startup_time: known.startupTime,
    },
    peak_parallel: maxOf(assignments.map((item) => activeAt(item.start_seconds))),
    serial_estimate_seconds: assignments.reduce(
      (sum, item) => sum + item.end_seconds - item.start_seconds,
      0,
    ),
    decomposition_warnings: graph.items
      .filter((work) => (minimumSeconds.get(work.id) ?? 0) <= limits.overhead_seconds)
      .map((work) => ({
        work_id: work.id,
        reason: 'handoff-overhead-at-least-work-time; consider merging tightly coupled work',
      })),
    trials:
      trials.length && trialEstimate
        ? { work_ids: [...trials], estimate: trialEstimate, requirement: TRIAL_REQUIREMENT }
        : null,
    method:
      'Greedy adequate-route planning with a bounded parallelism premium and cheapest-remaining budget reserve; not a global optimum proof.',
    estimate_basis: trials.length
      ? 'Comparable supported local task observations plus declared overhead; trial assignments use the declared trial_estimate, not observations. Not a guaranteed future duration or bill.'
      : 'Comparable supported local task observations plus declared overhead; not a guaranteed future duration or bill.',
    automatic_execution: false,
  };
}

// ---------------------------------------------------------------------------
// Pool comparison

function poolCaps(bound: number): number[] {
  if (bound <= 8) return Array.from({ length: bound }, (_, index) => index + 1);
  const powers = Array.from(
    { length: Math.ceil(Math.log2(bound)) },
    (_, index) => 2 ** (index + 3),
  );
  return [...new Set([1, 2, 3, 4, ...powers.filter((value) => value < bound), bound])];
}

function auditCandidate(
  plan: DispatchPlan,
  inventory: RouteInventory,
  workId: string,
  worker: WorkerInput,
): RoutingAuditCandidate {
  const reason = inventory.reasons.get(workId)?.get(worker.id) ?? null;
  const selected = plan.assignments.find(
    (assignment) => assignment.work_id === workId && assignment.worker_id === worker.id,
  );
  let outcome: RoutingAuditCandidate['outcome'] = 'eligible-not-selected';
  if (selected) outcome = 'selected';
  else if (reason) outcome = 'excluded';
  let explanation = reason ?? 'adequate-alternative-not-selected-by-bounded-plan';
  if (selected) {
    explanation =
      selected.qualification === 'trial'
        ? 'trial-route-selected-without-qualifying-evidence'
        : 'bounded-ability-cost-time-and-policy-plan';
  }
  return {
    worker_id: worker.id,
    model_id: worker.model_id,
    model_family: worker.model_family ?? null,
    route: worker.route,
    outcome,
    reason: explanation,
  };
}

function attachRoutingAudit<P extends DispatchPlan>(
  plan: P,
  inventory: RouteInventory,
  workers: WorkerInput[],
  dei: DeiPolicy,
): P & { routing_audit: RoutingAudit } {
  const routing_audit: RoutingAudit = {
    scope: 'supplied-permitted-route-inventory',
    family_filter_applied: false,
    boundary:
      'Model families are optional declared labels, not inferred identities. Only supplied routes are considered; this does not discover or connect other providers.',
    work: inventory.graph.items.map((item) => ({
      work_id: item.id,
      candidates: workers.map((worker) => auditCandidate(plan, inventory, item.id, worker)),
    })),
  };
  const audited: P & { routing_audit: RoutingAudit } = { ...plan, routing_audit };
  if (dei.enabled) {
    const assigned = new Set(plan.assignments.map((item) => item.model_id));
    audited.dei = {
      ...dei,
      assigned_model_ids: [...assigned],
      missing_model_ids: dei.model_ids.filter((model) => !assigned.has(model)),
    };
  }
  return audited;
}

interface Alternative {
  pool_cap: number;
  plan: DispatchPlan;
}

type FeasibleAlternative = { pool_cap: number; plan: ScheduledPlan };

// Prefer the smallest adequate pool; take a larger one only when it saves more than the
// configured time and stays within the whole-task cost premium of the cheapest feasible plan.
function selectAlternative(
  feasible: FeasibleAlternative[],
  brief: BriefInput,
  saving: number,
): FeasibleAlternative {
  const premium = brief.planning_limits?.parallel_cost_premium ?? DEFAULT_PARALLEL_PREMIUM;
  const cheapest = minOf(feasible.map((item) => item.plan.known_components_cost_usd));
  const allowed = feasible.filter(
    (item) => item.plan.known_components_cost_usd <= cheapest * (1 + premium) + EPSILON,
  );
  allowed.sort(
    (a, b) =>
      a.plan.organization.length - b.plan.organization.length ||
      a.plan.known_components_cost_usd - b.plan.known_components_cost_usd ||
      a.plan.known_components_schedule_seconds - b.plan.known_components_schedule_seconds,
  );
  let selected = allowed[0];
  for (const candidate of allowed) {
    const gain =
      selected.plan.known_components_schedule_seconds -
      candidate.plan.known_components_schedule_seconds;
    if (gain > saving + EPSILON) selected = candidate;
  }
  return selected;
}

const isFeasible = (item: Alternative): item is FeasibleAlternative =>
  item.plan.status === 'planned';

export function planWork(brief: BriefInput, workers: WorkerInput[]): AuditedPlan {
  const dei = normalizeDei(brief.dei);
  const requested =
    brief.planning_limits?.max_workers ??
    brief.planning_limits?.max_parallel ??
    DEFAULT_PARALLEL_CAP;
  check(Number.isInteger(requested) && requested > 0, 'Invalid execution pool limit');
  const saving = brief.planning_limits?.minimum_parallel_savings_seconds ?? 0;
  check(isNonNegative(saving), 'Invalid minimum parallel savings');
  const contexts = Array.isArray(workers)
    ? new Set(workers.map((worker) => worker.context_id ?? worker.id)).size
    : 0;
  const bound = Math.min(requested, contexts || 1);
  const prepared = prepareRouting(
    { ...brief, planning_limits: { ...brief.planning_limits, max_workers: requested } },
    workers,
    dei,
  );
  const withAudit = <P extends DispatchPlan>(plan: P) =>
    attachRoutingAudit(plan, prepared.inventory, workers, dei);
  if (prepared.unplanned) return withAudit(prepared.unplanned);
  const { ready } = prepared;
  const alternatives: Alternative[] = poolCaps(bound).map((cap) => ({
    pool_cap: cap,
    plan: scheduleForPool(ready, cap),
  }));
  const feasible = alternatives.filter(isFeasible);
  if (!feasible.length) return withAudit(alternatives[alternatives.length - 1].plan);
  const selected = selectAlternative(feasible, brief, saving);
  return withAudit({
    ...selected.plan,
    staffing_comparison: {
      selected_pool_cap: selected.pool_cap,
      minimum_parallel_savings_seconds: saving,
      estimates_complete:
        selected.plan.overheads_accounted.cost && selected.plan.overheads_accounted.time,
      alternatives: alternatives.map(({ pool_cap, plan }) => ({
        pool_cap,
        status: plan.status,
        contexts: plan.organization?.length ?? null,
        estimated_cost_usd: 'estimated_cost_usd' in plan ? plan.estimated_cost_usd : null,
        estimated_makespan_seconds:
          'estimated_makespan_seconds' in plan ? plan.estimated_makespan_seconds : null,
      })),
      basis:
        'Bounded greedy pool alternatives; prefer fewer adequate contexts unless extra capacity produces useful estimated time savings within the total cost premium. Unknown startup remains excluded from complete estimates. This is not a global optimum or measured saving.',
    },
  });
}
