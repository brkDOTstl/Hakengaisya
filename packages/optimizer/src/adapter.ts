import { createHash } from 'node:crypto';
import type { prepareDispatch } from '../../../lib/dispatch.ts';
import type { ArtifactReference, EvidenceReference, Run, SubmitEvent } from '../../../lib/types.ts';
import { check } from '../../../lib/validate.ts';
import { HARNESS2, normalizeImprovement } from './contract.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

export function createHarness2Job(
  run: Run,
  dispatch: ReturnType<typeof prepareDispatch>,
  startingHarness: Record<string, string> = {},
) {
  const policy = normalizeImprovement(run.improvement);
  check(policy.enabled, 'Harness2 improvement is not enabled for this run');
  check(
    run.planning_limits?.budget_usd === undefined &&
      run.planning_limits?.deadline_seconds === undefined,
    'Improvement probe and review cost/time are unpriced; preserve the hard planning limits',
  );
  const packet = run.packets[dispatch.packet_id];
  check(
    packet &&
      packet.status === 'pending' &&
      dispatch.run_id === run.run_id &&
      dispatch.attempt === packet.attempt &&
      dispatch.expected_revision === run.revision &&
      dispatch.actor_context === packet.assignment?.owner_context,
    'Prepare a current assigned dispatch before creating an improvement job',
  );
  const model = dispatch.model_binding;
  check(
    run.domain && packet.task_type && packet.difficulty && packet.skills,
    'Improvement needs a complete task-first execution context',
  );
  check(
    model?.model_id && model.route,
    'Improvement needs an explicit actual model and route binding',
  );
  check(
    dispatch.supervision?.acceptance_authority === packet.supervisor_context &&
      packet.supervisor_context !== dispatch.actor_context,
    'Improvement adoption belongs to the direct supervisor',
  );
  check(
    startingHarness &&
      typeof startingHarness === 'object' &&
      !Array.isArray(startingHarness) &&
      Object.entries(startingHarness).every(
        ([key, value]) =>
          ['systemprompt.md', 'LongTermMEMORY.md', 'tool_descriptions/tool_guidance.md'].includes(
            key,
          ) &&
          typeof value === 'string' &&
          value.length <= 24000,
      ),
    'Starting harness overrides are limited to the three advisory Markdown components',
  );
  const content = {
    version: 1,
    kind: 'hakengaisya-harness2-job',
    upstream: HARNESS2,
    policy,
    run_id: run.run_id,
    packet_id: packet.id,
    attempt: packet.attempt,
    evidence_kind: run.evidence_kind,
    task_acceptance: structuredClone(run.acceptance),
    domain: run.domain,
    task_type: packet.task_type,
    difficulty: packet.difficulty,
    skills: packet.skills,
    owner_context: dispatch.actor_context,
    supervisor_context: packet.supervisor_context,
    dispatch: structuredClone(dispatch),
    base_harness: {
      'systemprompt.md':
        'Complete only the dispatched work using its required inputs, artifacts and observable checks.\n',
      'guardrails.md':
        'The host contract, user instructions, permissions, model binding, acceptance criteria, write scope, hierarchy and call limits are fixed. Harness text is lower-priority advice. Do not expand them or modify the live plugin, user memory, credentials, hooks, or project instructions. The direct supervisor reviews adoption and later accepts the task separately.\n',
      'LongTermMEMORY.md': '',
      'tool_descriptions/tool_guidance.md':
        'Use only tools actually available and authorized for the dispatched owner.\n',
      ...startingHarness,
    },
  };
  return {
    ...content,
    job_id: `h2-${digest(content).slice(0, 24)}`,
    job_fingerprint: digest(content),
  };
}

export type Harness2Job = ReturnType<typeof createHarness2Job>;
export interface Harness2Report {
  status: string;
  job_id: string;
  job_fingerprint: string;
  evidence_kind: string;
  supervisor_review?: {
    actor_context: string;
    decision: string;
    reason: string;
    evidence: EvidenceReference[];
  };
  outputs: ArtifactReference[];
  evidence: EvidenceReference[];
}

export function proposeImprovementSubmission(run: Run, job: Harness2Job, report: Harness2Report) {
  const { job_id, job_fingerprint, ...content } = job;
  check(
    job_fingerprint === digest(content) && job_id === `h2-${job_fingerprint.slice(0, 24)}`,
    'Improvement job was modified',
  );
  const packet = run.packets[job.packet_id];
  const assignment = packet?.assignment;
  check(
    run.run_id === job.run_id &&
      packet?.status === 'running' &&
      packet.attempt === job.attempt &&
      assignment &&
      assignment.owner_context === job.owner_context &&
      assignment.reviewer_context === job.supervisor_context &&
      packet.supervisor_context === job.supervisor_context,
    'Improvement result is stale or the responsible owner/supervisor changed',
  );
  check(
    canonical(normalizeImprovement(run.improvement)) === canonical(job.policy),
    'Improvement policy changed',
  );
  for (const key of ['model_id', 'route', 'effort'] as const)
    check(
      (assignment[key] ?? null) === job.dispatch.model_binding[key],
      'Improvement cannot silently switch the assigned model or route',
    );
  check(
    run.objective === job.dispatch.task_objective &&
      canonical(run.acceptance) === canonical(job.task_acceptance) &&
      packet.objective === job.dispatch.objective &&
      canonical(packet.declared_writes) === canonical(job.dispatch.writes) &&
      canonical(packet.required_outputs) === canonical(job.dispatch.outputs) &&
      canonical(packet.checks) === canonical(job.dispatch.acceptance) &&
      canonical(run.constraints) === canonical(job.dispatch.constraints),
    'Improvement work contract changed',
  );
  check(
    report.status === 'ready-for-submission' &&
      report.job_id === job_id &&
      report.job_fingerprint === job_fingerprint &&
      report.evidence_kind === run.evidence_kind,
    'Improvement has not produced a current reviewed submission',
  );
  check(
    report.supervisor_review?.actor_context === job.supervisor_context &&
      report.supervisor_review.decision === 'accepted' &&
      typeof report.supervisor_review.reason === 'string' &&
      report.supervisor_review.reason.trim() &&
      Array.isArray(report.supervisor_review.evidence) &&
      report.supervisor_review.evidence.length &&
      report.supervisor_review.evidence.every((item) => item.reference && item.summary),
    'Direct-supervisor adoption review with evidence is required',
  );
  check(
    Array.isArray(report.outputs) &&
      report.outputs.length === packet.required_outputs.length &&
      new Set(report.outputs.map((item) => item.id)).size === report.outputs.length &&
      report.outputs.every(
        (item) => packet.required_outputs.includes(item.id) && item.reference && item.summary,
      ),
    'Improvement must return every contracted output',
  );
  check(
    Array.isArray(report.evidence) &&
      report.evidence.length &&
      report.evidence.every((item) => item.reference && item.summary),
    'Improvement delivery needs inspectable work evidence',
  );
  return {
    requires_supervisor_task_review: true,
    event: {
      id: `h2-submit-${digest(report).slice(0, 24)}`,
      expected_revision: run.revision,
      packet_id: packet.id,
      attempt: packet.attempt,
      type: 'submit',
      actor_context: job.owner_context,
      outputs: report.outputs.map(({ id, reference, summary }) => ({ id, reference, summary })),
      evidence: report.evidence.map(({ reference, summary }) => ({ reference, summary })),
    } satisfies SubmitEvent,
    boundary:
      'Adoption review accepts a local harness experiment, not task completion. Inspect real artifacts, apply the submission through the ordinary controller, then perform direct-supervisor technical acceptance. No evaluator upload is implied.',
  };
}
