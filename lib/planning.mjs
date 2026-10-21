import { normalizeDei, reserveDeiWork } from './participation.mjs';
import { assertRegisteredSupervisor, createSupervision } from './supervision.mjs';
import { validateTriageForBrief } from './triage.mjs';
import { check, requireText, requireUniqueTexts } from './validate.mjs';

const DIFFICULTY_RANK = { routine: 0, standard: 1, complex: 2 };
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
];
const EPSILON = 1e-9;

const isNonNegative = (value) => Number.isFinite(value) && value >= 0;
// Estimates are reported in whole nano-dollars so float noise never reaches a reader.
const roundUsd = (value) => Math.round(value * 1e9) / 1e9;
const minOf = (values) => Math.min(...values);
const maxOf = (values) => Math.max(...values);

// ---------------------------------------------------------------------------
// Write scopes

export function normalizeWrites(values) {
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

const covers = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// Case-insensitive, so Windows paths that differ only by case still serialize.
export function scopesConflict(left, right) {
  const others = right.map((path) => path.toLowerCase());
  return left.some((path) => {
    const own = path.toLowerCase();
    return others.some((other) => covers(own, other));
  });
}

// ---------------------------------------------------------------------------
// Work graph validation

function normalizeWorkItem(item, brief, supervision) {
  check(/^[a-z][a-z0-9_-]*$/.test(item.id), 'Invalid work identifier');
  requireText(item.objective, 'Work objective');
  requireText(item.task_type, 'Task type');
  check(Object.hasOwn(DIFFICULTY_RANK, item.difficulty), 'Each work item needs its own difficulty');
  requireUniqueTexts(item.skills, 'Skills');
  check(item.skills.length > 0, 'Each work item needs a skill');
  requireUniqueTexts(item.depends_on, 'Dependencies');
  requireUniqueTexts(item.outputs, 'Outputs');
  requireUniqueTexts(item.acceptance, 'Work acceptance');
  check(
    item.outputs.length > 0 && item.acceptance.length > 0,
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
    assertRegisteredSupervisor(supervision, item.supervisor_context ?? brief.lead_context);
  }
  check(
    dimensions.length > 0 && dimensions.every((key) => /^D[1-6]$/.test(key)),
    'Supply observed required dimensions',
  );
  return {
    ...item,
    writes: normalizeWrites(item.writes),
    inputs: item.inputs ?? [],
    audit_sources: item.audit_sources ?? [],
    required_tools: item.required_tools ?? [],
    minimum_score: minimum,
    dimensions,
  };
}

export function validateWorkGraph(brief) {
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
  const producerOf = new Map();
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
  const order = [];
  const ancestors = new Map();
  while (ancestors.size < items.length) {
    const ready = items.filter(
      (item) => !ancestors.has(item.id) && item.depends_on.every((id) => ancestors.has(id)),
    );
    check(ready.length, 'Cyclic work dependencies');
    for (const item of ready) {
      const prior = new Set(item.depends_on.flatMap((id) => [id, ...ancestors.get(id)]));
      check(
        item.audit_sources.every((id) => prior.has(id)),
        'Independent audit must depend on the audited work',
      );
      check(
        item.inputs.every((input) => external.has(input) || prior.has(producerOf.get(input))),
        'Input artifact must come from an accepted dependency or declared external input',
      );
      ancestors.set(item.id, prior);
      order.push(item.id);
    }
  }
  const referenced = new Set(items.flatMap((item) => item.depends_on));
  const terminals = items.filter((item) => !referenced.has(item.id));
  check(
    terminals.length === 1,
    'Supply one integrated terminal deliverable instead of a disconnected department chart',
  );
  if (supervision) {
    check(
      (terminals[0].supervisor_context ?? brief.lead_context) === brief.lead_context,
      'The terminal delivery must report to the root supervisor',
    );
  }
  return { items, order, terminal: terminals[0].id };
}

// ---------------------------------------------------------------------------
// Route fit

function reportingLineAllows(work, worker, brief) {
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

const hasRequiredTools = (work, worker) =>
  !work.required_tools.length ||
  (worker.tools_verified === true &&
    work.required_tools.every((tool) => worker.tools?.includes(tool)));

const hasConfirmedModelFailure = (work, worker, brief) =>
  Boolean(
    brief.failures?.some(
      (failure) =>
        failure.work_id === work.id &&
        failure.worker_id === worker.id &&
        failure.confirmed === true &&
        failure.attribution === 'model',
    ),
  );

function meetsDimensions(profile, work) {
  return work.dimensions.every((key) => {
    const dimension = profile.dimensions?.[key];
    return (
      Number.isFinite(dimension?.score) &&
      dimension.score >= work.minimum_score &&
      dimension.score <= 10 &&
      dimension.support === SUPPORTED_EVIDENCE
    );
  });
}

// A profile only qualifies the exact route, effort, evidence kind and task context it observed.
function findProfile(work, worker, brief, skill) {
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

const hasKnownCostAndTime = (profile) =>
  isNonNegative(profile.observed_cost_usd) &&
  isNonNegative(profile.observed_wall_seconds) &&
  profile.observed_wall_seconds > 0;

function fit(work, worker, brief) {
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
    worker_id: worker.id,
    context_key: worker.context_id ?? worker.id,
    context_bound: worker.context_id !== undefined,
    model_id: worker.model_id,
    route: worker.route,
    effort: worker.effort ?? 'unknown',
    cost: maxOf(profiles.map((profile) => profile.observed_cost_usd)),
    seconds: maxOf(profiles.map((profile) => profile.observed_wall_seconds)),
  };
}

// ---------------------------------------------------------------------------
// Pool-independent preparation

function validateWorkers(workers) {
  check(Array.isArray(workers) && workers.length > 0, 'Supply permitted execution routes');
  requireUniqueTexts(
    workers.map((worker) => worker.id),
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

function planningLimits(brief) {
  const declared = brief.planning_limits ?? {};
  const limits = {
    max_parallel: DEFAULT_PARALLEL_CAP,
    parallel_cost_premium: DEFAULT_PARALLEL_PREMIUM,
    overhead_seconds: 0,
    overhead_cost_usd: 0,
    context_startup_seconds: 0,
    context_startup_cost_usd: 0,
    ...declared,
  };
  limits.max_workers ??= limits.max_parallel;
  check(
    Number.isInteger(limits.max_parallel) && limits.max_parallel > 0,
    'Invalid concurrency limit',
  );
  check(
    Number.isInteger(limits.max_workers) && limits.max_workers > 0,
    'Invalid execution pool limit',
  );
  for (const key of OVERHEAD_KEYS) {
    check(isNonNegative(limits[key]), 'Invalid planning overhead or premium');
  }
  if (limits.budget_usd !== undefined) {
    check(isNonNegative(limits.budget_usd), 'Invalid estimated budget');
  }
  if (limits.deadline_seconds !== undefined) {
    check(isNonNegative(limits.deadline_seconds), 'Invalid estimated deadline');
  }
  // Defaults of zero are placeholders. Only declared overheads count toward complete estimates.
  const knownStartupCost = Object.hasOwn(declared, 'context_startup_cost_usd');
  const knownStartupTime = Object.hasOwn(declared, 'context_startup_seconds');
  const known = {
    startupCost: knownStartupCost,
    startupTime: knownStartupTime,
    cost: Object.hasOwn(declared, 'overhead_cost_usd') && knownStartupCost,
    time: Object.hasOwn(declared, 'overhead_seconds') && knownStartupTime,
  };
  return { limits, known };
}

const unplanned = (fields) => ({
  ...fields,
  assignments: fields.assignments ?? [],
  organization: [],
  automatic_execution: false,
});

// Everything that does not depend on the pool cap: validation, route fit, DEI reservations,
// minimum costs and critical-path tails. Computed once and shared by every pool alternative.
function prepareRouting(brief, workers, dei) {
  validateTriageForBrief(brief);
  const graph = validateWorkGraph(brief);
  validateWorkers(workers);
  const { limits, known } = planningLimits(brief);
  const reasons = new Map();
  const matches = new Map();
  const exclusions = [];
  for (const work of graph.items) {
    const byWorker = new Map();
    const eligible = [];
    for (const worker of workers) {
      const outsideRoster = dei.enabled && !dei.model_ids.includes(worker.model_id);
      const result = outsideRoster
        ? { reason: 'outside-selected-dei-roster' }
        : fit(work, worker, brief);
      byWorker.set(worker.id, result.reason ?? null);
      if (result.reason)
        exclusions.push({ work_id: work.id, worker_id: worker.id, reason: result.reason });
      else eligible.push(result);
    }
    reasons.set(work.id, byWorker);
    matches.set(work.id, eligible);
  }
  const routing = { brief, graph, limits, known, reasons, matches, exclusions };
  const needsOverheads =
    (limits.budget_usd !== undefined && !known.cost) ||
    (limits.deadline_seconds !== undefined && !known.time);
  if (needsOverheads) {
    routing.outcome = unplanned({
      status: 'needs-evidence',
      reason: 'measure-or-explicitly-estimate-handoff-review-and-context-startup',
    });
    return routing;
  }
  const coverage = reserveDeiWork(dei, graph, matches);
  if (coverage.missing.length) {
    routing.outcome = unplanned({
      status: 'constraints-unmet',
      reason: 'dei-coverage-unresolved',
      missing_model_ids: coverage.missing,
      exclusions,
    });
    return routing;
  }
  for (const [id, model] of coverage.reservations) {
    matches.set(
      id,
      matches.get(id).filter((candidate) => candidate.model_id === model),
    );
  }
  const unproven = graph.items
    .filter((work) => !matches.get(work.id).length)
    .map((work) => work.id);
  if (unproven.length) {
    routing.outcome = unplanned({ status: 'needs-evidence', unassigned: unproven, exclusions });
    return routing;
  }
  routing.minimumSeconds = new Map(
    graph.items.map((work) => [work.id, minOf(matches.get(work.id).map((item) => item.seconds))]),
  );
  routing.minimumCost = new Map(
    graph.items.map((work) => [
      work.id,
      minOf(matches.get(work.id).map((item) => item.cost)) + limits.overhead_cost_usd,
    ]),
  );
  routing.tails = criticalTails(graph, routing.minimumSeconds, limits.overhead_seconds);
  return routing;
}

// Longest remaining path from each work item to the terminal, using the fastest eligible route.
function criticalTails(graph, minimumSeconds, overheadSeconds) {
  const children = new Map(graph.items.map((work) => [work.id, []]));
  for (const work of graph.items) for (const id of work.depends_on) children.get(id).push(work.id);
  const tails = new Map();
  for (const id of [...graph.order].reverse()) {
    const own = minimumSeconds.get(id) + overheadSeconds;
    tails.set(id, own + maxOf([0, ...children.get(id).map((child) => tails.get(child))]));
  }
  return tails;
}

// ---------------------------------------------------------------------------
// Scheduling for one pool cap

function earliestSlot(work, contextKey, duration, dependencyEnd, assignments, maxParallel) {
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
    const activeAt = (point) =>
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

function readyOrder(routing, pending) {
  const { graph, matches, tails } = routing;
  return graph.items
    .filter((work) => pending.has(work.id) && work.depends_on.every((id) => !pending.has(id)))
    .sort(
      (a, b) =>
        matches.get(a.id).length - matches.get(b.id).length ||
        DIFFICULTY_RANK[b.difficulty] - DIFFICULTY_RANK[a.difficulty] ||
        tails.get(b.id) - tails.get(a.id),
    );
}

function chooseRoute(candidates, limits, tailAfter) {
  const onTime = candidates.filter(
    (item) =>
      limits.deadline_seconds === undefined || item.end + tailAfter <= limits.deadline_seconds,
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

function scheduleForPool(routing, maxWorkers) {
  const { brief, graph, known, matches, exclusions, minimumCost, minimumSeconds, tails } = routing;
  const limits = { ...routing.limits, max_workers: maxWorkers };
  const assignments = [];
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
      for (const id of pending) if (id !== work.id) reserve += minimumCost.get(id);
      const usedContexts = new Set(assignments.map((item) => item.context_key));
      const auditedContexts = new Set(
        assignments
          .filter((item) => work.audit_sources.includes(item.work_id))
          .map((item) => item.context_key),
      );
      const supervisor = work.supervisor_context ?? brief.lead_context ?? null;
      const allowed = (item) =>
        !auditedContexts.has(item.context_key) &&
        !assignments.some(
          (prior) =>
            prior.context_key === item.context_key && prior.supervisor_context !== supervisor,
        ) &&
        (usedContexts.has(item.context_key) || usedContexts.size < limits.max_workers);
      const candidates = matches
        .get(work.id)
        .filter(allowed)
        .map((item) => {
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
          (item) =>
            limits.budget_usd === undefined ||
            totalCost + item.cost + reserve <= limits.budget_usd + EPSILON,
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
      const tailAfter = tails.get(work.id) - minimumSeconds.get(work.id) - limits.overhead_seconds;
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
      });
      pending.delete(work.id);
    }
  }
  return summarizePlan(routing, limits, assignments, totalCost);
}

function summarizePlan(routing, limits, assignments, totalCost) {
  const { brief, graph, known, exclusions, minimumSeconds } = routing;
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
  const activeAt = (time) =>
    assignments.filter((other) => other.start_seconds <= time && other.end_seconds > time).length;
  const cost = roundUsd(totalCost);
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
      .filter((work) => minimumSeconds.get(work.id) <= limits.overhead_seconds)
      .map((work) => ({
        work_id: work.id,
        reason: 'handoff-overhead-at-least-work-time; consider merging tightly coupled work',
      })),
    method:
      'Greedy adequate-route planning with a bounded parallelism premium and cheapest-remaining budget reserve; not a global optimum proof.',
    estimate_basis:
      'Comparable supported local task observations plus declared overhead; not a guaranteed future duration or bill.',
    automatic_execution: false,
  };
}

// ---------------------------------------------------------------------------
// Pool comparison

function poolCaps(bound) {
  if (bound <= 8) return Array.from({ length: bound }, (_, index) => index + 1);
  const powers = Array.from(
    { length: Math.ceil(Math.log2(bound)) },
    (_, index) => 2 ** (index + 3),
  );
  return [...new Set([1, 2, 3, 4, ...powers.filter((value) => value < bound), bound])];
}

function attachRoutingAudit(plan, routing, workers, dei) {
  const routing_audit = {
    scope: 'supplied-permitted-route-inventory',
    family_filter_applied: false,
    boundary:
      'Model families are optional declared labels, not inferred identities. Only supplied routes are considered; this does not discover or connect other providers.',
    work: routing.graph.items.map((item) => ({
      work_id: item.id,
      candidates: workers.map((worker) => {
        const reason = routing.reasons.get(item.id).get(worker.id);
        const selected = plan.assignments.some(
          (assignment) => assignment.work_id === item.id && assignment.worker_id === worker.id,
        );
        let outcome = 'eligible-not-selected';
        if (selected) outcome = 'selected';
        else if (reason) outcome = 'excluded';
        return {
          worker_id: worker.id,
          model_id: worker.model_id,
          model_family: worker.model_family ?? null,
          route: worker.route,
          outcome,
          reason: selected
            ? 'bounded-ability-cost-time-and-policy-plan'
            : (reason ?? 'adequate-alternative-not-selected-by-bounded-plan'),
        };
      }),
    })),
  };
  const audited = { ...plan, routing_audit };
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

// Prefer the smallest adequate pool; take a larger one only when it saves more than the
// configured time and stays within the whole-task cost premium of the cheapest feasible plan.
function selectAlternative(feasible, brief, saving) {
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

export function planWork(brief, workers) {
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
  const routing = prepareRouting(
    { ...brief, planning_limits: { ...brief.planning_limits, max_workers: requested } },
    workers,
    dei,
  );
  const withAudit = (plan) => attachRoutingAudit(plan, routing, workers, dei);
  if (routing.outcome) return withAudit(routing.outcome);
  const alternatives = poolCaps(bound).map((cap) => ({
    pool_cap: cap,
    plan: scheduleForPool(routing, cap),
  }));
  const feasible = alternatives.filter((item) => item.plan.status === 'planned');
  if (!feasible.length) return withAudit(alternatives.at(-1).plan);
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
        estimated_cost_usd: plan.estimated_cost_usd ?? null,
        estimated_makespan_seconds: plan.estimated_makespan_seconds ?? null,
      })),
      basis:
        'Bounded greedy pool alternatives; prefer fewer adequate contexts unless extra capacity produces useful estimated time savings within the total cost premium. Unknown startup remains excluded from complete estimates. This is not a global optimum or measured saving.',
    },
  });
}
