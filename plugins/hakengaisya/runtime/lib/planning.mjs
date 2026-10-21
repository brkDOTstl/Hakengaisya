import { normalizeDei, reserveDeiWork } from './participation.mjs';
import { assertRegisteredSupervisor, createSupervision } from './supervision.mjs';
import { validateTriageForBrief } from './triage.mjs';

const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const text = (value, name) =>
  assert(typeof value === 'string' && value.trim(), `${name} must be nonempty text`);
const unique = (values, name) => {
  assert(
    Array.isArray(values) && new Set(values).size === values.length,
    `${name} must be a unique array`,
  );
  values.forEach((value) => text(value, name));
  return values;
};
const rank = { routine: 0, standard: 1, complex: 2 };
const finite = (value) => Number.isFinite(value) && value >= 0;

export function normalizeWrites(values) {
  return unique(values, 'Write scope').map((value) => {
    const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
    assert(
      normalized &&
        !/^(?:\/|[A-Za-z]:)/.test(normalized) &&
        !normalized.split('/').some((part) => !part || part === '.' || part === '..') &&
        !/[?*]/.test(normalized),
      'Declare exact workspace-relative write paths',
    );
    return normalized;
  });
}
export const scopesConflict = (left, right) =>
  left.some((a) =>
    right.some((b) => {
      a = a.toLowerCase();
      b = b.toLowerCase();
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    }),
  );

export function validateWorkGraph(brief) {
  normalizeDei(brief.dei);
  text(brief.objective, 'Objective');
  assert(
    ['software-engineering', 'technical-product-design'].includes(brief.domain),
    'Only technical domains are active',
  );
  assert(
    Array.isArray(brief.work_items) && brief.work_items.length > 0,
    'Supply deliverable work items before creating an organization',
  );
  const supervision = brief.lead_context
    ? createSupervision(brief.lead_context, brief.reporting_lines)
    : null;
  assert(
    supervision ||
      (brief.reporting_lines === undefined &&
        !brief.work_items.some((item) => item.supervisor_context !== undefined)),
    'Explicit supervision needs a root lead context',
  );
  const items = brief.work_items.map((item) => {
    assert(/^[a-z][a-z0-9_-]*$/.test(item.id), 'Invalid work identifier');
    text(item.objective, 'Work objective');
    text(item.task_type, 'Task type');
    assert(Object.hasOwn(rank, item.difficulty), 'Each work item needs its own difficulty');
    unique(item.skills, 'Skills');
    assert(item.skills.length > 0, 'Each work item needs a skill');
    unique(item.depends_on, 'Dependencies');
    unique(item.outputs, 'Outputs');
    unique(item.acceptance, 'Work acceptance');
    assert(
      item.outputs.length > 0 && item.acceptance.length > 0,
      'Each work item needs a deliverable and observable acceptance',
    );
    unique(item.inputs ?? [], 'Inputs');
    unique(item.audit_sources ?? [], 'Audited work');
    unique(item.required_tools ?? [], 'Required tools');
    const minimum = item.minimum_score ?? 7;
    assert(Number.isFinite(minimum) && minimum >= 0 && minimum <= 10, 'Invalid ability threshold');
    const dimensions = unique(item.dimensions ?? ['D1', 'D2', 'D6'], 'Required dimensions');
    if (supervision)
      assertRegisteredSupervisor(supervision, item.supervisor_context ?? brief.lead_context);
    assert(
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
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  assert(byId.size === items.length, 'Duplicate work identifier');
  const outputs = new Map();
  for (const item of items) {
    assert(
      item.depends_on.every((id) => byId.has(id) && id !== item.id),
      'Unknown or self dependency',
    );
    for (const output of item.outputs) {
      assert(!outputs.has(output), 'Artifact needs one accountable producer');
      outputs.set(output, item.id);
    }
  }
  const order = [];
  const done = new Set();
  const ancestors = new Map();
  while (done.size < items.length) {
    const ready = items.filter(
      (item) => !done.has(item.id) && item.depends_on.every((id) => done.has(id)),
    );
    assert(ready.length, 'Cyclic work dependencies');
    for (const item of ready) {
      const prior = new Set(item.depends_on.flatMap((id) => [id, ...ancestors.get(id)]));
      assert(
        item.audit_sources.every((id) => prior.has(id)),
        'Independent audit must depend on the audited work',
      );
      const external = new Set([
        'task_brief',
        'constraints',
        'existing_assets',
        ...Object.keys(brief.external_inputs ?? {}),
      ]);
      assert(
        item.inputs.every((input) => external.has(input) || prior.has(outputs.get(input))),
        'Input artifact must come from an accepted dependency or declared external input',
      );
      ancestors.set(item.id, prior);
      done.add(item.id);
      order.push(item.id);
    }
  }
  const referenced = new Set(items.flatMap((item) => item.depends_on));
  const terminals = items.filter((item) => !referenced.has(item.id));
  assert(
    terminals.length === 1,
    'Supply one integrated terminal deliverable instead of a disconnected department chart',
  );
  if (supervision)
    assert(
      (terminals[0].supervisor_context ?? brief.lead_context) === brief.lead_context,
      'The terminal delivery must report to the root supervisor',
    );
  return { items, order, terminal: terminals[0].id };
}

function fit(work, worker, brief) {
  if (worker.available !== true) return { reason: 'route-unavailable' };
  if (brief.lead_context && worker.context_id !== undefined) {
    const supervisor = work.supervisor_context ?? brief.lead_context;
    const parent = brief.reporting_lines?.find(
      (line) => line.subordinate_context === worker.context_id,
    )?.supervisor_context;
    if (
      worker.context_id === brief.lead_context ||
      worker.context_id === supervisor ||
      (parent !== undefined && parent !== supervisor)
    )
      return { reason: 'reporting-line-incompatible' };
  }
  if (
    work.required_tools.length &&
    (worker.tools_verified !== true ||
      !work.required_tools.every((tool) => worker.tools?.includes(tool)))
  )
    return { reason: 'required-tool-unavailable' };
  if (
    brief.failures?.some(
      (failure) =>
        failure.work_id === work.id &&
        failure.worker_id === worker.id &&
        failure.confirmed === true &&
        failure.attribution === 'model',
    )
  )
    return { reason: 'confirmed-failure-needs-reassignment' };
  const kind = brief.evidence_kind ?? 'local_work';
  const domain = brief.domain === 'technical-product-design' ? 'technical-product' : brief.domain;
  const profiles = work.skills.map((skill) =>
    (worker.profiles ?? []).find(
      (profile) =>
        profile.model_id === worker.model_id &&
        profile.route === worker.route &&
        profile.effort === (worker.effort ?? 'unknown') &&
        profile.evaluation_kind === kind &&
        profile.domain === domain &&
        profile.task_type === work.task_type &&
        profile.difficulty === work.difficulty &&
        profile.skill === skill &&
        work.dimensions.every(
          (key) =>
            Number.isFinite(profile.dimensions?.[key]?.score) &&
            profile.dimensions[key].score >= work.minimum_score &&
            profile.dimensions[key].score <= 10 &&
            profile.dimensions[key].support === 'supported-peer-observations',
        ),
    ),
  );
  if (profiles.some((profile) => !profile)) return { reason: 'ability-or-context-unproven' };
  if (
    !profiles.every(
      (profile) =>
        finite(profile.observed_cost_usd) &&
        finite(profile.observed_wall_seconds) &&
        profile.observed_wall_seconds > 0,
    )
  )
    return { reason: 'cost-or-time-unknown' };
  return {
    worker_id: worker.id,
    context_key: worker.context_id ?? worker.id,
    context_bound: worker.context_id !== undefined,
    model_id: worker.model_id,
    route: worker.route,
    effort: worker.effort ?? 'unknown',
    cost: Math.max(...profiles.map((profile) => profile.observed_cost_usd)),
    seconds: Math.max(...profiles.map((profile) => profile.observed_wall_seconds)),
  };
}

function earliestSlot(work, contextKey, duration, dependencyEnd, assignments, maxParallel) {
  let start = Math.max(
    dependencyEnd,
    ...assignments
      .filter((item) => item.context_key === contextKey)
      .map((item) => item.end_seconds),
    0,
  );
  for (let step = 0; step <= assignments.length * 2 + 1; step++) {
    const overlapping = assignments.filter(
      (item) => item.start_seconds < start + duration && item.end_seconds > start,
    );
    const conflicts = overlapping.filter((item) => scopesConflict(work.writes, item.writes));
    if (conflicts.length) {
      start = Math.max(...conflicts.map((item) => item.end_seconds));
      continue;
    }
    const points = [
      ...new Set([
        start,
        ...overlapping.map((item) => item.start_seconds).filter((value) => value > start),
      ]),
    ].sort((a, b) => a - b);
    const full = points.find(
      (point) =>
        overlapping.filter((item) => item.start_seconds <= point && item.end_seconds > point)
          .length >= maxParallel,
    );
    if (full !== undefined) {
      start = Math.min(
        ...overlapping
          .filter((item) => item.start_seconds <= full && item.end_seconds > full)
          .map((item) => item.end_seconds),
      );
      continue;
    }
    return start;
  }
  throw new Error('Unable to find bounded schedule slot');
}

function planForPool(brief, workers) {
  validateTriageForBrief(brief);
  const graph = validateWorkGraph(brief);
  assert(Array.isArray(workers) && workers.length > 0, 'Supply permitted execution routes');
  unique(
    workers.map((worker) => worker.id),
    'Worker identifiers',
  );
  workers.forEach((worker) => {
    text(worker.model_id, 'Model label');
    text(worker.route, 'Route');
  });
  workers.forEach((worker) => {
    if (worker.model_family !== undefined) text(worker.model_family, 'Declared model family');
  });
  const dei = normalizeDei(brief.dei);
  const limits = {
    max_parallel: 3,
    parallel_cost_premium: 0.1,
    overhead_seconds: 0,
    overhead_cost_usd: 0,
    context_startup_seconds: 0,
    context_startup_cost_usd: 0,
    ...brief.planning_limits,
  };
  limits.max_workers ??= limits.max_parallel;
  assert(
    Number.isInteger(limits.max_parallel) && limits.max_parallel > 0,
    'Invalid concurrency limit',
  );
  assert(
    Number.isInteger(limits.max_workers) && limits.max_workers > 0,
    'Invalid execution pool limit',
  );
  [
    'parallel_cost_premium',
    'overhead_seconds',
    'overhead_cost_usd',
    'context_startup_seconds',
    'context_startup_cost_usd',
  ].forEach((key) => assert(finite(limits[key]), 'Invalid planning overhead or premium'));
  if (limits.budget_usd !== undefined)
    assert(finite(limits.budget_usd), 'Invalid estimated budget');
  if (limits.deadline_seconds !== undefined)
    assert(finite(limits.deadline_seconds), 'Invalid estimated deadline');
  const knownStartupCost = Object.hasOwn(brief.planning_limits ?? {}, 'context_startup_cost_usd');
  const knownStartupTime = Object.hasOwn(brief.planning_limits ?? {}, 'context_startup_seconds');
  const knownCostOverhead =
    Object.hasOwn(brief.planning_limits ?? {}, 'overhead_cost_usd') && knownStartupCost;
  const knownTimeOverhead =
    Object.hasOwn(brief.planning_limits ?? {}, 'overhead_seconds') && knownStartupTime;
  if (
    (limits.budget_usd !== undefined && !knownCostOverhead) ||
    (limits.deadline_seconds !== undefined && !knownTimeOverhead)
  )
    return {
      status: 'needs-evidence',
      reason: 'measure-or-explicitly-estimate-handoff-review-and-context-startup',
      assignments: [],
      organization: [],
      automatic_execution: false,
    };
  const matches = new Map();
  const exclusions = [];
  for (const work of graph.items) {
    const eligible = [];
    for (const worker of workers) {
      if (dei.enabled && !dei.model_ids.includes(worker.model_id)) {
        exclusions.push({
          work_id: work.id,
          worker_id: worker.id,
          reason: 'outside-selected-dei-roster',
        });
        continue;
      }
      const result = fit(work, worker, brief);
      if (result.reason)
        exclusions.push({ work_id: work.id, worker_id: worker.id, reason: result.reason });
      else eligible.push(result);
    }
    matches.set(work.id, eligible);
  }
  const coverage = reserveDeiWork(dei, graph, matches);
  if (coverage.missing.length)
    return {
      status: 'constraints-unmet',
      reason: 'dei-coverage-unresolved',
      missing_model_ids: coverage.missing,
      assignments: [],
      organization: [],
      exclusions,
      automatic_execution: false,
    };
  for (const [id, model] of coverage.reservations)
    matches.set(
      id,
      matches.get(id).filter((candidate) => candidate.model_id === model),
    );
  const unproven = graph.items
    .filter((work) => !matches.get(work.id).length)
    .map((work) => work.id);
  if (unproven.length)
    return {
      status: 'needs-evidence',
      unassigned: unproven,
      exclusions,
      assignments: [],
      organization: [],
      automatic_execution: false,
    };
  const minimumCost = (id) =>
    Math.min(...matches.get(id).map((item) => item.cost)) + limits.overhead_cost_usd;
  const tails = new Map();
  for (const id of [...graph.order].reverse()) {
    const own = Math.min(...matches.get(id).map((item) => item.seconds)) + limits.overhead_seconds;
    const children = graph.items.filter((work) => work.depends_on.includes(id));
    tails.set(id, own + Math.max(0, ...children.map((work) => tails.get(work.id))));
  }
  const assignments = [];
  const pending = new Set(graph.order);
  let totalCost = 0;
  while (pending.size) {
    const ready = graph.items
      .filter((work) => pending.has(work.id) && work.depends_on.every((id) => !pending.has(id)))
      .sort(
        (a, b) =>
          matches.get(a.id).length - matches.get(b.id).length ||
          rank[b.difficulty] - rank[a.difficulty] ||
          tails.get(b.id) - tails.get(a.id),
      );
    assert(ready.length, 'No ready work');
    for (const work of ready) {
      const prior = assignments.filter((item) => work.depends_on.includes(item.work_id));
      const dependencyEnd = Math.max(0, ...prior.map((item) => item.end_seconds));
      const reserve = [...pending]
        .filter((id) => id !== work.id)
        .reduce((sum, id) => sum + minimumCost(id), 0);
      const usedContexts = new Set(assignments.map((item) => item.context_key));
      const auditedWorkers = new Set(
        assignments
          .filter((item) => work.audit_sources.includes(item.work_id))
          .map((item) => item.context_key),
      );
      const supervisor = work.supervisor_context ?? brief.lead_context ?? null;
      let candidates = matches
        .get(work.id)
        .filter(
          (item) =>
            !auditedWorkers.has(item.context_key) &&
            !assignments.some(
              (prior) =>
                prior.context_key === item.context_key && prior.supervisor_context !== supervisor,
            ) &&
            (usedContexts.has(item.context_key) || usedContexts.size < limits.max_workers),
        )
        .map((item) => {
          const startup = usedContexts.has(item.context_key) ? 0 : limits.context_startup_seconds;
          const startupCost = usedContexts.has(item.context_key)
            ? 0
            : limits.context_startup_cost_usd;
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
            totalCost + item.cost + reserve <= limits.budget_usd + 1e-9,
        );
      if (!candidates.length)
        return {
          status: 'constraints-unmet',
          reason: auditedWorkers.size ? 'independence-pool-or-budget' : 'pool-or-estimated-budget',
          unassigned: [...pending],
          assignments,
          exclusions,
          automatic_execution: false,
        };
      const tailAfter =
        tails.get(work.id) -
        Math.min(...matches.get(work.id).map((item) => item.seconds)) -
        limits.overhead_seconds;
      const onTime = candidates.filter(
        (item) =>
          limits.deadline_seconds === undefined || item.end + tailAfter <= limits.deadline_seconds,
      );
      if (onTime.length) candidates = onTime;
      const cheapest = Math.min(...candidates.map((item) => item.cost));
      const boundedPremium = candidates.filter(
        (item) => item.cost <= cheapest * (1 + limits.parallel_cost_premium) + 1e-9,
      );
      boundedPremium.sort(
        (a, b) => a.end - b.end || a.cost - b.cost || a.worker_id.localeCompare(b.worker_id),
      );
      const choice = boundedPremium[0];
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
        estimated_cost_usd: choice.cost,
        context_startup_seconds: knownStartupTime ? choice.startup : null,
        context_startup_cost_usd: knownStartupCost ? choice.startupCost : null,
      });
      pending.delete(work.id);
    }
  }
  const duration = Math.max(...assignments.map((item) => item.end_seconds));
  const organization = [...new Set(assignments.map((item) => item.context_key))].map((key) => ({
    context_key: key,
    route_ids: [
      ...new Set(
        assignments.filter((item) => item.context_key === key).map((item) => item.worker_id),
      ),
    ],
    work: assignments.filter((item) => item.context_key === key).map((item) => item.work_id),
  }));
  return {
    status:
      limits.deadline_seconds !== undefined && duration > limits.deadline_seconds
        ? 'constraints-unmet'
        : 'planned',
    reason:
      limits.deadline_seconds !== undefined && duration > limits.deadline_seconds
        ? 'estimated-deadline'
        : null,
    evidence_kind: brief.evidence_kind ?? 'local_work',
    assignments,
    organization,
    exclusions,
    estimated_cost_usd: knownCostOverhead ? totalCost : null,
    estimated_makespan_seconds: knownTimeOverhead ? duration : null,
    known_components_cost_usd: totalCost,
    known_components_schedule_seconds: duration,
    overheads_accounted: {
      cost: knownCostOverhead,
      time: knownTimeOverhead,
      context_startup_cost: knownStartupCost,
      context_startup_time: knownStartupTime,
    },
    peak_parallel: Math.max(
      ...assignments.map(
        (item) =>
          assignments.filter(
            (other) =>
              other.start_seconds <= item.start_seconds && other.end_seconds > item.start_seconds,
          ).length,
      ),
    ),
    serial_estimate_seconds: assignments.reduce(
      (sum, item) => sum + item.end_seconds - item.start_seconds,
      0,
    ),
    decomposition_warnings: graph.items
      .filter(
        (work) =>
          Math.min(...matches.get(work.id).map((item) => item.seconds)) <= limits.overhead_seconds,
      )
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

export function planWork(brief, workers) {
  const dei = normalizeDei(brief.dei);
  const requested = brief.planning_limits?.max_workers ?? brief.planning_limits?.max_parallel ?? 3;
  assert(Number.isInteger(requested) && requested > 0, 'Invalid execution pool limit');
  const saving = brief.planning_limits?.minimum_parallel_savings_seconds ?? 0;
  assert(finite(saving), 'Invalid minimum parallel savings');
  const bound = Math.min(
    requested,
    Array.isArray(workers)
      ? new Set(workers.map((worker) => worker.context_id ?? worker.id)).size || 1
      : 1,
  );
  const caps =
    bound <= 8
      ? Array.from({ length: bound }, (_, index) => index + 1)
      : [
          ...new Set([
            1,
            2,
            3,
            4,
            ...Array.from(
              { length: Math.ceil(Math.log2(bound)) },
              (_, index) => 2 ** (index + 3),
            ).filter((value) => value < bound),
            bound,
          ]),
        ];
  const alternatives = caps.map((max_workers) => ({
    pool_cap: max_workers,
    plan: planForPool(
      { ...brief, planning_limits: { ...brief.planning_limits, max_workers } },
      workers,
    ),
  }));
  const feasible = alternatives.filter((item) => item.plan.status === 'planned');
  const withAudit = (plan) => {
    const work = validateWorkGraph(brief).items;
    const routing_audit = {
      scope: 'supplied-permitted-route-inventory',
      family_filter_applied: false,
      boundary:
        'Model families are optional declared labels, not inferred identities. Only supplied routes are considered; this does not discover or connect other providers.',
      work: work.map((item) => ({
        work_id: item.id,
        candidates: workers.map((worker) => {
          const reason =
            dei.enabled && !dei.model_ids.includes(worker.model_id)
              ? 'outside-selected-dei-roster'
              : fit(item, worker, brief).reason;
          const selected = plan.assignments.some(
            (assignment) => assignment.work_id === item.id && assignment.worker_id === worker.id,
          );
          return {
            worker_id: worker.id,
            model_id: worker.model_id,
            model_family: worker.model_family ?? null,
            route: worker.route,
            outcome: selected ? 'selected' : reason ? 'excluded' : 'eligible-not-selected',
            reason: selected
              ? 'bounded-ability-cost-time-and-policy-plan'
              : (reason ?? 'adequate-alternative-not-selected-by-bounded-plan'),
          };
        }),
      })),
    };
    return {
      ...plan,
      routing_audit,
      ...(dei.enabled
        ? {
            dei: {
              ...dei,
              assigned_model_ids: [...new Set(plan.assignments.map((item) => item.model_id))],
              missing_model_ids: dei.model_ids.filter(
                (model) => !plan.assignments.some((item) => item.model_id === model),
              ),
            },
          }
        : {}),
    };
  };
  if (!feasible.length) return withAudit(alternatives.at(-1).plan);
  const cheapest = Math.min(...feasible.map((item) => item.plan.known_components_cost_usd));
  const allowed = feasible.filter(
    (item) =>
      item.plan.known_components_cost_usd <=
      cheapest * (1 + (brief.planning_limits?.parallel_cost_premium ?? 0.1)) + 1e-9,
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
    if (gain > saving + 1e-9) selected = candidate;
  }
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
