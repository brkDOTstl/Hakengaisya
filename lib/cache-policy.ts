import type {
  AssignmentInput,
  CachePolicy,
  ContinuityMode,
  Packet,
  PacketUsage,
  PlanningLimitsInput,
  Run,
} from './types.ts';
import { check, isRecord, isText, requireText } from './validate.ts';

export const CONTINUITY_MODES: readonly ContinuityMode[] = [
  'sticky',
  'prefer-single-model',
  'strict-single-model',
  'none',
];

const CACHE_POLICY_KEYS = [
  'continuity_mode',
  'target_cache_hit_rate',
  'minimum_cache_hit_rate',
  'enforce_cache_gate',
  'max_execution_models',
];

const PACKET_USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'cost_usd',
  'wall_seconds',
  'evidence_reference',
];

const isRate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isExecutionPacket = (packet: Packet | undefined): boolean =>
  Boolean(packet && !(packet.audit_sources && packet.audit_sources.length > 0));

export function normalizeCachePolicy(value?: unknown, limits?: PlanningLimitsInput): CachePolicy {
  if (value !== undefined) {
    check(
      isRecord(value) && Object.keys(value).every((key) => CACHE_POLICY_KEYS.includes(key)),
      'Unknown or invalid cache_policy fields',
    );
  }
  const raw = isRecord(value) ? value : {};
  const fromPolicy = raw.continuity_mode;
  const fromLimits = limits?.continuity_policy;
  if (fromPolicy !== undefined) {
    check(
      typeof fromPolicy === 'string' &&
        (CONTINUITY_MODES as readonly string[]).includes(fromPolicy),
      'continuity_mode must be sticky, prefer-single-model, strict-single-model or none',
    );
  }
  if (fromLimits !== undefined) {
    check(
      typeof fromLimits === 'string' &&
        (CONTINUITY_MODES as readonly string[]).includes(fromLimits),
      'continuity_policy must be sticky, prefer-single-model, strict-single-model or none',
    );
  }
  if (fromPolicy !== undefined && fromLimits !== undefined) {
    check(
      fromPolicy === fromLimits,
      'cache_policy.continuity_mode conflicts with planning_limits.continuity_policy',
    );
  }
  const continuity_mode = (fromPolicy ?? fromLimits ?? 'sticky') as ContinuityMode;
  const target = raw.target_cache_hit_rate ?? null;
  check(target === null || isRate(target), 'target_cache_hit_rate must be between 0 and 1');
  const minimum = raw.minimum_cache_hit_rate ?? null;
  check(minimum === null || isRate(minimum), 'minimum_cache_hit_rate must be between 0 and 1');
  if (target !== null && minimum !== null) {
    check(minimum <= target, 'minimum_cache_hit_rate cannot exceed target_cache_hit_rate');
  }
  const enforce = raw.enforce_cache_gate ?? false;
  check(typeof enforce === 'boolean', 'enforce_cache_gate must be boolean');
  if (enforce) {
    check(minimum !== null, 'enforce_cache_gate requires an explicit minimum_cache_hit_rate');
  }
  const defaultMaxModels =
    continuity_mode === 'prefer-single-model' || continuity_mode === 'strict-single-model'
      ? 1
      : null;
  const maxModels =
    raw.max_execution_models === undefined ? defaultMaxModels : raw.max_execution_models;
  check(
    maxModels === null ||
      (typeof maxModels === 'number' && Number.isSafeInteger(maxModels) && maxModels > 0),
    'max_execution_models must be a positive integer',
  );
  if (continuity_mode === 'strict-single-model') {
    check(maxModels === 1, 'strict-single-model requires max_execution_models to be 1');
  }
  return {
    continuity_mode,
    target_cache_hit_rate: target,
    minimum_cache_hit_rate: minimum,
    enforce_cache_gate: enforce,
    max_execution_models: maxModels,
  };
}

export function validatePacketUsage(value: unknown): PacketUsage {
  check(
    isRecord(value) &&
      Object.keys(value).every((key) => PACKET_USAGE_KEYS.includes(key)) &&
      Object.hasOwn(value, 'input_tokens') &&
      Object.hasOwn(value, 'output_tokens'),
    'Packet usage requires input_tokens and output_tokens with no unknown fields',
  );
  check(
    value.input_tokens === null || isTokenCount(value.input_tokens),
    'Packet usage input_tokens must be null or a nonnegative integer',
  );
  check(
    value.output_tokens === null || isTokenCount(value.output_tokens),
    'Packet usage output_tokens must be null or a nonnegative integer',
  );
  const cached = value.cached_input_tokens;
  if (cached !== undefined && cached !== null) {
    check(isTokenCount(cached), 'Packet usage cached_input_tokens must be a nonnegative integer');
    check(
      value.input_tokens !== null && cached <= value.input_tokens,
      'Cached input tokens cannot exceed input_tokens',
    );
  }
  if (value.cost_usd !== undefined && value.cost_usd !== null) {
    check(isNonNegativeFinite(value.cost_usd), 'Packet usage cost_usd must be nonnegative');
  }
  if (value.wall_seconds !== undefined && value.wall_seconds !== null) {
    check(isNonNegativeFinite(value.wall_seconds), 'Packet usage wall_seconds must be nonnegative');
  }
  if (value.evidence_reference !== undefined) {
    requireText(value.evidence_reference, 'Usage evidence reference');
  }
  return {
    input_tokens: value.input_tokens,
    ...(cached !== undefined ? { cached_input_tokens: cached } : {}),
    output_tokens: value.output_tokens,
    ...(value.cost_usd !== undefined ? { cost_usd: value.cost_usd } : {}),
    ...(value.wall_seconds !== undefined ? { wall_seconds: value.wall_seconds } : {}),
    ...(value.evidence_reference !== undefined
      ? { evidence_reference: value.evidence_reference }
      : {}),
  };
}

export interface CacheUsageSummary {
  observed_submissions: number;
  cache_observed_submissions: number;
  total_input_tokens: number;
  cache_observed_input_tokens: number;
  total_cached_input_tokens: number;
  total_output_tokens: number;
  observed_cache_hit_rate: number | null;
}

export type CacheContinuityStatus =
  | 'pending'
  | 'compliant'
  | 'unmeasured'
  | 'below-target'
  | 'non-compliant';

export interface CacheContinuityReview {
  continuity_mode: ContinuityMode;
  target_cache_hit_rate: number | null;
  minimum_cache_hit_rate: number | null;
  enforce_cache_gate: boolean;
  max_execution_models: number | null;
  execution_models: string[];
  execution_contexts: string[];
  context_reuses: number;
  model_switches: number;
  unjustified_model_switches: number;
  usage: CacheUsageSummary;
  status: CacheContinuityStatus;
  score: number | null;
  score_range: [number, number];
  tags: string[];
}

function switchJustified(run: Run, previousModel: string, packet: Packet): boolean {
  const rejectedPrior = Object.values(run.packets).some((item) =>
    item.history.some(
      (entry) =>
        entry.assignment?.model_id === previousModel && entry.review?.decision === 'rejected',
    ),
  );
  if (rejectedPrior) return true;
  if (!packet.source_work_id || !run.dispatch_plan?.routing_audit) return false;
  const audit = run.dispatch_plan.routing_audit.work.find(
    (entry) => entry.work_id === packet.source_work_id,
  );
  if (!audit) return false;
  const priorCandidates = audit.candidates.filter((item) => item.model_id === previousModel);
  return priorCandidates.length > 0 && priorCandidates.every((item) => item.outcome === 'excluded');
}

export function summarizeCacheAndContinuity(run: Run, complete: boolean): CacheContinuityReview {
  const policy = normalizeCachePolicy(run.cache_policy, run.planning_limits);
  const assignments = new Map<string, AssignmentInput>();
  const startedAttempts = new Set<string>();
  const seenContexts = new Set<string>();
  const executionModels: string[] = [];
  const executionContexts: string[] = [];
  let contextReuses = 0;
  let modelSwitches = 0;
  let unjustifiedSwitches = 0;
  let lastExecutionModel: string | null = null;

  let observedSubmissions = 0;
  let cacheObservedSubmissions = 0;
  let totalInputTokens = 0;
  let cacheObservedInputTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;

  for (const entry of run.journal) {
    const event = entry?.event;
    if (!event) continue;
    const key = JSON.stringify([event.packet_id, event.attempt]);
    const packet = run.packets[event.packet_id];
    if (event.type === 'assign') {
      assignments.set(key, event.assignment);
      continue;
    }
    if (event.type === 'start') {
      const assigned = assignments.get(key);
      if (assigned?.owner_context !== event.actor_context) continue;
      startedAttempts.add(key);
      if (seenContexts.has(assigned.owner_context)) contextReuses += 1;
      else seenContexts.add(assigned.owner_context);
      if (isExecutionPacket(packet)) {
        if (!executionContexts.includes(assigned.owner_context)) {
          executionContexts.push(assigned.owner_context);
        }
        if (isText(assigned.model_id)) {
          if (!executionModels.includes(assigned.model_id)) {
            executionModels.push(assigned.model_id);
          }
          if (lastExecutionModel !== null && assigned.model_id !== lastExecutionModel) {
            modelSwitches += 1;
            if (!switchJustified(run, lastExecutionModel, packet)) {
              unjustifiedSwitches += 1;
            }
          }
          lastExecutionModel = assigned.model_id;
        }
      }
      continue;
    }
    if (event.type === 'submit' && startedAttempts.has(key)) {
      const assigned = assignments.get(key);
      if (assigned?.owner_context !== event.actor_context || !event.usage) continue;
      const usage = event.usage;
      observedSubmissions += 1;
      if (usage.input_tokens !== null) totalInputTokens += usage.input_tokens;
      if (usage.output_tokens !== null) totalOutputTokens += usage.output_tokens;
      if (
        usage.input_tokens !== null &&
        usage.input_tokens > 0 &&
        usage.cached_input_tokens !== undefined &&
        usage.cached_input_tokens !== null
      ) {
        cacheObservedSubmissions += 1;
        cacheObservedInputTokens += usage.input_tokens;
        totalCachedTokens += usage.cached_input_tokens;
      }
    }
  }

  for (const packet of Object.values(run.packets)) {
    if (!isExecutionPacket(packet) || !packet.assignment) continue;
    if (!executionContexts.includes(packet.assignment.owner_context)) {
      executionContexts.push(packet.assignment.owner_context);
    }
    if (
      isText(packet.assignment.model_id) &&
      !executionModels.includes(packet.assignment.model_id)
    ) {
      executionModels.push(packet.assignment.model_id);
    }
  }

  const observedRate =
    cacheObservedInputTokens > 0
      ? Math.round((totalCachedTokens / cacheObservedInputTokens) * 10000) / 10000
      : null;

  const tags: string[] = [];
  if (unjustifiedSwitches > 0) tags.push('unjustified-model-switch');
  if (
    policy.max_execution_models !== null &&
    executionModels.length > policy.max_execution_models
  ) {
    tags.push('execution-model-limit-exceeded');
  }
  const expectsCacheMetric =
    policy.target_cache_hit_rate !== null ||
    policy.minimum_cache_hit_rate !== null ||
    policy.enforce_cache_gate;
  if (complete && expectsCacheMetric && observedRate === null) {
    tags.push('cache-usage-unmeasured');
  }
  if (
    policy.target_cache_hit_rate !== null &&
    observedRate !== null &&
    observedRate + 1e-9 < policy.target_cache_hit_rate
  ) {
    tags.push('cache-below-target');
  }
  if (
    policy.minimum_cache_hit_rate !== null &&
    observedRate !== null &&
    observedRate + 1e-9 < policy.minimum_cache_hit_rate
  ) {
    tags.push('cache-below-minimum');
  }

  let score: number | null = null;
  if (complete || tags.length > 0 || observedRate !== null || startedAttempts.size > 0) {
    let rawScore = 10;
    rawScore -= 3 * unjustifiedSwitches;
    if (
      policy.max_execution_models !== null &&
      executionModels.length > policy.max_execution_models
    ) {
      rawScore -= 3 * (executionModels.length - policy.max_execution_models);
    }
    if (
      policy.target_cache_hit_rate !== null &&
      observedRate !== null &&
      observedRate + 1e-9 < policy.target_cache_hit_rate
    ) {
      const shortfall =
        (policy.target_cache_hit_rate - observedRate) /
        Math.max(policy.target_cache_hit_rate, 0.01);
      rawScore -= Math.ceil(shortfall * 6);
    }
    if (tags.includes('cache-below-minimum')) rawScore = Math.min(rawScore, 3);
    if (tags.includes('cache-usage-unmeasured')) {
      rawScore = Math.min(rawScore, policy.enforce_cache_gate ? 1 : 4);
    }
    score = Math.max(1, Math.min(10, rawScore));
  }

  let status: CacheContinuityStatus = 'pending';
  if (complete) {
    if (
      tags.includes('cache-below-minimum') ||
      (policy.enforce_cache_gate && tags.includes('cache-usage-unmeasured')) ||
      (policy.continuity_mode === 'strict-single-model' &&
        tags.includes('execution-model-limit-exceeded'))
    ) {
      status = 'non-compliant';
    } else if (tags.includes('cache-usage-unmeasured')) {
      status = 'unmeasured';
    } else if (tags.length > 0) {
      status = 'below-target';
    } else {
      status = 'compliant';
    }
  }

  return {
    ...policy,
    execution_models: executionModels,
    execution_contexts: executionContexts,
    context_reuses: contextReuses,
    model_switches: modelSwitches,
    unjustified_model_switches: unjustifiedSwitches,
    usage: {
      observed_submissions: observedSubmissions,
      cache_observed_submissions: cacheObservedSubmissions,
      total_input_tokens: totalInputTokens,
      cache_observed_input_tokens: cacheObservedInputTokens,
      total_cached_input_tokens: totalCachedTokens,
      total_output_tokens: totalOutputTokens,
      observed_cache_hit_rate: observedRate,
    },
    status,
    score,
    score_range: [1, 10],
    tags,
  };
}

export function assertStrictContinuityAssignment(
  run: Run,
  packet: Packet,
  assignment: Partial<AssignmentInput>,
): void {
  const policy = normalizeCachePolicy(run.cache_policy, run.planning_limits);
  if (policy.continuity_mode !== 'strict-single-model' || !isExecutionPacket(packet)) return;
  check(
    isText(assignment.model_id),
    'Strict single-model continuity requires an explicit model_id on every execution assignment',
  );
  for (const other of Object.values(run.packets)) {
    if (other.id === packet.id || !isExecutionPacket(other)) continue;
    const boundModel = other.assignment?.model_id;
    if (isText(boundModel)) {
      check(
        boundModel === assignment.model_id,
        'Strict single-model continuity forbids switching execution models within a run',
      );
    }
  }
}

export function assertCacheReviewGate(run: Run, finalAcceptance: boolean): void {
  if (!finalAcceptance) return;
  const policy = normalizeCachePolicy(run.cache_policy, run.planning_limits);
  const summary = summarizeCacheAndContinuity(run, true);
  if (policy.continuity_mode === 'strict-single-model' && policy.max_execution_models !== null) {
    check(
      summary.execution_models.length <= policy.max_execution_models,
      'Strict single-model continuity forbids completing with multiple execution models',
    );
  }
  if (!policy.enforce_cache_gate) return;
  check(
    summary.usage.observed_cache_hit_rate !== null,
    'Cache review gate requires observed input_tokens and cached_input_tokens before final acceptance',
  );
  const minimum = policy.minimum_cache_hit_rate ?? 0;
  check(
    summary.usage.observed_cache_hit_rate + 1e-9 >= minimum,
    `Observed cache hit rate (${summary.usage.observed_cache_hit_rate}) is below minimum_cache_hit_rate (${minimum})`,
  );
}
