import { agentReview } from './participation.ts';
import { assertSupervisedReview } from './supervision.ts';
import type { Packet, Run } from './types.ts';
import { check } from './validate.ts';
import { assertStartable } from './workflow.ts';

const packetOf = (run: Run, packetId: string): Packet | undefined =>
  Object.hasOwn(run.packets, packetId) ? run.packets[packetId] : undefined;

function envelope(run: Run, packet: Packet) {
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

export function prepareDispatch(run: Run, packetId: string) {
  const packet = packetOf(run, packetId);
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
    route_qualification: packet.qualification ?? null,
    improvement: structuredClone(run.improvement ?? { enabled: false }),
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

export function prepareReview(run: Run, packetId: string) {
  const packet = packetOf(run, packetId);
  check(
    packet?.status === 'in_review' &&
      packet.assignment !== null &&
      packet.result !== null &&
      packet.result.attempt === packet.attempt,
    'Review needs a current submitted result',
  );
  const { assignment } = packet;
  check(
    ![assignment.owner_context, ...assignment.contributor_contexts].includes(
      assignment.reviewer_context,
    ),
    'Review must be independent of every producer',
  );
  assertSupervisedReview(run, packet);
  return {
    ...envelope(run, packet),
    role: 'review',
    actor_context: assignment.reviewer_context,
    writes: [],
    agent_review_preview: packet.id === 'handover' ? agentReview(run, true) : null,
    result: structuredClone(packet.result),
    task_acceptance: packet.id === 'handover' ? structuredClone(run.acceptance) : [],
    return_contract:
      'Return accepted/rejected and an evidence-backed pass/fail/unverified check for each criterion. Terminal acceptance also checks every task criterion. Completion text alone is not evidence.',
  };
}
