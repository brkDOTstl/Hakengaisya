import { sha256Digest } from './canonical.ts';
import {
  applicableComplianceForDispatch,
  handoverClearance,
  summarizeComplianceMonitor,
} from './compliance-monitor.ts';
import { agentReview } from './participation.ts';
import { assertSupervisedReview } from './supervision.ts';
import type { Packet, Run } from './types.ts';
import { check } from './validate.ts';
import { assertStartable } from './workflow.ts';

const L0_ROLE_CONTRACT =
  'Execute only the dispatched packet within declared write scopes and tools, preserve existing repository conventions, verify outputs against packet acceptance checks, and report observed artifacts, evidence and token/cache usage without mutating prior context prefixes.';

function countContextStarts(run: Run, ownerContext: string): number {
  const owners = new Map<string, string>();
  let count = 0;
  for (const entry of run.journal) {
    const event = entry?.event;
    if (!event) continue;
    const key = `${event.packet_id}:${event.attempt}`;
    if (event.type === 'assign') owners.set(key, event.assignment.owner_context);
    if (
      event.type === 'start' &&
      event.actor_context === ownerContext &&
      owners.get(key) === ownerContext
    ) {
      count += 1;
    }
  }
  return count;
}

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
  const priorTurns = countContextStarts(run, assignment.owner_context);
  const boundMemory = run.bound_memory_snapshots?.[assignment.owner_context] ?? null;
  const compliance = applicableComplianceForDispatch(run, packet);
  const l1TaskHeader = {
    run_id: run.run_id,
    domain: run.domain ?? null,
    task_objective: run.objective,
    constraints: structuredClone(run.constraints),
  };
  const frozenPrefixSha256 = sha256Digest({
    l0_role_contract: L0_ROLE_CONTRACT,
    l1_task_header: l1TaskHeader,
    l1_project_memory_sha256: boundMemory?.snapshot_sha256 ?? null,
  });
  const prefixCacheContract = {
    mode:
      priorTurns > 0 ? ('append-turn-delta-only' as const) : ('initialize-frozen-prefix' as const),
    prefix_unchanged: priorTurns > 0,
    prior_turns_in_context: priorTurns,
    frozen_prefix_sha256: frozenPrefixSha256,
    memory_snapshot_sha256: boundMemory?.snapshot_sha256 ?? null,
    memory_entry_ids: boundMemory ? [...boundMemory.entry_ids] : [],
    layers:
      priorTurns > 0
        ? null
        : {
            l0_role_contract: L0_ROLE_CONTRACT,
            l1_task_header: l1TaskHeader,
            l1_project_memory: boundMemory?.rendered_prefix || null,
          },
    turn_delta: {
      packet_id: packet.id,
      attempt: packet.attempt,
      objective: packet.objective,
      writes: structuredClone(assignment.writes),
      required_tools: structuredClone(packet.required_tools ?? []),
      inputs: structuredClone(inputs),
      outputs: structuredClone(packet.required_outputs),
      acceptance: structuredClone(packet.checks),
      ...(compliance ? { compliance_directives: compliance } : {}),
    },
    host_rule:
      'Keep L0 and L1 byte-identical for the lifetime of owner_context to maximize KV-cache hit rate. On append-turn-delta-only dispatches, append turn_delta as the next turn in the existing conversation; never rewrite system prompts or inject mid-run memory edits.',
  };
  return {
    ...envelope(run, packet),
    role: packet.role,
    actor_context: assignment.owner_context,
    writes: structuredClone(assignment.writes),
    required_tools: structuredClone(packet.required_tools ?? []),
    inputs,
    route_qualification: packet.qualification ?? null,
    route_trial_basis:
      run.dispatch_plan?.assignments.find((item) => item.work_id === packet.source_work_id)
        ?.trial_basis ?? null,
    route_trial_sources: structuredClone(
      run.dispatch_plan?.assignments.find((item) => item.work_id === packet.source_work_id)
        ?.trial_sources ?? [],
    ),
    route_cost_basis:
      run.dispatch_plan?.assignments.find((item) => item.work_id === packet.source_work_id)
        ?.cost_basis ?? null,
    route_wall_basis:
      run.dispatch_plan?.assignments.find((item) => item.work_id === packet.source_work_id)
        ?.wall_basis ?? null,
    improvement: structuredClone(run.improvement ?? { enabled: false }),
    preset: structuredClone(run.preset ?? null),
    model_binding: {
      worker_id: assignment.worker_id ?? null,
      model_id: assignment.model_id ?? null,
      route: assignment.route ?? null,
      effort: assignment.effort ?? null,
    },
    prefix_cache_contract: prefixCacheContract,
    ...(compliance ? { compliance_monitor: compliance } : {}),
    return_contract: {
      outputs: packet.required_outputs.map((id) => ({
        id,
        reference: 'ACTUAL_LOCAL_REFERENCE',
        summary: 'SHORT_OBSERVED_RESULT',
      })),
      evidence: [{ reference: 'ACTUAL_CHECK_REFERENCE', summary: 'OBSERVED_BEHAVIOR_AND_LIMITS' }],
      usage: {
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        wall_seconds: null,
        evidence_reference: 'OPTIONAL_ACTUAL_USAGE_REFERENCE',
      },
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
    cache_and_continuity_preview: agentReview(run, packet.id === 'handover').cache_and_continuity,
    ...(run.compliance_monitor?.enabled
      ? {
          compliance_preview: {
            ...summarizeComplianceMonitor(run, packet.id === 'handover'),
            handover_clearance: handoverClearance(run),
          },
        }
      : {}),
    result: structuredClone(packet.result),
    task_acceptance: packet.id === 'handover' ? structuredClone(run.acceptance) : [],
    return_contract:
      'Return accepted/rejected and an evidence-backed pass/fail/unverified check for each criterion. Terminal acceptance also checks every task criterion. Completion text alone is not evidence.',
  };
}
