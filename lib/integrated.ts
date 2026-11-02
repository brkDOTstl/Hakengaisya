import { type CostObservations, readCostObservations } from './cost-observations.ts';
import {
  buildWorkerCatalog,
  type EvaluatorSnapshot,
  type ExternalEvidence,
  fetchEvaluatorProfiles,
  type HostInventory,
  type WorkerCatalog,
} from './evaluator-bridge.ts';
import { type IntegrationConfigStatus, loadIntegrationConfig } from './integration-config.ts';
import { type AuditedPlan, estimatedCost, observedTrialWall, planWork } from './planning.ts';
import type { BriefInput, SourcedTrial, WorkerInput } from './types.ts';
import { check } from './validate.ts';

export interface IntegrationInput {
  brief: BriefInput;
  inventory: HostInventory;
  config_file?: string;
  evaluator_endpoint?: string;
  external_evidence?: ExternalEvidence[];
  cost_observations?: {
    queue_dir: string;
    task_token_scope?: string;
    allow_use: boolean;
    max_age_days?: number;
  };
  public_trials?: { enabled: boolean; max_assignments: number; require_research_for_all?: boolean };
}

export interface ResearchRequest {
  work_id: string;
  worker_id: string;
  model_id: string;
  route: string;
  effort: string;
  missing_skills: string[];
  reason: string;
}

export interface IntegratedPlan {
  status: 'needs-inventory' | 'needs-research' | 'needs-trial-policy' | AuditedPlan['status'];
  catalog: WorkerCatalog;
  cost_observations: CostObservations | { status: 'not_requested'; reason: string };
  configuration: IntegrationConfigStatus | null;
  research_requests: ResearchRequest[];
  plan: AuditedPlan | null;
  planned_brief: BriefInput | null;
  boundary: string;
}

export function externalTrials(brief: BriefInput, catalog: WorkerCatalog): SourcedTrial[] {
  const output: SourcedTrial[] = [];
  for (const work of brief.work_items ?? []) {
    for (const worker of catalog.workers) {
      const entries = catalog.external_evidence.filter(
        ({ evidence, matching_worker_ids }) =>
          matching_worker_ids.includes(worker.id) &&
          evidence.task.domain === brief.domain &&
          evidence.task.task_type === work.task_type &&
          evidence.task.difficulty === work.difficulty &&
          evidence.assessment.trial_fit === 'supports' &&
          evidence.estimates?.cost_usd !== undefined &&
          evidence.estimates.wall_seconds !== undefined,
      );
      const selected = work.skills.map((skill) =>
        entries.find(({ evidence }) => evidence.task.skill === skill),
      );
      if (selected.some((item) => !item)) continue;
      const evidence = selected.map((item) => item?.evidence as ExternalEvidence);
      const localCosts = work.skills.map((skill) => estimatedCost(work, worker, brief, skill));
      const localWalls = work.skills.map((skill) => observedTrialWall(work, worker, brief, skill));
      const hasCosts = localCosts.every(Boolean);
      const hasWalls = localWalls.every((item) => item !== undefined);
      output.push({
        work_id: work.id,
        worker_id: worker.id,
        estimate: {
          cost_usd: hasCosts
            ? Math.max(...localCosts.map((item) => item?.estimated_cost_usd as number))
            : Math.max(...evidence.map((item) => item.estimates?.cost_usd as number)),
          wall_seconds: hasWalls
            ? Math.max(...(localWalls as number[]))
            : Math.max(...evidence.map((item) => item.estimates?.wall_seconds as number)),
        },
        estimate_basis: `${hasCosts ? 'API-equivalent estimates from prior local work. ' : ''}${hasWalls ? 'Reported elapsed time from prior local work. ' : ''}${evidence.map((item) => item.estimates?.basis).join('; ')}`,
        cost_basis: hasCosts ? 'api-equivalent-estimate' : 'declared-trial-estimate',
        ...(hasCosts
          ? { cost_evidence: localCosts as NonNullable<(typeof localCosts)[number]>[] }
          : {}),
        wall_basis: hasWalls ? 'reported-local-observation' : 'declared-trial-estimate',
        sources: evidence.map((item) => ({
          model_id: item.model_id,
          route: item.route,
          effort: item.effort,
          domain: item.task.domain,
          task_type: item.task.task_type,
          difficulty: item.task.difficulty,
          skill: item.task.skill,
          url: item.source.url,
          title: item.source.title,
          accessed_at: item.source.accessed_at,
          summary: item.assessment.summary,
        })),
      });
    }
  }
  return output;
}

function researchRequests(
  brief: BriefInput,
  workers: WorkerInput[],
  localPlan: AuditedPlan,
  sourced: SourcedTrial[],
): ResearchRequest[] {
  const workById = new Map((brief.work_items ?? []).map((item) => [item.id, item]));
  const workerById = new Map(workers.map((item) => [item.id, item]));
  const result: ResearchRequest[] = [];
  for (const item of localPlan.routing_audit.work) {
    const work = workById.get(item.work_id);
    if (!work) continue;
    for (const candidate of item.candidates) {
      if (!['ability-or-context-unproven', 'cost-or-time-unknown'].includes(candidate.reason))
        continue;
      const worker = workerById.get(candidate.worker_id);
      if (
        !worker ||
        sourced.some((trial) => trial.work_id === work.id && trial.worker_id === worker.id)
      )
        continue;
      result.push({
        work_id: work.id,
        worker_id: worker.id,
        model_id: worker.model_id,
        route: worker.route,
        effort: worker.effort ?? 'unknown',
        missing_skills: [...work.skills],
        reason:
          'Need relevant sourced assessment and explicit unobserved cost/time estimates, or supported local evidence.',
      });
    }
  }
  return result;
}

export async function prepareIntegratedPlan(input: IntegrationInput): Promise<IntegratedPlan> {
  check(input?.brief && input.inventory, 'Supply a brief and host model inventory');
  check(!input.brief.workers, 'The integrated path builds workers from the actual host inventory');
  check(
    !input.brief.planning_limits?.sourced_trials,
    'Supply public evidence through the integrated catalog',
  );
  const policy = input.public_trials;
  const loaded = input.config_file ? await loadIntegrationConfig(input.config_file) : null;
  if (loaded) check(loaded.config, 'The explicit integration configuration is unavailable');
  const configuredEndpoint = loaded?.config?.evaluator?.endpoint;
  if (configuredEndpoint && input.evaluator_endpoint)
    check(
      configuredEndpoint === input.evaluator_endpoint,
      'Evaluator endpoint differs from explicit configuration',
    );
  const endpoint = input.evaluator_endpoint ?? configuredEndpoint;
  const configuredCost = loaded?.config?.cost;
  const configuredQueue = loaded?.config?.evaluator?.queue_dir;
  const fromConfig =
    configuredCost && configuredQueue
      ? {
          queue_dir: configuredQueue,
          task_token_scope: configuredCost.task_token_scope,
          allow_use: configuredCost.allow_api_equivalent,
          max_age_days: configuredCost.max_age_days,
        }
      : undefined;
  if (fromConfig && input.cost_observations)
    check(
      input.cost_observations.queue_dir === fromConfig.queue_dir &&
        (!input.cost_observations.allow_use || fromConfig.allow_use) &&
        (input.cost_observations.max_age_days ?? fromConfig.max_age_days) <=
          fromConfig.max_age_days &&
        (!fromConfig.task_token_scope ||
          !input.cost_observations.task_token_scope ||
          input.cost_observations.task_token_scope === fromConfig.task_token_scope),
      'Cost request conflicts with explicit configuration',
    );
  const costPolicy =
    input.cost_observations && fromConfig
      ? {
          ...fromConfig,
          ...input.cost_observations,
          task_token_scope: input.cost_observations.task_token_scope ?? fromConfig.task_token_scope,
        }
      : (input.cost_observations ?? fromConfig);
  if (costPolicy) {
    check(typeof costPolicy.allow_use === 'boolean', 'Estimated-cost use must be explicit');
    check(
      !costPolicy.allow_use || input.brief.planning_limits?.allow_api_cost_estimates !== false,
      'Estimated-cost use cannot override the original refusal',
    );
    check(
      costPolicy.max_age_days === undefined ||
        (Number.isInteger(costPolicy.max_age_days) &&
          costPolicy.max_age_days >= 1 &&
          costPolicy.max_age_days <= 365),
      'Invalid estimated-cost maximum age',
    );
  }
  if (policy) {
    check(typeof policy.enabled === 'boolean', 'Public trial policy must be explicit');
    if (policy.enabled)
      check(
        Number.isInteger(policy.max_assignments) && policy.max_assignments > 0,
        'Public trials need a positive assignment ceiling',
      );
    if (policy.enabled)
      check(
        input.brief.planning_limits?.unproven_routes === undefined ||
          input.brief.planning_limits.unproven_routes === 'sourced-trial',
        'Public trials cannot override the original unproven-route policy',
      );
    check(
      policy.require_research_for_all === undefined ||
        typeof policy.require_research_for_all === 'boolean',
      'Research completeness must be explicit',
    );
  }
  const unavailable: EvaluatorSnapshot = {
    status: 'not_requested',
    reason: 'No local evaluator endpoint supplied by the host.',
  };
  const [snapshot, history] = endpoint
    ? await Promise.all([
        fetchEvaluatorProfiles(endpoint),
        fetchEvaluatorProfiles(endpoint, { kind: 'historical_summary' }),
      ])
    : [unavailable, unavailable];
  const catalog = buildWorkerCatalog(
    input.inventory,
    snapshot,
    input.external_evidence ?? [],
    history,
  );
  const costs = costPolicy
    ? await readCostObservations(costPolicy.queue_dir, {
        task_token_scope: costPolicy.task_token_scope,
      })
    : { status: 'not_requested' as const, reason: 'No local cost observation directory supplied.' };
  if (costPolicy?.allow_use && costs.status !== 'not_requested') {
    catalog.workers = catalog.workers.map((worker) => ({
      ...worker,
      cost_estimates: costs.estimates.filter(
        (item) =>
          item.context.model_id === worker.model_id &&
          item.context.route === worker.route &&
          item.context.effort === worker.effort,
      ),
    }));
  }
  const boundary =
    'Host inventory and public assessments are declared evidence, not authenticated execution or local model scores. Public trials need ordinary independent review; the host performs actual native launches.';
  if (
    catalog.inventory_status !== 'complete' ||
    !catalog.workers.length ||
    catalog.workers.some(
      (worker) => worker.available === undefined || !worker.effort || worker.effort === 'unknown',
    )
  ) {
    return {
      status: 'needs-inventory',
      catalog,
      cost_observations: costs,
      configuration: loaded?.status ?? null,
      research_requests: [],
      plan: null,
      planned_brief: null,
      boundary,
    };
  }
  const cleanLimits = { ...input.brief.planning_limits, unproven_routes: 'refuse' };
  if (costPolicy?.allow_use) {
    cleanLimits.allow_api_cost_estimates = true;
    cleanLimits.max_cost_estimate_age_days = Math.min(
      costPolicy.max_age_days ?? 30,
      input.brief.planning_limits?.max_cost_estimate_age_days ?? 365,
    );
  }
  delete cleanLimits.trial_estimate;
  delete cleanLimits.sourced_trials;
  const localBrief: BriefInput = { ...input.brief, planning_limits: cleanLimits };
  const localPlan = planWork(localBrief, catalog.workers);
  const availableTrials = externalTrials(localBrief, catalog);
  const research = researchRequests(input.brief, catalog.workers, localPlan, availableTrials);
  if (policy?.require_research_for_all !== false && research.length) {
    return {
      status: 'needs-research',
      catalog,
      cost_observations: costs,
      configuration: loaded?.status ?? null,
      research_requests: research,
      plan: localPlan,
      planned_brief: null,
      boundary,
    };
  }
  if (!policy?.enabled && localPlan.status === 'needs-evidence' && availableTrials.length)
    return {
      status: 'needs-trial-policy',
      catalog,
      cost_observations: costs,
      configuration: loaded?.status ?? null,
      research_requests: research,
      plan: localPlan,
      planned_brief: null,
      boundary,
    };
  const trials = policy?.enabled ? availableTrials : [];
  const plannedBrief: BriefInput = {
    ...input.brief,
    planning_limits: policy?.enabled
      ? {
          ...cleanLimits,
          unproven_routes: 'sourced-trial',
          max_trial_assignments: Math.min(
            policy.max_assignments,
            input.brief.planning_limits?.max_trial_assignments ?? policy.max_assignments,
          ),
          sourced_trials: trials,
        }
      : cleanLimits,
    workers: catalog.workers,
  };
  const plan = planWork(plannedBrief, catalog.workers);
  return {
    status: plan.status,
    catalog,
    cost_observations: costs,
    configuration: loaded?.status ?? null,
    research_requests: research,
    plan,
    planned_brief: plan.status === 'planned' ? plannedBrief : null,
    boundary,
  };
}
