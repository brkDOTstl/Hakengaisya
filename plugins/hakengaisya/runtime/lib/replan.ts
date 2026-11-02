import { createHash } from 'node:crypto';
import {
  externalTrials,
  type IntegratedPlan,
  type IntegrationInput,
  prepareIntegratedPlan,
} from './integrated.ts';
import { type PlannedAssignment, planWork, type ScheduledPlan } from './planning.ts';
import type {
  BriefInput,
  Packet,
  ReplanApproval,
  ReplanEvent,
  Run,
  WorkItemInput,
} from './types.ts';
import { check, isRecord, isText } from './validate.ts';
import { createRun } from './workflow.ts';

export interface ObservedProgress {
  kind: 'observed';
  evidence_reference: string;
  spent_cost_usd?: number;
  elapsed_seconds?: number;
}

export interface ReplanRequest {
  expected_revision: number;
  integration: Omit<IntegrationInput, 'brief'>;
  progress?: ObservedProgress;
}

export interface ReplanProposal {
  proposal_hash: string;
  expected_revision: number;
  state_hash: string;
  original_brief_hash: string;
  remaining_brief: BriefInput;
  prepared: IntegratedPlan;
  progress?: ObservedProgress;
}

export type ReplanPreparation =
  | { status: 'prepared'; proposal: ReplanProposal }
  | {
      status: 'needs-evidence' | 'constraints-unmet' | 'no-change';
      reason: string;
      prepared?: IntegratedPlan;
    };

export interface ReplanAdoption {
  actor_context: string;
  reason: string;
  approvals: ReplanApproval[];
}

export type ReplanResult =
  | { status: 'adopted'; run: Run; event: ReplanEvent; changed_work_ids: string[] }
  | { status: 'needs-evidence' | 'constraints-unmet' | 'no-change'; reason: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const validNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const active = (packet: Packet) => ['running', 'in_review', 'blocked'].includes(packet.status);
const identity = (item: PlannedAssignment) => [
  item.worker_id,
  item.context_key,
  item.context_bound,
  item.model_id,
  item.route,
  item.effort,
];

function startedTrials(run: Run): number {
  const first = run.journal.find((entry) => entry.event.type === 'replan');
  let plan = first?.event.type === 'replan' ? first.event.plan_before : run.dispatch_plan;
  let count = 0;
  for (const entry of run.journal) {
    if (entry.event.type === 'replan') plan = entry.event.plan_after;
    if (entry.event.type !== 'start') continue;
    const work = run.packets[entry.event.packet_id]?.source_work_id;
    const selected = plan?.assignments.find((item) => item.work_id === work);
    if (selected?.qualification === 'trial') count++;
  }
  return count;
}

function checkTrialCap(run: Run, original: BriefInput, plan: ScheduledPlan): void {
  const cap = original.planning_limits?.max_trial_assignments;
  if (cap === undefined) return;
  const proposed = plan.assignments.filter((item) => item.qualification === 'trial').length;
  check(
    startedTrials(run) + proposed <= cap,
    'Fresh trial assignments exceed the original cumulative ceiling',
  );
}

function originalBrief(run: Run): BriefInput {
  const value = run.external_inputs?.integrated_original_brief;
  check(
    isRecord(value) && Array.isArray(value.work_items),
    'A stored integrated original brief is required',
  );
  const brief = structuredClone(value) as unknown as BriefInput;
  check(
    !brief.workers && !brief.planning_limits?.sourced_trials,
    'Original brief cannot contain a generated worker catalog or sourced trials',
  );
  const baseline = createRun(null, brief);
  for (const field of [
    'run_id',
    'objective',
    'domain',
    'lead_context',
    'evidence_kind',
    'acceptance',
    'constraints',
  ] as const)
    check(equal(run[field], baseline[field]), `Run ${field} differs from its original contract`);
  check(
    run.schema_version === 2 && run.template_id === 'task-graph' && run.supervision,
    'Replanning needs an integrated supervised task graph',
  );
  check(
    equal(Object.keys(run.packets).sort(), Object.keys(baseline.packets).sort()),
    'Run packets differ from their original contract',
  );
  const fields: Array<keyof Packet> = [
    'id',
    'source_work_id',
    'objective',
    'task_type',
    'difficulty',
    'skills',
    'required_tools',
    'supervisor_context',
    'depends_on',
    'inputs',
    'required_outputs',
    'checks',
    'rework_to',
    'audit_sources',
    'declared_writes',
  ];
  for (const [id, expected] of Object.entries(baseline.packets)) {
    const actual = run.packets[id];
    for (const field of fields)
      check(
        equal(actual[field], expected[field]),
        `Packet ${id} ${field} differs from its original contract`,
      );
  }
  for (const [key, expected] of Object.entries(brief.external_inputs ?? {}))
    check(
      Object.hasOwn(run.external_inputs, key) && equal(run.external_inputs[key], expected),
      `External input ${key} differs from its original contract`,
    );
  check(
    equal(run.dei, baseline.dei) && equal(run.improvement, baseline.improvement),
    'Run policy differs from its original contract',
  );
  for (const field of ['budget_usd', 'deadline_seconds'] as const)
    check(
      equal(run.planning_limits?.[field], brief.planning_limits?.[field]),
      `Run ${field} differs from its original contract`,
    );
  for (const field of ['max_attempts', 'max_dispatches'] as const)
    if (brief.limits?.[field] !== undefined)
      check(
        run.limits[field] === brief.limits[field],
        `Run ${field} differs from its original contract`,
      );
  if (brief.limits?.max_parallel !== undefined)
    check(
      run.limits.max_parallel <= brief.limits.max_parallel,
      'Run parallel capacity exceeds its original contract',
    );
  check(run.supervision.root_context === brief.lead_context, 'Supervision root changed');
  for (const line of brief.reporting_lines ?? [])
    check(
      run.supervision.reporting_lines.some((item) => equal(item, line)),
      'An original reporting line changed',
    );
  return brief;
}

function packetMap(run: Run): Map<string, Packet> {
  const result = new Map<string, Packet>();
  for (const packet of Object.values(run.packets)) {
    check(
      isText(packet.source_work_id) && !result.has(packet.source_work_id),
      'Each work item needs one actual packet',
    );
    result.set(packet.source_work_id, packet);
  }
  return result;
}

function remainingBrief(run: Run, original: BriefInput, progress?: ObservedProgress): BriefInput {
  check(
    !Object.values(run.packets).some(active),
    'Active, reviewing or blocked execution prevents replanning',
  );
  check(run.dispatch_plan?.status === 'planned', 'Replanning requires an existing planned route');
  const byWork = packetMap(run);
  const completed = new Set(
    [...byWork].filter(([, packet]) => packet.status === 'accepted').map(([id]) => id),
  );
  check(
    [...byWork.values()].every((packet) => ['pending', 'accepted'].includes(packet.status)),
    'Unexpected packet state',
  );
  check(
    !run.dei?.enabled || completed.size === 0,
    'Replanning accepted DEI participation needs a separate verified coverage policy',
  );
  const external = structuredClone(original.external_inputs ?? {});
  for (const id of completed) {
    const packet = byWork.get(id) as Packet;
    check(
      packet.assignment &&
        packet.result &&
        packet.result.attempt === packet.attempt &&
        packet.review?.decision === 'accepted' &&
        packet.review.attempt === packet.attempt,
      'Accepted work needs its actual assignment, result and review',
    );
    const planned = run.dispatch_plan?.assignments.find((item) => item.work_id === id);
    check(
      planned &&
        packet.assignment.worker_id === planned.worker_id &&
        packet.assignment.model_id === planned.model_id &&
        packet.assignment.route === planned.route &&
        packet.assignment.effort === planned.effort,
      'Accepted work binding differs from its previous plan',
    );
    if (planned.context_bound)
      check(
        planned.context_key === packet.assignment.owner_context,
        'Accepted work context differs from its previous plan',
      );
    const bound = run.bound_execution_contexts?.[planned.context_key];
    check(
      !bound || bound === packet.assignment.owner_context,
      'Accepted work context differs from its preserved binding',
    );
    for (const output of packet.required_outputs) {
      const artifact = run.artifacts[output];
      check(
        artifact && artifact.producer === packet.id && artifact.attempt === packet.attempt,
        'Accepted artifact is missing or stale',
      );
      const submission = packet.result.outputs.find((item) => item.id === output);
      check(
        submission &&
          artifact.reference === submission.reference &&
          artifact.summary === submission.summary,
        'Accepted artifact differs from its submitted evidence',
      );
      check(
        !Object.hasOwn(external, output),
        'Accepted output collides with an original external input',
      );
      external[output] = structuredClone(artifact);
    }
  }
  const items = (original.work_items ?? []).filter((item) => !completed.has(item.id));
  check(items.length, 'No pending work remains');
  const pending: WorkItemInput[] = items.map((item) => ({
    ...structuredClone(item),
    depends_on: item.depends_on.filter((id) => !completed.has(id)),
    audit_sources: (item.audit_sources ?? []).filter((id) => !completed.has(id)),
  }));
  const hardBudget = original.planning_limits?.budget_usd;
  const hardDeadline = original.planning_limits?.deadline_seconds;
  if (progress !== undefined) {
    check(
      progress.kind === 'observed' && isText(progress.evidence_reference),
      'Progress needs observed evidence',
    );
    check(
      progress.spent_cost_usd === undefined || validNumber(progress.spent_cost_usd),
      'Invalid observed spend',
    );
    check(
      progress.elapsed_seconds === undefined || validNumber(progress.elapsed_seconds),
      'Invalid observed elapsed time',
    );
  }
  check(
    hardBudget === undefined || (progress && validNumber(progress.spent_cost_usd)),
    'Hard budget requires observed spent-cost evidence',
  );
  check(
    hardDeadline === undefined || (progress && validNumber(progress.elapsed_seconds)),
    'Hard deadline requires observed elapsed-time evidence',
  );
  check(
    hardBudget === undefined || (progress?.spent_cost_usd as number) <= hardBudget,
    'Observed spend already exceeds the hard budget',
  );
  check(
    hardDeadline === undefined || (progress?.elapsed_seconds as number) <= hardDeadline,
    'Observed elapsed time already exceeds the hard deadline',
  );
  const limits = { ...original.planning_limits };
  if (hardBudget !== undefined)
    limits.budget_usd = hardBudget - (progress?.spent_cost_usd as number);
  if (hardDeadline !== undefined)
    limits.deadline_seconds = hardDeadline - (progress?.elapsed_seconds as number);
  limits.max_parallel = Math.min(
    limits.max_parallel ?? run.limits.max_parallel,
    run.limits.max_parallel,
  );
  if (run.planning_limits?.max_workers !== undefined)
    limits.max_workers = Math.min(
      limits.max_workers ?? run.planning_limits.max_workers,
      run.planning_limits.max_workers,
    );
  return {
    ...structuredClone(original),
    work_items: pending,
    external_inputs: external,
    planning_limits: limits,
    reporting_lines: structuredClone(run.supervision?.reporting_lines ?? []),
  };
}

function preparationFailure(error: unknown): ReplanPreparation {
  const reason = error instanceof Error ? error.message : 'Unable to prepare replan';
  return {
    status: /exceed/i.test(reason) ? 'constraints-unmet' : 'needs-evidence',
    reason,
  };
}

export async function prepareIntegratedReplan(
  run: Run,
  request: ReplanRequest,
): Promise<ReplanPreparation> {
  check(
    request && Number.isInteger(request.expected_revision),
    'A replan needs the expected run revision',
  );
  check(request.expected_revision === run.revision, 'Stale run revision');
  check(
    isRecord(request.integration) && !Object.hasOwn(request.integration, 'brief'),
    'Replan supplies fresh integration data, not a replacement brief',
  );
  try {
    const original = originalBrief(run);
    if (Object.values(run.packets).every((packet) => packet.status === 'accepted'))
      return { status: 'no-change', reason: 'All work is already accepted' };
    const originalTrialCap = original.planning_limits?.max_trial_assignments;
    const requestedTrials = request.integration.public_trials;
    check(
      originalTrialCap === undefined ||
        !requestedTrials?.enabled ||
        requestedTrials.max_assignments <= originalTrialCap,
      'Fresh public trial policy exceeds the original assignment ceiling',
    );
    check(
      !requestedTrials?.enabled ||
        original.planning_limits?.unproven_routes === undefined ||
        original.planning_limits.unproven_routes === 'sourced-trial',
      'Sourced trials cannot override the original unproven-route policy',
    );
    const brief = remainingBrief(run, original, request.progress);
    const prepared = await prepareIntegratedPlan({ ...request.integration, brief });
    if (prepared.status !== 'planned' || !prepared.plan || !prepared.planned_brief) {
      return {
        status: prepared.status === 'constraints-unmet' ? 'constraints-unmet' : 'needs-evidence',
        reason: `Fresh integrated plan: ${prepared.status}`,
        prepared,
      };
    }
    checkTrialCap(run, original, prepared.plan as ScheduledPlan);
    const proposal = {
      expected_revision: run.revision,
      state_hash: digest(run),
      original_brief_hash: digest(original),
      remaining_brief: brief,
      prepared,
      ...(request.progress ? { progress: structuredClone(request.progress) } : {}),
    };
    return { status: 'prepared', proposal: { ...proposal, proposal_hash: digest(proposal) } };
  } catch (error) {
    return preparationFailure(error);
  }
}

function comparableBrief(brief: BriefInput): BriefInput {
  const clean = structuredClone(brief);
  delete clean.workers;
  if (clean.planning_limits) {
    delete clean.planning_limits.unproven_routes;
    delete clean.planning_limits.sourced_trials;
    delete clean.planning_limits.max_trial_assignments;
    delete clean.planning_limits.trial_estimate;
  }
  return clean;
}

function checkHistoricalAudit(
  run: Run,
  original: BriefInput,
  assignments: PlannedAssignment[],
): string | null {
  const byWork = packetMap(run);
  for (const item of assignments) {
    const originalWork = original.work_items?.find((work) => work.id === item.work_id);
    for (const source of originalWork?.audit_sources ?? []) {
      const audited = byWork.get(source);
      if (audited?.status !== 'accepted') continue;
      const owner = item.context_bound
        ? item.context_key
        : run.bound_execution_contexts?.[item.context_key];
      if (!owner)
        return `Independent audit ${item.work_id} needs a verified context for its accepted source`;
      if (
        [
          audited.assignment?.owner_context,
          ...(audited.assignment?.contributor_contexts ?? []),
        ].includes(owner)
      )
        return `Independent audit ${item.work_id} cannot reuse an accepted producer context`;
    }
  }
  return null;
}

export function adoptIntegratedReplan(
  run: Run,
  proposal: ReplanProposal,
  adoption: ReplanAdoption,
): ReplanResult {
  check(
    proposal && proposal.expected_revision === run.revision && proposal.state_hash === digest(run),
    'Stale run revision or changed run snapshot',
  );
  const { proposal_hash, ...contents } = proposal;
  check(
    isText(proposal_hash) && proposal_hash === digest(contents),
    'Prepared replan was modified',
  );
  check(
    adoption && adoption.actor_context === run.lead_context && isText(adoption.reason),
    'The root coordinator must record a reason',
  );
  check(Array.isArray(adoption.approvals), 'Supply direct-supervisor approvals');
  try {
    const original = originalBrief(run);
    check(
      proposal.original_brief_hash === digest(original),
      'Original brief changed during replanning',
    );
    const remaining = remainingBrief(run, original, proposal.progress);
    check(equal(remaining, proposal.remaining_brief), 'Replan scope or observed progress changed');
    const prepared = proposal.prepared;
    check(
      prepared?.status === 'planned' &&
        prepared.planned_brief &&
        prepared.plan?.status === 'planned',
      'A successful integrated plan is required',
    );
    check(
      prepared.catalog.inventory_status === 'complete' && prepared.catalog.workers.length > 0,
      'A complete fresh host inventory is required',
    );
    check(
      prepared.catalog.workers.every(
        (worker) =>
          typeof worker.available === 'boolean' &&
          isText(worker.effort) &&
          worker.effort !== 'unknown',
      ),
      'Fresh host inventory has unknown route availability or effort',
    );
    check(
      equal(comparableBrief(prepared.planned_brief), comparableBrief(remaining)),
      'Planned work differs from the original remaining contract',
    );
    check(
      equal(prepared.planned_brief.workers, prepared.catalog.workers),
      'Planned routes differ from the fresh catalog',
    );
    const plannedLimits = prepared.planned_brief.planning_limits;
    const originalTrialCap = original.planning_limits?.max_trial_assignments;
    check(
      originalTrialCap === undefined ||
        plannedLimits?.max_trial_assignments === undefined ||
        plannedLimits.max_trial_assignments <= originalTrialCap,
      'Fresh public trial policy exceeds the original assignment ceiling',
    );
    check(
      plannedLimits?.unproven_routes !== 'sourced-trial' ||
        original.planning_limits?.unproven_routes === undefined ||
        original.planning_limits.unproven_routes === 'sourced-trial',
      'Sourced trials cannot override the original unproven-route policy',
    );
    check(
      plannedLimits?.unproven_routes === 'refuse' ||
        plannedLimits?.unproven_routes === 'sourced-trial',
      'Integrated replanning accepts only verified local routes or explicitly sourced trials',
    );
    if (plannedLimits?.unproven_routes === 'sourced-trial')
      check(
        equal(plannedLimits.sourced_trials, externalTrials(remaining, prepared.catalog)),
        'Provisional trials differ from the fresh catalog evidence',
      );
    const recomputed = planWork(prepared.planned_brief, prepared.catalog.workers);
    check(
      recomputed.status === 'planned' && equal(recomputed, prepared.plan),
      'Fresh plan cannot be reproduced from its catalog',
    );
    const next = prepared.plan as ScheduledPlan;
    checkTrialCap(run, original, next);
    check(
      next.peak_parallel <= run.limits.max_parallel,
      'Fresh plan exceeds the current parallel capacity',
    );
    const hardBudget = original.planning_limits?.budget_usd;
    const hardDeadline = original.planning_limits?.deadline_seconds;
    check(
      hardBudget === undefined ||
        (next.estimated_cost_usd !== null && validNumber(next.estimated_cost_usd)),
      'Hard budget needs a complete remaining-cost estimate',
    );
    check(
      hardDeadline === undefined ||
        (next.estimated_makespan_seconds !== null && validNumber(next.estimated_makespan_seconds)),
      'Hard deadline needs a complete remaining-time estimate',
    );
    check(
      hardBudget === undefined ||
        (proposal.progress?.spent_cost_usd as number) + (next.estimated_cost_usd as number) <=
          hardBudget,
      'Remaining estimated work exceeds the hard budget',
    );
    check(
      hardDeadline === undefined ||
        (proposal.progress?.elapsed_seconds as number) +
          (next.estimated_makespan_seconds as number) <=
          hardDeadline,
      'Remaining estimated work exceeds the hard deadline',
    );
    const audit = checkHistoricalAudit(run, original, next.assignments);
    check(!audit, audit ?? 'Invalid historical audit');
    const current = run.dispatch_plan;
    check(current?.status === 'planned', 'Existing route plan is required');
    const byWork = packetMap(run);
    const oldById = new Map(current.assignments.map((item) => [item.work_id, item]));
    const newById = new Map(next.assignments.map((item) => [item.work_id, item]));
    const remainingIds = (remaining.work_items ?? []).map((item) => item.id);
    check(
      newById.size === remainingIds.length && remainingIds.every((id) => newById.has(id)),
      'Fresh plan does not cover every pending work item',
    );
    const acceptedIds = [...byWork]
      .filter(([, packet]) => packet.status === 'accepted')
      .map(([id]) => id);
    check(
      acceptedIds.every((id) => oldById.has(id) && !newById.has(id)),
      'Accepted work must retain its prior plan',
    );
    for (const item of next.assignments) {
      const bound = run.bound_execution_contexts?.[item.context_key];
      if (!bound) continue;
      const previous = current.assignments.filter((old) => old.context_key === item.context_key);
      check(
        previous.length > 0 &&
          previous.every(
            (old) =>
              old.model_id === item.model_id &&
              old.route === item.route &&
              old.effort === item.effort,
          ),
        'An existing bound context cannot silently change model, route or effort',
      );
    }
    const contextSlots = new Set<string>();
    for (const id of acceptedIds)
      contextSlots.add(`actual:${byWork.get(id)?.assignment?.owner_context}`);
    for (const item of next.assignments) {
      const packet = byWork.get(item.work_id) as Packet;
      const old = oldById.get(item.work_id);
      const actual = item.context_bound
        ? item.context_key
        : (run.bound_execution_contexts?.[item.context_key] ??
          (old && equal(identity(old), identity(item))
            ? packet.assignment?.owner_context
            : undefined));
      contextSlots.add(actual ? `actual:${actual}` : `slot:${item.context_key}`);
    }
    if (run.planning_limits?.max_workers !== undefined)
      check(
        contextSlots.size <= run.planning_limits.max_workers,
        'Replan exceeds the current worker-context capacity',
      );
    const changed = remainingIds.filter((id) => !equal(oldById.get(id), newById.get(id)));
    if (!changed.length)
      return { status: 'no-change', reason: 'Fresh planning did not change pending work' };
    for (const approval of adoption.approvals) {
      check(
        isText(approval.actor_context) &&
          isText(approval.evidence_reference) &&
          Array.isArray(approval.work_ids),
        'Approval needs an actor, work ids and evidence reference',
      );
      check(
        approval.work_ids.length > 0 &&
          new Set(approval.work_ids).size === approval.work_ids.length,
        'Approval work ids must be nonempty and unique',
      );
      for (const id of approval.work_ids)
        check(
          changed.includes(id) && byWork.get(id)?.supervisor_context === approval.actor_context,
          'Approval must belong to the direct supervisor of changed pending work',
        );
    }
    for (const id of changed)
      check(
        adoption.approvals.some(
          (approval) =>
            approval.actor_context === byWork.get(id)?.supervisor_context &&
            approval.work_ids.includes(id),
        ),
        `Missing direct-supervisor approval for ${id}`,
      );
    const acceptedAssignments = current.assignments.filter((item) =>
      acceptedIds.includes(item.work_id),
    );
    const originalAudit = current.routing_audit;
    const remainingAudit = next.routing_audit;
    const combinedAudit =
      originalAudit && remainingAudit
        ? {
            ...structuredClone(remainingAudit),
            work: [
              ...originalAudit.work.filter((item) => acceptedIds.includes(item.work_id)),
              ...remainingAudit.work,
            ],
            boundary: `${remainingAudit.boundary} Accepted-work candidate audit is retained from the previous plan.`,
          }
        : remainingAudit;
    const combined = {
      ...structuredClone(next),
      assignments: [...structuredClone(acceptedAssignments), ...structuredClone(next.assignments)],
      ...(combinedAudit ? { routing_audit: combinedAudit } : {}),
      method: `${next.method} Accepted work is retained from the previous plan; estimates cover remaining work only.`,
      estimate_basis: `${next.estimate_basis} Prior completed cost and elapsed time are separately declared in the replan record. Accepted assignment timestamps are historical, and remaining assignment timestamps use a new planning horizon.`,
    };
    const event: ReplanEvent = {
      type: 'replan',
      id: `replan-${run.revision + 1}`,
      expected_revision: run.revision,
      packet_id: 'handover',
      attempt: run.packets.handover.attempt,
      actor_context: adoption.actor_context,
      reason: adoption.reason,
      plan_before: structuredClone(current),
      plan_after: structuredClone(combined),
      approvals: structuredClone(adoption.approvals),
    };
    check(
      !run.journal.some((entry) => entry.event.id === event.id),
      'Replan event identifier already exists',
    );
    const updated = structuredClone(run);
    for (const id of remainingIds) {
      const packet = updated.packets[(byWork.get(id) as Packet).id];
      const old = oldById.get(id);
      const selected = newById.get(id) as PlannedAssignment;
      if (old && !equal(identity(old), identity(selected))) {
        packet.assignment = null;
        delete packet.assignment_attempt;
      }
      packet.qualification = selected.qualification;
    }
    const previousRecords = updated.external_inputs.integrated_replan_evidence;
    check(
      previousRecords === undefined || Array.isArray(previousRecords),
      'Invalid existing replan evidence history',
    );
    updated.external_inputs.integrated_replan_evidence = [
      ...(previousRecords ?? []),
      {
        revision: run.revision + 1,
        original_brief_hash: proposal.original_brief_hash,
        catalog: structuredClone(prepared.catalog),
        progress: structuredClone(proposal.progress ?? null),
        boundary:
          'Host-declared inventory, evidence and observed progress require independent host verification; no model was launched.',
      },
    ];
    updated.dispatch_plan = combined;
    updated.revision++;
    updated.journal.push({
      revision: updated.revision,
      recorded_at: new Date().toISOString(),
      event,
    });
    return { status: 'adopted', run: updated, event, changed_work_ids: changed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unable to adopt replan';
    return {
      status: /exceed/i.test(reason) ? 'constraints-unmet' : 'needs-evidence',
      reason,
    };
  }
}
