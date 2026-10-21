const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

export function normalizeDei(value) {
  if (value === undefined) return { enabled: false, model_ids: [] };
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => ['enabled', 'model_ids'].includes(key)),
    'Unknown or invalid DEI policy fields',
  );
  check(typeof value.enabled === 'boolean', 'DEI enabled must be boolean');
  const models = value.model_ids ?? [];
  check(
    Array.isArray(models) &&
      new Set(models).size === models.length &&
      models.every(
        (id) => typeof id === 'string' && id.length <= 160 && id.trim() === id && id.length > 0,
      ),
    'DEI model_ids must be unique exact model identifiers',
  );
  check(!value.enabled || models.length > 0, 'Enabled DEI requires a selected model roster');
  return { enabled: value.enabled, model_ids: [...models] };
}

export function assertDeiAssignment(policy, assignment) {
  if (!policy?.enabled) return;
  check(
    policy.model_ids.includes(assignment.model_id),
    'DEI assignments must name a selected model',
  );
  check(
    typeof assignment.route === 'string' && assignment.route.trim(),
    'DEI assignments must declare the actual model route',
  );
}

export function reserveDeiWork(policy, graph, matches) {
  if (!policy.enabled) return { reservations: new Map(), missing: [] };
  const choices = new Map(
    policy.model_ids.map((model) => [
      model,
      graph.items
        .map((work) => ({
          id: work.id,
          cost: Math.min(
            ...matches
              .get(work.id)
              .filter((candidate) => candidate.model_id === model)
              .map((candidate) => candidate.cost),
          ),
        }))
        .filter((work) => Number.isFinite(work.cost))
        .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id)),
    ]),
  );
  const reservations = new Map();
  function place(model, seen) {
    for (const work of choices.get(model)) {
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
    .sort((a, b) => choices.get(a).length - choices.get(b).length || a.localeCompare(b))
    .filter((model) => !place(model, new Set()));
  return { reservations, missing };
}

export function agentReview(
  run,
  complete = Object.values(run.packets).every((packet) => packet.status === 'accepted'),
) {
  const policy = normalizeDei(run.dei);
  const assignments = new Map();
  const started = new Set();
  const submissions = [];
  for (const { revision, event } of run.journal) {
    const key = JSON.stringify([event.packet_id, event.attempt]);
    if (event.type === 'assign') assignments.set(key, event.assignment);
    if (event.type === 'start' && assignments.get(key)?.owner_context === event.actor_context)
      started.add(key);
    if (event.type !== 'submit' || !started.has(key)) continue;
    const assignment = assignments.get(key);
    if (
      assignment?.owner_context !== event.actor_context ||
      !assignment.model_id ||
      !event.outputs?.length ||
      !event.evidence?.length
    )
      continue;
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
  const models = policy.model_ids.map((model_id) => ({
    model_id,
    submissions: submissions.filter((item) => item.model_id === model_id),
  }));
  const missing = policy.enabled
    ? models.filter((model) => !model.submissions.length).map((model) => model.model_id)
    : [];
  const status = !policy.enabled
    ? 'disabled'
    : !complete
      ? 'pending'
      : missing.length
        ? 'non-compliant'
        : 'compliant';
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
      score: status === 'compliant' ? 10 : status === 'non-compliant' ? 1 : null,
      score_range: [1, 10],
      tags: status === 'non-compliant' ? ['dei-non-compliant'] : [],
      missing_model_ids: missing,
      models,
    },
    boundary:
      'Submitted work with declared model bindings and evidence references counts as participation, including rejected attempts. This is not provider authentication, technical ability, or an evaluator upload. The host inspects real execution evidence.',
  };
}
