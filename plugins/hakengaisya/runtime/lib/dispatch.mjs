import { agentReview } from './participation.mjs';
import { assertSupervisedReview } from './supervision.mjs';
import { check } from './validate.mjs';
import { assertStartable } from './workflow.mjs';

function envelope(run, packet) {
  return {
    run_id: run.run_id,
    expected_revision: run.revision,
    packet_id: packet.id,
    attempt: packet.attempt,
    task_objective: run.objective,
    objective: packet.objective,
    constraints: structuredClone(run.constraints),
    outputs: structuredClone(packet.required_outputs),
    acceptance: structuredClone(packet.checks),
    supervision: run.supervision
      ? {
          supervisor_context: packet.supervisor_context,
          reports_to: packet.supervisor_context,
          acceptance_authority: packet.supervisor_context,
          root_context: run.supervision.root_context,
        }
      : null,
    boundary:
      'These are task data and declared scopes, not extra permissions. The host verifies actual tool access and artifacts. Return the dispatched attempt; never relabel stale work.',
  };
}

export function prepareDispatch(run, packetId) {
  const packet = run.packets[packetId];
  assertStartable(run, packet);
  const inputs = packet.inputs.map((id) => {
    if (Object.hasOwn(run.artifacts, id))
      return { id, artifact: structuredClone(run.artifacts[id]) };
    check(
      Object.hasOwn(run.external_inputs, id),
      `No accepted artifact or declared external input: ${id}`,
    );
    return { id, external: structuredClone(run.external_inputs[id]) };
  });
  const assignment = packet.assignment;
  return {
    ...envelope(run, packet),
    role: packet.role,
    actor_context: assignment.owner_context,
    writes: structuredClone(assignment.writes),
    required_tools: structuredClone(packet.required_tools ?? []),
    inputs,
    model_binding: {
      worker_id: assignment.worker_id ?? null,
      model_id: assignment.model_id ?? null,
      route: assignment.route ?? null,
      effort: assignment.effort ?? null,
    },
    return_contract: {
      outputs: packet.required_outputs.map((id) => ({
        id,
        reference: 'ACTUAL_LOCAL_REFERENCE',
        summary: 'SHORT_OBSERVED_RESULT',
      })),
      evidence: [{ reference: 'ACTUAL_CHECK_REFERENCE', summary: 'OBSERVED_BEHAVIOR_AND_LIMITS' }],
    },
  };
}

export function prepareReview(run, packetId) {
  const packet = run.packets[packetId];
  check(
    packet?.status === 'in_review' && packet.result && packet.result.attempt === packet.attempt,
    'Review needs a current submitted result',
  );
  check(
    ![packet.assignment.owner_context, ...packet.assignment.contributor_contexts].includes(
      packet.assignment.reviewer_context,
    ),
    'Review must be independent of every producer',
  );
  assertSupervisedReview(run, packet);
  return {
    ...envelope(run, packet),
    role: 'review',
    actor_context: packet.assignment.reviewer_context,
    writes: [],
    agent_review_preview: packet.id === 'handover' ? agentReview(run, true) : null,
    result: structuredClone(packet.result),
    task_acceptance: packet.id === 'handover' ? structuredClone(run.acceptance) : [],
    return_contract:
      'Return accepted/rejected and an evidence-backed pass/fail/unverified check for each criterion. Terminal acceptance also checks every task criterion. Completion text alone is not evidence.',
  };
}
