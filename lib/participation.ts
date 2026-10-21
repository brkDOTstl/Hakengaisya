import type { AssignmentInput, DeiPolicy, Run, WorkGraph } from './types.ts';
import { check, isRecord } from './validate.ts';

const DEI_FIELDS = ['enabled', 'model_ids'];
const MAX_MODEL_ID_LENGTH = 160;

export function normalizeDei(value?: unknown): DeiPolicy {
  if (value === undefined) return { enabled: false, model_ids: [] };
  check(
    isRecord(value) && Object.keys(value).every((key) => DEI_FIELDS.includes(key)),
    'Unknown or invalid DEI policy fields',
  );
  check(typeof value.enabled === 'boolean', 'DEI enabled must be boolean');
  const models = value.model_ids ?? [];
  check(
    Array.isArray(models) &&
      new Set(models).size === models.length &&
      models.every(
        (id): id is string =>
          typeof id === 'string' &&
          id.length <= MAX_MODEL_ID_LENGTH &&
          id.trim() === id &&
          id.length > 0,
      ),
    'DEI model_ids must be unique exact model identifiers',
  );
  check(!value.enabled || models.length > 0, 'Enabled DEI requires a selected model roster');
  return { enabled: value.enabled, model_ids: [...models] };
}

export function assertDeiAssignment(
  policy: DeiPolicy | undefined,
  assignment: Partial<AssignmentInput>,
): void {
  if (!policy?.enabled) return;
  check(
    assignment.model_id !== undefined && policy.model_ids.includes(assignment.model_id),
    'DEI assignments must name a selected model',
  );
  check(
    typeof assignment.route === 'string' && assignment.route.trim(),
    'DEI assignments must declare the actual model route',
  );
}

export interface PricedCandidate {
  model_id: string;
  cost: number;
}

// Bipartite matching: reserve at least one work item for every selected model, preferring each
// model's cheapest adequate work and moving earlier reservations along augmenting paths.
export function reserveDeiWork(
  policy: DeiPolicy,
  graph: WorkGraph,
  matches: Map<string, PricedCandidate[]>,
): { reservations: Map<string, string>; missing: string[] } {
  const reservations = new Map<string, string>();
  if (!policy.enabled) return { reservations, missing: [] };
  const choices = new Map(
    policy.model_ids.map((model) => [
      model,
      graph.items
        .map((work) => ({
          id: work.id,
          cost: Math.min(
            ...(matches.get(work.id) ?? [])
              .filter((candidate) => candidate.model_id === model)
              .map((candidate) => candidate.cost),
          ),
        }))
        .filter((work) => Number.isFinite(work.cost))
        .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id)),
    ]),
  );
  const choicesOf = (model: string) => choices.get(model) ?? [];
  function place(model: string, seen: Set<string>): boolean {
    for (const work of choicesOf(model)) {
      if (seen.has(work.id)) continue;
      seen.add(work.id);
      const previous = reservations.get(work.id);
      if (!previous || place(previous, seen)) {
        reservations.set(work.id, model);
        return true;
      }
    }
    return false;
  }
  const missing = policy.model_ids
    .slice()
    .sort((a, b) => choicesOf(a).length - choicesOf(b).length || a.localeCompare(b))
    .filter((model) => !place(model, new Set()));
  return { reservations, missing };
}

interface Participation {
  model_id: string;
  route: string | undefined;
  owner_context: string;
  packet_id: string;
  attempt: number;
  event_id: string;
  revision: number;
  evidence_references: string[];
}

type DeiStatus = 'disabled' | 'pending' | 'non-compliant' | 'compliant';

function deiStatus(policy: DeiPolicy, complete: boolean, missing: string[]): DeiStatus {
  if (!policy.enabled) return 'disabled';
  if (!complete) return 'pending';
  return missing.length ? 'non-compliant' : 'compliant';
}

const DEI_SCORES: Record<DeiStatus, number | null> = {
  disabled: null,
  pending: null,
  'non-compliant': 1,
  compliant: 10,
};

// Participation counts a submission only after the declared owner of that exact attempt started it.
function collectParticipation(run: Run): Participation[] {
  const assignments = new Map<string, AssignmentInput>();
  const started = new Set<string>();
  const submissions: Participation[] = [];
  for (const { revision, event } of run.journal) {
    const key = JSON.stringify([event.packet_id, event.attempt]);
    if (event.type === 'assign') assignments.set(key, event.assignment);
    if (event.type === 'start' && assignments.get(key)?.owner_context === event.actor_context) {
      started.add(key);
    }
    if (event.type !== 'submit' || !started.has(key)) continue;
    const assignment = assignments.get(key);
    if (
      assignment?.owner_context !== event.actor_context ||
      !assignment.model_id ||
      !event.outputs?.length ||
      !event.evidence?.length
    ) {
      continue;
    }
    submissions.push({
      model_id: assignment.model_id,
      route: assignment.route,
      owner_context: assignment.owner_context,
      packet_id: event.packet_id,
      attempt: event.attempt,
      event_id: event.id,
      revision,
      evidence_references: event.evidence.map((item) => item.reference),
    });
  }
  return submissions;
}

export function agentReview(
  run: Run,
  complete = Object.values(run.packets).every((packet) => packet.status === 'accepted'),
) {
  const policy = normalizeDei(run.dei);
  const submissions = collectParticipation(run);
  const models = policy.model_ids.map((model_id) => ({
    model_id,
    submissions: submissions.filter((item) => item.model_id === model_id),
  }));
  const missing = policy.enabled
    ? models.filter((model) => !model.submissions.length).map((model) => model.model_id)
    : [];
  const status = deiStatus(policy, complete, missing);
  return {
    manager_context: run.lead_context,
    evidence_kind: run.evidence_kind,
    scope: 'run-local-management-policy',
    routing_audit: run.dispatch_plan?.routing_audit ?? {
      scope: 'not-recorded',
      boundary:
        'Host-default work has no route candidate inventory; cross-family consideration is unverified.',
    },
    dei: {
      ...policy,
      status,
      score: DEI_SCORES[status],
      score_range: [1, 10],
      tags: status === 'non-compliant' ? ['dei-non-compliant'] : [],
      missing_model_ids: missing,
      models,
    },
    boundary:
      'Submitted work with declared model bindings and evidence references counts as participation, including rejected attempts. This is not provider authentication, technical ability, or an evaluator upload. The host inspects real execution evidence.',
  };
}

export type AgentReview = ReturnType<typeof agentReview>;
