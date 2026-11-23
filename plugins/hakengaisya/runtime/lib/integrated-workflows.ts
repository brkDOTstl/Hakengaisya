import { createPrivateKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { identifier } from '../packages/evaluator/src/contract.ts';
import {
  claimHarness2Request,
  completeHarness2Request,
  type HostBaselineOptions,
  type HostClaimOptions,
  type HostCompleteOptions,
  type HostStepOptions,
  nextHarness2Step,
  rejectedHarness2Baseline,
} from '../packages/optimizer/src/host-driver.ts';
import { canonicalEqual, sha256Digest } from './canonical.ts';
import {
  type ComplianceCheckpointRequest,
  type ComplianceCiteRequest,
  type ComplianceResolveRequest,
  type ComplianceRuleRequest,
  issueComplianceCitation,
  prepareComplianceAudit,
  recordComplianceCheckpoint,
  recordComplianceRule,
  resolveComplianceCitation,
} from './compliance-monitor.ts';
import { prepareDispatch } from './dispatch.ts';
import { lookupAcceptedExperience, registerAcceptedExperience } from './experience.ts';
import {
  flushPeerFeedbackLocal,
  type PeerObservation,
  preparePeerFeedback,
  queuePeerFeedback,
  submitPeerFeedbackLocal,
} from './feedback.ts';
import { type IntegrationInput, prepareIntegratedPlan } from './integrated.ts';
import {
  type IntegrationConfig,
  loadIntegrationConfig,
  reviewerIdentityForModel,
} from './integration-config.ts';
import type { Harness2Job, Harness2Report } from './learning.ts';
import { createHarness2Job, proposeImprovementSubmission } from './learning.ts';
import {
  lookupProjectMemory,
  type ProjectMemoryCategory,
  registerProjectMemory,
  snapshotToBinding,
} from './project-memory.ts';
import {
  adoptIntegratedReplan,
  type ReplanAdoption,
  type ReplanProposal,
  type ReplanResult,
} from './replan.ts';
import { createRunFile, readJson, readRun, resolveRunFile, updateRun } from './store.ts';
import type { BatchEvent, BriefInput, Template } from './types.ts';
import { check } from './validate.ts';
import { applyEvents, chooseStructure, createRun, nextActions } from './workflow.ts';

const form = <T>(value: unknown): T => value as T;

export const loadTemplate = async (id: string): Promise<Template> =>
  form<Template>(await readJson(new URL(`../templates/${id}.json`, import.meta.url)));

export async function createPersistedRun(filename: string, input: BriefInput) {
  const selection = chooseStructure(input);
  check(selection.template_id, 'Direct mode does not create a company run');
  const template =
    selection.template_id === 'task-graph' ? null : await loadTemplate(selection.template_id);
  const run = createRun(template, input);
  await createRunFile(filename, run);
  return run;
}

class ReplanNotAdopted extends Error {
  readonly result: Exclude<ReplanResult, { status: 'adopted' }>;
  constructor(result: Exclude<ReplanResult, { status: 'adopted' }>) {
    super(result.reason);
    this.result = result;
  }
}

export async function configuredHostStep(
  input: Partial<HostStepOptions> & { config_file?: string },
): Promise<HostStepOptions> {
  const loaded = input.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const learning = loaded?.config?.learning;
  for (const key of ['state_dir', 'python', 'upstream'] as const)
    if (input[key] && learning?.[key])
      check(input[key] === learning[key], `${key} differs from explicit configuration`);
  const stateDir = input.state_dir ?? learning?.state_dir;
  check(input.job_file && stateDir, 'Supply a saved job and local learning state');
  return {
    job_file: input.job_file,
    state_dir: stateDir,
    python: input.python ?? learning?.python,
    upstream: input.upstream ?? learning?.upstream,
    timeout_ms: input.timeout_ms,
  };
}

export function reviewerModels(config: IntegrationConfig | null | undefined): string[] {
  const evaluator = config?.evaluator;
  return evaluator?.reviewers
    ? evaluator.reviewers.map((item) => item.reviewer_model)
    : evaluator?.reviewer_model
      ? [evaluator.reviewer_model]
      : [];
}

export async function runIntegratedCreate(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const prepared = await prepareIntegratedPlan(form<IntegrationInput>(request));
  if (!prepared.planned_brief) return { created: false, ...prepared };
  const filename = resolveRunFile(run_file, base);
  const original = structuredClone(form<IntegrationInput>(request).brief);
  if (prepared.planned_brief.planning_limits?.unproven_routes === 'sourced-trial')
    original.planning_limits = {
      ...original.planning_limits,
      unproven_routes: 'sourced-trial',
      max_trial_assignments: prepared.planned_brief.planning_limits.max_trial_assignments,
    };
  if (prepared.planned_brief.planning_limits?.allow_api_cost_estimates === true)
    original.planning_limits = {
      ...original.planning_limits,
      allow_api_cost_estimates: true,
      max_cost_estimate_age_days: prepared.planned_brief.planning_limits.max_cost_estimate_age_days,
    };
  const input = {
    ...prepared.planned_brief,
    external_inputs: {
      ...prepared.planned_brief.external_inputs,
      integrated_original_brief: original,
      integrated_staffing_evidence: {
        inventory_status: prepared.catalog.inventory_status,
        evaluator: prepared.catalog.evaluator,
        historical: prepared.catalog.historical,
        historical_evidence: prepared.catalog.historical_evidence,
        external_evidence: prepared.catalog.external_evidence,
        cost_observations: prepared.cost_observations,
        research_requests: prepared.research_requests,
      },
    },
  };
  const run = await createPersistedRun(filename, input);
  return {
    created: true,
    run_file: filename,
    catalog: prepared.catalog,
    research_requests: prepared.research_requests,
    ...nextActions(run),
  };
}

export async function runIntegratedReserve(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{
    packet_id: string;
    expected_revision: number;
    actor_context: string;
    owner_context: string;
    reviewer_context: string;
    contributor_contexts: string[];
    fit_reason?: string;
    config_file?: string;
    experience?: { state_dir: string; scope: string; max_entries?: number };
    project_memory?: { state_dir: string; scope: string; max_bytes?: number };
  }>(request);
  const loaded = input.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const learning = loaded?.config?.learning;
  if (learning?.reuse_enabled) check(learning.scope, 'Configured experience reuse needs a scope');
  const experienceRequest =
    input.experience ??
    (learning?.reuse_enabled && learning.scope
      ? { state_dir: learning.state_dir, scope: learning.scope }
      : undefined);
  const projectMemoryRequest =
    input.project_memory ??
    (learning?.reuse_enabled && learning.scope
      ? { state_dir: learning.state_dir, scope: learning.scope }
      : undefined);
  const filename = resolveRunFile(run_file, base);
  let launch: unknown;
  const updated = await updateRun(filename, async (run) => {
    const packet = Object.hasOwn(run.packets, input.packet_id)
      ? run.packets[input.packet_id]
      : undefined;
    check(
      packet && run.dispatch_plan?.status === 'planned',
      'A current planned packet is required',
    );
    const planned = run.dispatch_plan.assignments.find(
      (item) => item.work_id === packet.source_work_id,
    );
    check(planned, 'The packet has no selected route');
    const existingContext =
      planned.context_bound || Boolean(run.bound_execution_contexts?.[planned.context_key]);
    const assigned = applyEvents(run, [
      {
        id: `bind-${packet.id}-${packet.attempt}`,
        type: 'assign',
        expected_revision: input.expected_revision,
        packet_id: packet.id,
        attempt: packet.attempt,
        actor_context: input.actor_context,
        assignment: {
          owner_context: input.owner_context,
          reviewer_context: input.reviewer_context,
          contributor_contexts: input.contributor_contexts,
          writes: packet.declared_writes ?? [],
          worker_id: planned.worker_id,
          model_id: planned.model_id,
          route: planned.route,
          effort: planned.effort,
          ...(input.fit_reason ? { fit_reason: input.fit_reason } : {}),
        },
      },
    ]);
    let stagedAssigned = assigned;
    let projectMemoryStatus: Record<string, unknown> = {
      status: 'not-requested',
      entry_ids: [],
    };
    const existingFrozen = assigned.bound_memory_snapshots?.[input.owner_context];
    if (existingFrozen) {
      let deferredDiskUpdates = false;
      if (projectMemoryRequest && assigned.domain) {
        const currentOnDisk = await lookupProjectMemory(
          assigned,
          existingFrozen.scope,
          projectMemoryRequest.state_dir,
          projectMemoryRequest.max_bytes,
        );
        deferredDiskUpdates = currentOnDisk.snapshot_sha256 !== existingFrozen.snapshot_sha256;
      }
      projectMemoryStatus = {
        status: 'frozen-reused',
        scope: existingFrozen.scope,
        memory_id: existingFrozen.memory_id,
        snapshot_sha256: existingFrozen.snapshot_sha256,
        entry_ids: [...existingFrozen.entry_ids],
        frozen_at_revision: existingFrozen.frozen_at_revision,
        deferred_disk_updates: deferredDiskUpdates,
      };
    } else if (projectMemoryRequest && assigned.domain) {
      const snapshot = await lookupProjectMemory(
        assigned,
        projectMemoryRequest.scope,
        projectMemoryRequest.state_dir,
        projectMemoryRequest.max_bytes,
      );
      const binding = snapshotToBinding(snapshot, assigned.revision);
      stagedAssigned = {
        ...assigned,
        bound_memory_snapshots: {
          ...assigned.bound_memory_snapshots,
          [input.owner_context]: binding,
        },
      };
      projectMemoryStatus = {
        status: snapshot.status,
        scope: snapshot.scope,
        memory_id: snapshot.memory_id,
        snapshot_sha256: snapshot.snapshot_sha256,
        entry_ids: snapshot.entry_ids,
        truncated: snapshot.truncated,
        frozen_at_revision: assigned.revision,
        deferred_disk_updates: false,
      };
    }
    const contract = prepareDispatch(stagedAssigned, packet.id);
    const optimizerJob = stagedAssigned.improvement?.enabled
      ? createHarness2Job(stagedAssigned, contract)
      : null;
    const experience = experienceRequest
      ? await lookupAcceptedExperience(
          stagedAssigned,
          stagedAssigned.packets[packet.id],
          experienceRequest.scope,
          experienceRequest.state_dir,
          'max_entries' in experienceRequest ? experienceRequest.max_entries : undefined,
        )
      : { status: 'not-requested', entries: [] };
    const reserved = applyEvents(stagedAssigned, [
      {
        id: `reserve-${packet.id}-${packet.attempt}`,
        type: 'start',
        expected_revision: stagedAssigned.revision,
        packet_id: packet.id,
        attempt: packet.attempt,
        actor_context: input.owner_context,
      },
    ]);
    launch = {
      supervisor_context: packet.supervisor_context,
      owner_context: input.owner_context,
      model: planned.model_id,
      route: planned.route,
      reasoning_effort: planned.effort,
      mode: existingContext ? 'reuse-existing-context' : 'new-native-context',
      fork_turns: existingContext ? null : 'none',
      contract,
      optimizer_job: optimizerJob,
      experience,
      project_memory: projectMemoryStatus,
    };
    return reserved;
  });
  return {
    run_file: filename,
    revision: updated.revision,
    status: 'reserved-awaiting-native-host',
    launch,
    boundary:
      'Reservation is not a successful model launch. The direct supervisor verifies actual identity and, for reuse, an available matching existing context. On failure or uncertain execution, block and preserve the reservation; never silently relaunch.',
  };
}

export async function runIntegratedReplanAdopt(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{ proposal: ReplanProposal; adoption: ReplanAdoption }>(request);
  const filename = resolveRunFile(run_file, base);
  let outcome: ReplanResult | undefined;
  try {
    const updated = await updateRun(filename, (run) => {
      outcome = adoptIntegratedReplan(run, input.proposal, input.adoption);
      if (outcome.status !== 'adopted') throw new ReplanNotAdopted(outcome);
      return outcome.run;
    });
    const accepted = outcome as Extract<ReplanResult, { status: 'adopted' }> | undefined;
    return {
      status: 'adopted',
      run_file: filename,
      revision: updated.revision,
      changed_work_ids: accepted?.changed_work_ids,
      event: accepted?.event,
      boundary:
        'The host must verify supervisor identities, actual model bindings and evidence; no model was launched.',
    };
  } catch (error) {
    if (error instanceof ReplanNotAdopted) return error.result;
    throw error;
  }
}

export async function runFeedbackRecord(run_file: unknown, request: unknown, base?: string | null) {
  const input = form<{
    packet_id: string;
    attempt: number;
    observation: Omit<PeerObservation, 'task_salt'>;
    config_file?: string;
    submit_local?: boolean;
    task_salt_file?: string;
    queue_dir?: string;
    local_evaluator?: { endpoint: string; client_id: string; private_key_file: string };
  }>(request);
  const loaded = input?.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const configured = loaded?.config?.evaluator;
  if (configured && input.task_salt_file && configured.task_salt_file)
    check(
      input.task_salt_file === configured.task_salt_file,
      'Salt path differs from explicit configuration',
    );
  if (configured && input.queue_dir && configured.queue_dir)
    check(
      input.queue_dir === configured.queue_dir,
      'Queue path differs from explicit configuration',
    );
  const saltFile = input.task_salt_file ?? configured?.task_salt_file;
  const queueDir = input.queue_dir ?? configured?.queue_dir;
  check(
    input && saltFile && queueDir && path.isAbsolute(saltFile) && path.isAbsolute(queueDir),
    'Use absolute local salt and queue paths',
  );
  const run = await readRun(resolveRunFile(run_file, base));
  const salt = await readFile(saltFile, 'utf8');
  const prepared = preparePeerFeedback(run, input.packet_id, input.attempt, {
    ...input.observation,
    task_salt: salt,
  });
  const queued = await queuePeerFeedback(prepared, queueDir);
  if (input.submit_local !== undefined)
    check(typeof input.submit_local === 'boolean', 'Submission policy must be boolean');
  const identity =
    prepared.status === 'ready' && loaded?.config
      ? reviewerIdentityForModel(loaded.config, prepared.report.reviewer_model)
      : null;
  const hasConfiguredIdentities = Boolean(
    configured?.reviewer_model || configured?.reviewers?.length,
  );
  if (
    prepared.status === 'ready' &&
    input.submit_local !== false &&
    hasConfiguredIdentities &&
    !identity
  )
    return {
      queued,
      submission: { status: 'reviewer-identity-mismatch' },
      boundary:
        'The actual reviewer does not match a configured signing identity; no key was read and no report was sent.',
    };
  const configuredDestination =
    configured?.endpoint && identity
      ? {
          endpoint: configured.endpoint,
          client_id: identity.client_id,
          private_key_file: identity.private_key_file,
        }
      : undefined;
  if (configuredDestination && input.local_evaluator)
    check(
      canonicalEqual(configuredDestination, input.local_evaluator),
      'Evaluator destination differs from explicit configuration',
    );
  if (configured?.endpoint && input.local_evaluator)
    check(
      configured.endpoint === input.local_evaluator.endpoint,
      'Evaluator endpoint differs from explicit configuration',
    );
  const destination =
    input.submit_local === false ? undefined : (input.local_evaluator ?? configuredDestination);
  if (!destination || prepared.status !== 'ready')
    return {
      queued,
      submission: {
        status: prepared.status === 'operational-only' ? 'operational-only' : 'not-requested',
      },
      boundary: prepared.boundary,
    };
  check(path.isAbsolute(destination.private_key_file), 'Use an absolute local private key path');
  const privateKey = createPrivateKey(await readFile(destination.private_key_file, 'utf8'));
  const submission = await submitPeerFeedbackLocal(prepared, destination.endpoint, {
    clientId: destination.client_id,
    privateKey,
  });
  return {
    queued,
    submission,
    boundary:
      'The sanitized report was attempted only against the explicit loopback evaluator; submission status is reported separately. Host-reported identity and usage are not provider-authenticated.',
  };
}

export async function runFeedbackFlush(request: unknown) {
  const input = form<{
    config_file?: string;
    queue_dir?: string;
    endpoint?: string;
    client_id?: string;
    private_key_file?: string;
    reviewer_model?: string;
    max_records?: number;
  }>(request);
  const loaded = input?.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const configured = loaded?.config?.evaluator;
  const models = reviewerModels(loaded?.config);
  const chosenModel = input.reviewer_model ?? (models.length === 1 ? models[0] : undefined);
  if (!chosenModel)
    return {
      status: 'needs-reviewer-selection',
      reviewer_models: models,
      boundary: 'Select the actual reviewer model; no key was read or report sent.',
    };
  identifier(chosenModel);
  const identity =
    chosenModel && loaded?.config ? reviewerIdentityForModel(loaded.config, chosenModel) : null;
  if (models.length && chosenModel && !identity)
    return {
      status: 'reviewer-identity-mismatch',
      reviewer_models: models,
      boundary: 'No signing identity matches the actual reviewer; no key was read or report sent.',
    };
  for (const key of ['queue_dir', 'endpoint'] as const)
    if (input[key] && configured?.[key])
      check(input[key] === configured[key], `${key} differs from explicit configuration`);
  if (identity && input.client_id)
    check(input.client_id === identity.client_id, 'Client differs from configured reviewer');
  if (identity && input.private_key_file)
    check(
      input.private_key_file === identity.private_key_file,
      'Key differs from configured reviewer',
    );
  const queue = input.queue_dir ?? configured?.queue_dir;
  const endpoint = input.endpoint ?? configured?.endpoint;
  const clientId = input.client_id ?? identity?.client_id;
  const keyFile = input.private_key_file ?? identity?.private_key_file;
  check(
    input && queue && endpoint && clientId && keyFile && path.isAbsolute(keyFile),
    'Supply a configured local queue, endpoint, client and private key path',
  );
  const privateKey = createPrivateKey(await readFile(keyFile, 'utf8'));
  return flushPeerFeedbackLocal(
    queue,
    endpoint,
    { clientId, privateKey },
    input.max_records,
    chosenModel,
  );
}

export async function runIntegratedReview(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{ event: BatchEvent; feedback: Record<string, unknown> }>(request);
  check(
    input?.event?.type === 'review' && input.feedback,
    'Supply a review event and feedback request',
  );
  check(
    input.feedback.packet_id === input.event.packet_id &&
      input.feedback.attempt === input.event.attempt,
    'Feedback must refer to the reviewed packet and attempt',
  );
  const filename = resolveRunFile(run_file, base);
  const feedback = input.feedback as { observation?: Partial<PeerObservation> };
  const identity = feedback.observation?.identities?.find(
    (item) => item.context === input.event.actor_context,
  );
  const reviewEvent =
    identity?.model_id && identity.evidence_reference
      ? {
          ...input.event,
          reviewer_model: identity.model_id,
          reviewer_identity_evidence: identity.evidence_reference,
        }
      : input.event;
  const reviewed = await updateRun(filename, (run) => applyEvents(run, [reviewEvent]));
  try {
    const feedbackResult = await runFeedbackRecord(filename, input.feedback, base);
    return {
      review_applied: true,
      run_file: filename,
      revision: reviewed.revision,
      feedback: feedbackResult,
    };
  } catch (error) {
    return {
      review_applied: true,
      run_file: filename,
      revision: reviewed.revision,
      feedback: {
        status: 'pending',
        reason: error instanceof Error ? error.message : 'Feedback preparation failed.',
      },
      recovery: 'Call feedback_record for the same reviewed attempt with corrected input.',
    };
  }
}

export async function runOptimizerSaveJob(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{ job: Harness2Job; job_file: string }>(request);
  check(input?.job && path.isAbsolute(input.job_file), 'Supply a job and absolute job file');
  const job = input.job;
  const { job_id, job_fingerprint, ...content } = job;
  const fingerprint = sha256Digest(content);
  check(
    job.version === 1 &&
      job.kind === 'hakengaisya-harness2-job' &&
      job_fingerprint === fingerprint &&
      job_id === `h2-${fingerprint.slice(0, 24)}` &&
      path.basename(input.job_file) === `${job_id}.json`,
    'Job identity, fingerprint or filename differs',
  );
  const run = await readRun(resolveRunFile(run_file, base));
  const packet = Object.hasOwn(run.packets, job.packet_id) ? run.packets[job.packet_id] : undefined;
  check(
    run.run_id === job.run_id &&
      packet?.status === 'running' &&
      packet.attempt === job.attempt &&
      packet.assignment?.owner_context === job.owner_context &&
      packet.supervisor_context === job.supervisor_context &&
      canonicalEqual(run.improvement, job.policy),
    'Job is not current for the reserved packet',
  );
  for (const key of ['model_id', 'route', 'effort'] as const)
    check(
      (packet.assignment?.[key] ?? null) === job.dispatch.model_binding[key],
      'Job model binding differs',
    );
  await mkdir(path.dirname(input.job_file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(input.job_file, `${JSON.stringify(job, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    check(
      canonicalEqual(JSON.parse(await readFile(input.job_file, 'utf8')), job),
      'Existing job file has different content',
    );
  }
  return { status: 'saved', job_id, job_file: input.job_file };
}

export async function runExperienceRegister(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{
    job_file: string;
    report_file: string;
    state_dir?: string;
    config_file?: string;
    actor_context: string;
    evidence_reference: string;
  }>(request);
  check(
    input && path.isAbsolute(input.job_file) && path.isAbsolute(input.report_file),
    'Use absolute saved job and report paths',
  );
  const loaded = input.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  if (input.state_dir && loaded?.config?.learning?.state_dir)
    check(
      input.state_dir === loaded.config.learning.state_dir,
      'Learning state differs from explicit configuration',
    );
  const stateDir = input.state_dir ?? loaded?.config?.learning?.state_dir;
  check(stateDir, 'Supply a local learning state');
  const run = await readRun(resolveRunFile(run_file, base));
  const job = form<Harness2Job>(JSON.parse(await readFile(input.job_file, 'utf8')));
  if (loaded?.config?.learning?.scope && job.policy.enabled)
    check(
      loaded.config.learning.scope === job.policy.scope,
      'Job scope differs from explicit configuration',
    );
  const report = form<Harness2Report & { learned?: boolean; profile_id?: string }>(
    JSON.parse(await readFile(input.report_file, 'utf8')),
  );
  return registerAcceptedExperience(run, job, report, { ...input, state_dir: stateDir });
}

export async function runExperienceLookup(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{
    packet_id: string;
    scope?: string;
    state_dir?: string;
    config_file?: string;
    max_entries?: number;
  }>(request);
  const run = await readRun(resolveRunFile(run_file, base));
  const loaded = input.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const learning = loaded?.config?.learning;
  if (input.state_dir && learning?.state_dir)
    check(
      input.state_dir === learning.state_dir,
      'Learning state differs from explicit configuration',
    );
  if (input.scope && learning?.scope)
    check(input.scope === learning.scope, 'Learning scope differs from explicit configuration');
  const scope = input.scope ?? learning?.scope;
  const stateDir = input.state_dir ?? learning?.state_dir;
  check(scope && stateDir, 'Supply a learning scope and local state');
  const packet = Object.hasOwn(run.packets, input.packet_id)
    ? run.packets[input.packet_id]
    : undefined;
  check(packet, 'Unknown packet');
  return lookupAcceptedExperience(run, packet, scope, stateDir, input.max_entries);
}

export async function runProjectMemoryRegister(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{
    packet_id: string;
    attempt: number;
    scope?: string;
    state_dir?: string;
    config_file?: string;
    actor_context: string;
    evidence_reference: string;
    entry: {
      entry_id: string;
      category: ProjectMemoryCategory;
      title: string;
      content: string;
      supersedes_entry_id?: string;
    };
  }>(request);
  const run = await readRun(resolveRunFile(run_file, base));
  const loaded = input?.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const learning = loaded?.config?.learning;
  if (input?.state_dir && learning?.state_dir) {
    check(
      input.state_dir === learning.state_dir,
      'Learning state differs from explicit configuration',
    );
  }
  if (input?.scope && learning?.scope) {
    check(input.scope === learning.scope, 'Learning scope differs from explicit configuration');
  }
  const scope = input?.scope ?? learning?.scope;
  const stateDir = input?.state_dir ?? learning?.state_dir;
  check(scope && stateDir, 'Supply a project memory scope and local learning state');
  return registerProjectMemory(run, {
    packet_id: input.packet_id,
    attempt: input.attempt,
    scope,
    state_dir: stateDir,
    actor_context: input.actor_context,
    evidence_reference: input.evidence_reference,
    entry: input.entry,
  });
}

export async function runProjectMemoryLookup(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{
    scope?: string;
    state_dir?: string;
    config_file?: string;
    max_bytes?: number;
  }>(request);
  const run = await readRun(resolveRunFile(run_file, base));
  const loaded = input?.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const learning = loaded?.config?.learning;
  if (input?.state_dir && learning?.state_dir) {
    check(
      input.state_dir === learning.state_dir,
      'Learning state differs from explicit configuration',
    );
  }
  if (input?.scope && learning?.scope) {
    check(input.scope === learning.scope, 'Learning scope differs from explicit configuration');
  }
  const scope = input?.scope ?? learning?.scope;
  const stateDir = input?.state_dir ?? learning?.state_dir;
  check(scope && stateDir, 'Supply a project memory scope and local learning state');
  return lookupProjectMemory(run, scope, stateDir, input?.max_bytes);
}

export async function runComplianceInspect(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input =
    request === undefined || request === null
      ? {}
      : form<{ target_context?: string; packet_id?: string }>(request);
  const run = await readRun(resolveRunFile(run_file, base));
  return prepareComplianceAudit(run, input);
}

export async function runComplianceRecordRule(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<ComplianceRuleRequest>(request);
  const filename = resolveRunFile(run_file, base);
  let recorded: { kind: 'decision' | 'document'; rule: unknown } | null = null;
  const updated = await updateRun(filename, (run) => {
    const result = recordComplianceRule(run, input);
    recorded = { kind: result.kind, rule: result.rule };
    return result.run;
  });
  return {
    run_file: filename,
    recorded,
    ...nextActions(updated),
  };
}

export async function runComplianceCite(run_file: unknown, request: unknown, base?: string | null) {
  const input = form<ComplianceCiteRequest>(request);
  const filename = resolveRunFile(run_file, base);
  let outcome: {
    citation: unknown;
    reopened_packets: string[];
    correction_notice: unknown;
  } | null = null;
  const updated = await updateRun(filename, (run) => {
    const result = issueComplianceCitation(run, input);
    outcome = {
      citation: result.citation,
      reopened_packets: result.reopened_packets,
      correction_notice: result.correction_notice,
    };
    return result.run;
  });
  return {
    run_file: filename,
    ...(outcome ?? {}),
    ...nextActions(updated),
  };
}

export async function runComplianceResolve(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<ComplianceResolveRequest>(request);
  const filename = resolveRunFile(run_file, base);
  let citation: unknown = null;
  const updated = await updateRun(filename, (run) => {
    const result = resolveComplianceCitation(run, input);
    citation = result.citation;
    return result.run;
  });
  return {
    run_file: filename,
    citation,
    ...nextActions(updated),
  };
}

export async function runComplianceCheckpoint(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<ComplianceCheckpointRequest>(request);
  const filename = resolveRunFile(run_file, base);
  let outcome: { checkpoint: unknown; handover_clearance: unknown } | null = null;
  const updated = await updateRun(filename, (run) => {
    const result = recordComplianceCheckpoint(run, input);
    outcome = {
      checkpoint: result.checkpoint,
      handover_clearance: result.handover_clearance,
    };
    return result.run;
  });
  return {
    run_file: filename,
    ...(outcome ?? {}),
    ...nextActions(updated),
  };
}

export async function runOptimizerHostNext(request: unknown) {
  const input = form<HostStepOptions & { config_file?: string }>(request);
  return nextHarness2Step(await configuredHostStep(input));
}

export async function runOptimizerHostClaim(request: unknown) {
  const input = form<HostClaimOptions & { config_file?: string }>(request);
  return claimHarness2Request({
    ...(await configuredHostStep(input)),
    session: input.session,
    request_id: input.request_id,
    isolation: input.isolation,
  });
}

export async function runOptimizerHostComplete(request: unknown) {
  const input = form<HostCompleteOptions & { config_file?: string }>(request);
  return completeHarness2Request({
    ...(await configuredHostStep(input)),
    session: input.session,
    request_id: input.request_id,
    response: input.response,
  });
}

export async function runIntegratedOptimizerFallback(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<
    HostBaselineOptions & {
      expected_revision: number;
      actor_context: string;
      config_file?: string;
    }
  >(request);
  const recovered = await rejectedHarness2Baseline({
    ...(await configuredHostStep(input)),
    session: input.session,
  });
  if (recovered.status !== 'baseline-ready-for-submission') return recovered;
  check(
    input.actor_context === recovered.supervisor_context,
    'Only the direct supervisor may submit the retained baseline',
  );
  const job = form<Harness2Job>(JSON.parse(await readFile(input.job_file, 'utf8')));
  const filename = resolveRunFile(run_file, base);
  const updated = await updateRun(filename, (run) => {
    check(run.revision === input.expected_revision, 'Stale run revision');
    const packet = Object.hasOwn(run.packets, recovered.packet_id)
      ? run.packets[recovered.packet_id]
      : undefined;
    check(
      run.run_id === job.run_id &&
        packet?.status === 'running' &&
        packet.attempt === recovered.attempt &&
        packet.assignment?.owner_context === recovered.owner_context &&
        packet.supervisor_context === recovered.supervisor_context &&
        run.objective === job.dispatch.task_objective &&
        packet.objective === job.dispatch.objective &&
        canonicalEqual(run.acceptance, job.task_acceptance) &&
        canonicalEqual(run.constraints, job.dispatch.constraints) &&
        canonicalEqual(packet.declared_writes, job.dispatch.writes) &&
        canonicalEqual(packet.required_outputs, job.dispatch.outputs) &&
        canonicalEqual(packet.checks, job.dispatch.acceptance),
      'The baseline packet or work contract changed',
    );
    for (const key of ['model_id', 'route', 'effort'] as const)
      check(
        (packet.assignment?.[key] ?? null) === recovered.declared_model_binding[key],
        'The baseline model binding changed',
      );
    return applyEvents(run, [
      {
        id: `fallback-${recovered.baseline_request_id}`,
        type: 'submit',
        expected_revision: run.revision,
        packet_id: recovered.packet_id,
        attempt: recovered.attempt,
        actor_context: recovered.owner_context,
        outputs: recovered.outputs,
        evidence: recovered.evidence,
      },
    ]);
  });
  return {
    status: 'baseline-submitted-for-ordinary-review',
    run_file: filename,
    revision: updated.revision,
    baseline_request_id: recovered.baseline_request_id,
    boundary: recovered.boundary,
  };
}

export async function runIntegratedOptimizerSubmit(
  run_file: unknown,
  request: unknown,
  base?: string | null,
) {
  const input = form<{ job: Harness2Job; report: Harness2Report; expected_revision: number }>(
    request,
  );
  const filename = resolveRunFile(run_file, base);
  const updated = await updateRun(filename, (run) => {
    check(input && run.revision === input.expected_revision, 'Stale run revision');
    const submission = proposeImprovementSubmission(run, input.job, input.report);
    return applyEvents(run, [submission.event]);
  });
  return {
    status: 'submitted-for-ordinary-review',
    run_file: filename,
    revision: updated.revision,
    boundary: 'Harness adoption and submission are not ordinary technical or human acceptance.',
  };
}
