import { createHash } from 'node:crypto';
import { normalizeImprovement } from './learning.ts';
import { normalizeDei } from './participation.ts';
import { normalizeWrites, planWork, scopesConflict, validateWorkGraph } from './planning.ts';
import type {
  BriefInput,
  PlanningLimitsInput,
  PresetBinding,
  RunLimits,
  WorkGraph,
  WorkItemInput,
} from './types.ts';
import { check, isRecord, requireText, requireUniqueTexts } from './validate.ts';

const EXCEPTIONS = [
  'missing-tool',
  'unqualified-model',
  'unknown-budget',
  'review-rejected',
  'interrupted',
  'changed-scope',
] as const;
const SCALES = ['micro', 'small', 'multi-stream', 'large'] as const;
type ExceptionId = (typeof EXCEPTIONS)[number];
type StageKind = 'scope' | 'delivery' | 'integration' | 'review' | 'handover';

export interface PresetSource {
  id: string;
  url: string;
  reviewed_on: string;
  adoption: string;
  transfer_limits: string;
}
export interface PresetVariant {
  id: string;
  topology: 'coherent-owner' | 'parallel-components';
  components: number;
  integration: 'none' | 'required';
  max_workers: number;
  max_parallel: number;
  max_attempts: number;
  max_dispatches: number;
  reason: string;
}
export interface PresetException {
  id: ExceptionId;
  owner: 'direct-supervisor';
  action: 'block' | 'replan' | 'return-to-owner' | 'reopen-affected';
  required_evidence: string[];
  resolution: string;
}
export interface WorkflowPreset {
  schema_version: 1;
  id: string;
  revision: string;
  name: string;
  family: string;
  domain: 'software-engineering';
  maturity: 'structurally-validated';
  sources: PresetSource[];
  applicability: {
    outcomes: string[];
    risks: string[];
    exclusions: string[];
    required_inputs: string[];
  };
  organization: {
    root: 'existing-host';
    acceptance: 'direct-supervisor';
    producer_review: 'separate-context';
    extra_manager: false;
    responsibilities: string[];
  };
  variants: PresetVariant[];
  scale_coverage: Record<string, { variant?: string; excluded_reason?: string }>;
  stages: {
    id: StageKind;
    owner: 'producer' | 'direct-supervisor';
    entry: string;
    outputs: string;
    exit_evidence: string;
  }[];
  exceptions: PresetException[];
  resources: {
    qualification: 'existing-route-planner';
    unknown_budget: 'needs-evidence';
    trials: 'explicit-opt-in';
    overhead: string;
  };
  topology: { supported: ['single-agency']; federation: string };
  verification: {
    examples: string[];
    checks: string[];
    evidence_level: 'structural-and-simulation';
    real_task_validated: false;
    limitations: string[];
  };
}

export type PresetComponent = Omit<
  WorkItemInput,
  'depends_on' | 'audit_sources' | 'supervisor_context'
>;
export interface PresetRequest {
  run_id: string;
  objective: string;
  family: string;
  outcome: string;
  risk: string;
  lead_context: string;
  acceptance: string[];
  constraints: string[];
  components: PresetComponent[];
  integration?: PresetComponent;
  parallel_reason?: string;
  execution_topology?: string;
  evidence_kind?: BriefInput['evidence_kind'];
  external_inputs?: BriefInput['external_inputs'];
  existing_assets?: BriefInput['existing_assets'];
  workers?: BriefInput['workers'];
  planning_limits?: PlanningLimitsInput;
  limits?: Partial<RunLimits>;
  dei?: BriefInput['dei'];
  improvement?: BriefInput['improvement'];
  intake_triage?: BriefInput['intake_triage'];
}

function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  check(isRecord(value), 'Expected a preset object');
  check(
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    'Unknown preset field',
  );
  check(
    required.every((key) => Object.hasOwn(value, key)),
    'Missing required preset field',
  );
}
function texts(value: unknown, name: string, nonempty = true): string[] {
  const result = requireUniqueTexts(value, name);
  check(!nonempty || result.length > 0, `${name} must not be empty`);
  return result;
}
function identifier(value: unknown): asserts value is string {
  check(
    typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value),
    'Invalid preset identifier',
  );
}
function positive(value: unknown): asserts value is number {
  check(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    'Preset limits must be positive integers',
  );
}

export function validatePreset(value: unknown): WorkflowPreset {
  fields(value, [
    'schema_version',
    'id',
    'revision',
    'name',
    'family',
    'domain',
    'maturity',
    'sources',
    'applicability',
    'organization',
    'variants',
    'scale_coverage',
    'stages',
    'exceptions',
    'resources',
    'topology',
    'verification',
  ]);
  check(
    value.schema_version === 1 &&
      value.domain === 'software-engineering' &&
      value.maturity === 'structurally-validated',
    'Unsupported preset schema, domain or maturity',
  );
  identifier(value.id);
  identifier(value.family);
  requireText(value.name, 'Preset name');
  check(
    typeof value.revision === 'string' && /^\d+\.\d+\.\d+$/.test(value.revision),
    'Use a versioned preset revision',
  );
  check(
    Array.isArray(value.sources) && value.sources.length > 0,
    'A preset needs reviewed sources',
  );
  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    fields(source, ['id', 'url', 'reviewed_on', 'adoption', 'transfer_limits']);
    identifier(source.id);
    check(!sourceIds.has(source.id), 'Duplicate source');
    sourceIds.add(source.id);
    requireText(source.url, 'Source URL');
    const url = new URL(source.url);
    check(
      url.protocol === 'https:' && !url.username && !url.password,
      'Use a public HTTPS source URL',
    );
    check(
      typeof source.reviewed_on === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(source.reviewed_on) &&
        !Number.isNaN(Date.parse(source.reviewed_on)) &&
        new Date(source.reviewed_on).toISOString().slice(0, 10) === source.reviewed_on,
      'Invalid source review date',
    );
    requireText(source.adoption, 'Source adoption');
    requireText(source.transfer_limits, 'Source transfer limits');
  }
  fields(value.applicability, ['outcomes', 'risks', 'exclusions', 'required_inputs']);
  for (const key of ['outcomes', 'risks', 'exclusions', 'required_inputs'])
    texts(value.applicability[key], `Applicability ${key}`);
  fields(value.organization, [
    'root',
    'acceptance',
    'producer_review',
    'extra_manager',
    'responsibilities',
  ]);
  check(
    value.organization.root === 'existing-host' &&
      value.organization.acceptance === 'direct-supervisor' &&
      value.organization.producer_review === 'separate-context' &&
      value.organization.extra_manager === false,
    'Preserve the existing supervisor and independent upward acceptance',
  );
  texts(value.organization.responsibilities, 'Responsibilities');
  check(
    Array.isArray(value.variants) && value.variants.length > 0,
    'A preset needs executable variants',
  );
  const variants = new Map<string, PresetVariant>();
  const counts = new Set<unknown>();
  for (const variant of value.variants) {
    fields(variant, [
      'id',
      'topology',
      'components',
      'integration',
      'max_workers',
      'max_parallel',
      'max_attempts',
      'max_dispatches',
      'reason',
    ]);
    identifier(variant.id);
    check(!variants.has(variant.id), 'Duplicate preset variant');
    check(!counts.has(variant.components), 'Ambiguous component count across variants');
    counts.add(variant.components);
    for (const key of [
      'components',
      'max_workers',
      'max_parallel',
      'max_attempts',
      'max_dispatches',
    ])
      positive(variant[key]);
    requireText(variant.reason, 'Variant reason');
    const single =
      variant.topology === 'coherent-owner' &&
      variant.components === 1 &&
      variant.integration === 'none' &&
      variant.max_workers === 1 &&
      variant.max_parallel === 1;
    const parallel =
      variant.topology === 'parallel-components' &&
      variant.components === 2 &&
      variant.integration === 'required' &&
      variant.max_workers === 2 &&
      variant.max_parallel === 2;
    check(single || parallel, 'Unsupported bounded-work topology or staffing inflation');
    check(
      (variant.max_attempts as number) <= 2 &&
        (variant.max_dispatches as number) <=
          ((variant.components as number) + (parallel ? 1 : 0)) * (variant.max_attempts as number),
      'Preset retry/dispatch ceilings exceed the bounded work',
    );
    variants.set(variant.id, variant as unknown as PresetVariant);
  }
  fields(value.scale_coverage, [...SCALES]);
  for (const [scale, coverage] of Object.entries(value.scale_coverage)) {
    fields(coverage, [], ['variant', 'excluded_reason']);
    check(
      (coverage.variant !== undefined) !== (coverage.excluded_reason !== undefined),
      'Declare a supported variant or a scale exclusion',
    );
    if (coverage.variant !== undefined) {
      requireText(coverage.variant, 'Scale variant');
      check(variants.has(coverage.variant), 'Scale refers to an unknown variant');
      check(
        (scale === 'micro' && variants.get(coverage.variant)?.components === 1) ||
          (scale === 'small' && variants.get(coverage.variant)?.components === 2),
        'Scale is incompatible with its bounded-work variant',
      );
    } else requireText(coverage.excluded_reason, 'Scale exclusion');
  }
  check(Array.isArray(value.stages), 'Supply operating stages');
  const stages = new Set<string>();
  for (const stage of value.stages) {
    fields(stage, ['id', 'owner', 'entry', 'outputs', 'exit_evidence']);
    requireText(stage.id, 'Stage ID');
    check(!stages.has(stage.id), 'Duplicate stage');
    stages.add(stage.id);
    const owner = ['delivery', 'integration'].includes(stage.id) ? 'producer' : 'direct-supervisor';
    check(stage.owner === owner, 'Stage ownership must preserve direct-supervisor review');
    for (const key of ['entry', 'outputs', 'exit_evidence'])
      requireText(stage[key], `Stage ${key}`);
  }
  check(
    stages.size === 5 &&
      ['scope', 'delivery', 'integration', 'review', 'handover'].every((id) => stages.has(id)),
    'Cover scope, delivery, integration, review and handover',
  );
  check(Array.isArray(value.exceptions), 'Supply exception paths');
  const exceptions = new Set<string>();
  for (const exception of value.exceptions) {
    fields(exception, ['id', 'owner', 'action', 'required_evidence', 'resolution']);
    requireText(exception.id, 'Exception ID');
    check(!exceptions.has(exception.id), 'Duplicate exception');
    exceptions.add(exception.id);
    const action =
      exception.id === 'review-rejected'
        ? 'return-to-owner'
        : exception.id === 'changed-scope'
          ? 'reopen-affected'
          : ['unknown-budget', 'unqualified-model'].includes(exception.id)
            ? 'replan'
            : 'block';
    check(
      exception.owner === 'direct-supervisor' && exception.action === action,
      'Exception owner or correction path is invalid',
    );
    texts(exception.required_evidence, 'Exception evidence');
    requireText(exception.resolution, 'Exception resolution');
  }
  check(
    exceptions.size === EXCEPTIONS.length && EXCEPTIONS.every((id) => exceptions.has(id)),
    'Every required failure and recovery path must be covered',
  );
  fields(value.resources, ['qualification', 'unknown_budget', 'trials', 'overhead']);
  check(
    value.resources.qualification === 'existing-route-planner' &&
      value.resources.unknown_budget === 'needs-evidence' &&
      value.resources.trials === 'explicit-opt-in',
    'Preserve model qualification and unknown budget semantics',
  );
  requireText(value.resources.overhead, 'Resource overhead basis');
  fields(value.topology, ['supported', 'federation']);
  check(
    JSON.stringify(value.topology.supported) === '["single-agency"]',
    'This schema supports bounded single-agency execution',
  );
  requireText(value.topology.federation, 'Federation boundary');
  fields(value.verification, [
    'examples',
    'checks',
    'evidence_level',
    'real_task_validated',
    'limitations',
  ]);
  for (const key of ['examples', 'checks', 'limitations'])
    texts(value.verification[key], `Verification ${key}`);
  check(
    (value.verification.examples as string[]).every((example) =>
      /^examples\/presets\/[a-z][a-z0-9-]*\.json$/.test(example),
    ),
    'Preset examples must be bounded repository fixture paths',
  );
  check(
    value.verification.evidence_level === 'structural-and-simulation' &&
      value.verification.real_task_validated === false,
    'A structural preset must not claim real-task validation',
  );
  return structuredClone(value) as unknown as WorkflowPreset;
}

export function validatePresetRegistry(value: unknown): string[] {
  fields(value, ['schema_version', 'presets']);
  check(value.schema_version === 1, 'Unsupported preset registry version');
  const ids = texts(value.presets, 'Preset registry');
  ids.forEach(identifier);
  return ids;
}

export function validatePresetBinding(value: unknown): PresetBinding {
  fields(value, ['id', 'revision', 'variant', 'topology', 'contract_hash']);
  identifier(value.id);
  identifier(value.variant);
  check(
    typeof value.revision === 'string' && /^\d+\.\d+\.\d+$/.test(value.revision),
    'Invalid preset binding revision',
  );
  check(
    typeof value.contract_hash === 'string' && /^[a-f0-9]{64}$/.test(value.contract_hash),
    'Invalid preset contract hash',
  );
  check(
    value.topology === 'coherent-owner' || value.topology === 'parallel-components',
    'Unknown bound preset topology',
  );
  return {
    id: value.id,
    revision: value.revision,
    variant: value.variant,
    topology: value.topology,
    contract_hash: value.contract_hash,
  };
}

export function assertPresetBrief(brief: BriefInput, graph: WorkGraph, limits: RunLimits): void {
  if (brief.preset === undefined) return;
  const binding = validatePresetBinding(brief.preset);
  const ceiling = binding.topology === 'coherent-owner' ? 1 : 2;
  const pool = brief.planning_limits?.max_workers;
  check(
    typeof pool === 'number' &&
      Number.isSafeInteger(pool) &&
      pool > 0 &&
      pool <= ceiling &&
      limits.max_parallel <= pool &&
      limits.max_attempts <= 2 &&
      limits.max_dispatches <= (ceiling === 1 ? 2 : 6),
    'Expanded preset limits cannot exceed their bounded topology',
  );
  check(
    graph.items.every(
      (item) => (item.supervisor_context ?? brief.lead_context) === brief.lead_context,
    ) &&
      (brief.reporting_lines ?? []).length <= pool &&
      (brief.reporting_lines ?? []).every((line) => line.supervisor_context === brief.lead_context),
    'Expanded preset cannot insert additional supervisor layers',
  );
  if (ceiling === 1)
    check(graph.items.length === 1, 'Coherent-owner preset must contain one delivery');
  else {
    const components = graph.items.filter((item) => item.id !== graph.terminal);
    const terminal = graph.items.find((item) => item.id === graph.terminal);
    check(
      graph.items.length === 3 &&
        components.every((item) => item.depends_on.length === 0) &&
        terminal?.depends_on.length === 2 &&
        components.every((item) => terminal.depends_on.includes(item.id)) &&
        !scopesConflict(components[0].writes, components[1].writes),
      'Parallel preset needs two independent components and one integrated terminal delivery',
    );
  }
}

function requestOf(value: unknown): PresetRequest {
  fields(
    value,
    [
      'run_id',
      'objective',
      'family',
      'outcome',
      'risk',
      'lead_context',
      'acceptance',
      'constraints',
      'components',
    ],
    [
      'integration',
      'parallel_reason',
      'execution_topology',
      'evidence_kind',
      'external_inputs',
      'existing_assets',
      'workers',
      'planning_limits',
      'limits',
      'dei',
      'improvement',
      'intake_triage',
    ],
  );
  for (const key of ['run_id', 'objective', 'family', 'outcome', 'risk', 'lead_context'])
    requireText(value[key], `Request ${key}`);
  texts(value.acceptance, 'Final acceptance');
  texts(value.constraints, 'Constraints', false);
  check(
    Array.isArray(value.components) && value.components.length > 0,
    'Declare coherent deliverable components before staffing',
  );
  for (const item of [
    ...value.components,
    ...(value.integration === undefined ? [] : [value.integration]),
  ]) {
    fields(
      item,
      ['id', 'objective', 'task_type', 'difficulty', 'skills', 'writes', 'outputs', 'acceptance'],
      ['inputs', 'required_tools', 'minimum_score', 'dimensions'],
    );
    for (const key of ['id', 'objective', 'task_type']) requireText(item[key], `Component ${key}`);
    check(
      ['routine', 'standard', 'complex'].includes(String(item.difficulty)),
      'Declare each component difficulty',
    );
    for (const key of ['skills', 'outputs', 'acceptance']) texts(item[key], `Component ${key}`);
    normalizeWrites(item.writes as string[]);
    if (item.inputs !== undefined) texts(item.inputs, 'Inputs', false);
    if (item.required_tools !== undefined) texts(item.required_tools, 'Tools', false);
  }
  if (value.parallel_reason !== undefined)
    requireText(value.parallel_reason, 'Parallel-work reason');
  if (value.execution_topology !== undefined)
    requireText(value.execution_topology, 'Execution topology');
  check(
    value.evidence_kind === undefined ||
      ['local_work', 'simulation'].includes(String(value.evidence_kind)),
    'Invalid preset evidence kind',
  );
  check(
    value.external_inputs === undefined || isRecord(value.external_inputs),
    'External inputs must be an object',
  );
  check(
    value.existing_assets === undefined || Array.isArray(value.existing_assets),
    'Existing assets must be an array',
  );
  check(value.workers === undefined || Array.isArray(value.workers), 'Workers must be an array');
  if (value.planning_limits !== undefined) {
    fields(
      value.planning_limits,
      [],
      [
        'max_parallel',
        'max_workers',
        'parallel_cost_premium',
        'overhead_seconds',
        'overhead_cost_usd',
        'context_startup_seconds',
        'context_startup_cost_usd',
        'budget_usd',
        'deadline_seconds',
        'minimum_parallel_savings_seconds',
        'unproven_routes',
        'trial_estimate',
        'max_trial_assignments',
      ],
    );
    for (const [key, limit] of Object.entries(value.planning_limits)) {
      if (['max_parallel', 'max_workers', 'max_trial_assignments'].includes(key)) positive(limit);
      else if (key === 'unproven_routes')
        check(limit === 'refuse' || limit === 'trial', 'Unknown unproven-route policy');
      else if (key === 'trial_estimate') {
        fields(limit, ['wall_seconds', 'cost_usd']);
        check(
          typeof limit.wall_seconds === 'number' &&
            Number.isFinite(limit.wall_seconds) &&
            limit.wall_seconds > 0 &&
            typeof limit.cost_usd === 'number' &&
            Number.isFinite(limit.cost_usd) &&
            limit.cost_usd >= 0,
          'Invalid bounded trial estimate',
        );
      } else
        check(
          typeof limit === 'number' && Number.isFinite(limit) && limit >= 0,
          'Invalid planning estimate or bound',
        );
    }
  }
  if (value.limits !== undefined) {
    fields(value.limits, [], ['max_parallel', 'max_attempts', 'max_dispatches']);
    Object.values(value.limits).forEach(positive);
  }
  normalizeDei(value.dei);
  normalizeImprovement(value.improvement);
  return structuredClone(value) as unknown as PresetRequest;
}

export function listPresets(values: readonly unknown[]) {
  return values.map(validatePreset).map((preset) => ({
    id: preset.id,
    revision: preset.revision,
    name: preset.name,
    family: preset.family,
    maturity: preset.maturity,
    variants: preset.variants.map((variant) => ({
      id: variant.id,
      topology: variant.topology,
      max_workers: variant.max_workers,
    })),
    applicability: preset.applicability,
    scale_coverage: preset.scale_coverage,
  }));
}

function selectionReasons(preset: WorkflowPreset, request: PresetRequest): string[] {
  const reasons: string[] = [];
  if (request.family !== preset.family) reasons.push('project-family-outside-preset');
  if (!preset.applicability.outcomes.includes(request.outcome))
    reasons.push('outcome-outside-preset');
  if (!preset.applicability.risks.includes(request.risk))
    reasons.push('risk-needs-a-reviewed-specialist-workflow');
  if ((request.execution_topology ?? 'single-agency') !== 'single-agency')
    reasons.push('use-the-federation-contract-before-cross-client-dispatch');
  if (!preset.variants.some((variant) => variant.components === request.components.length))
    reasons.push('component-count-outside-declared-scale');
  if (request.components.length === 1 && request.integration)
    reasons.push('merge-coherent-work-instead-of-adding-a-handover-job');
  if (request.components.length === 2) {
    if (!request.integration)
      reasons.push('parallel-work-needs-an-integrated-terminal-deliverable');
    if (!request.parallel_reason)
      reasons.push('explain-why-the-two-components-can-be-done-independently');
    if (
      scopesConflict(
        normalizeWrites(request.components[0].writes),
        normalizeWrites(request.components[1].writes),
      )
    )
      reasons.push('overlapping-component-writes-need-a-coherent-owner-or-a-revised-split');
    if (
      request.components.some((component, index) =>
        (component.inputs ?? []).some((input) =>
          request.components[1 - index].outputs.includes(input),
        ),
      )
    )
      reasons.push('dependent-components-need-a-coherent-owner-or-a-different-workflow');
  }
  return reasons;
}

export function selectPreset(values: readonly unknown[], input: unknown) {
  const request = requestOf(input);
  const candidates = values
    .map(validatePreset)
    .map((preset) => ({ preset, reasons: selectionReasons(preset, request) }));
  const matched = candidates.filter((item) => item.reasons.length === 0);
  if (matched.length !== 1)
    return {
      status: matched.length ? ('ambiguous' as const) : ('no-match' as const),
      candidates: candidates.map((item) => ({ id: item.preset.id, reasons: item.reasons })),
      automatic_execution: false as const,
    };
  const preset = matched[0].preset;
  const variant = preset.variants.find((item) => item.components === request.components.length);
  check(variant, 'No matching variant');
  return {
    status: 'selected' as const,
    preset_id: preset.id,
    revision: preset.revision,
    variant: variant.id,
    reason: variant.reason,
    automatic_execution: false as const,
  };
}

export function expandPreset(value: unknown, input: unknown) {
  const preset = validatePreset(value);
  const request = requestOf(input);
  const selection = selectPreset([preset], request);
  check(
    selection.status === 'selected',
    `Preset does not apply: ${selection.status === 'no-match' ? selection.candidates.flatMap((item) => item.reasons).join(', ') : selection.status}`,
  );
  const variant = preset.variants.find((item) => item.id === selection.variant);
  check(variant, 'Unknown selected variant');
  const items: WorkItemInput[] = request.components.map((item) => ({
    ...item,
    depends_on: [],
    inputs: item.inputs ?? ['task_brief'],
    supervisor_context: request.lead_context,
  }));
  if (variant.integration === 'required') {
    check(request.integration, 'An integration contract is required');
    items.push({
      ...request.integration,
      depends_on: items.map((item) => item.id),
      inputs: [
        ...new Set([
          'task_brief',
          ...items.flatMap((item) => item.outputs),
          ...(request.integration.inputs ?? []),
        ]),
      ],
      supervisor_context: request.lead_context,
    });
  }
  const external = new Set([
    'task_brief',
    'constraints',
    'existing_assets',
    ...Object.keys(request.external_inputs ?? {}),
  ]);
  check(
    !items.some((item) => item.outputs.some((output) => external.has(output))),
    'A produced artifact cannot overwrite an external input identifier',
  );
  const maximumWorkers = Math.min(
    variant.max_workers,
    request.planning_limits?.max_workers ?? variant.max_workers,
  );
  const maximumParallel = Math.min(
    variant.max_parallel,
    maximumWorkers,
    request.planning_limits?.max_parallel ?? variant.max_parallel,
    request.limits?.max_parallel ?? variant.max_parallel,
  );
  const contractHash = createHash('sha256').update(JSON.stringify(preset)).digest('hex');
  const brief: BriefInput = {
    run_id: request.run_id,
    objective: request.objective,
    domain: preset.domain,
    lead_context: request.lead_context,
    acceptance: request.acceptance,
    constraints: request.constraints,
    evidence_kind: request.evidence_kind ?? 'local_work',
    work_items: items,
    planning_limits: {
      ...request.planning_limits,
      max_workers: maximumWorkers,
      max_parallel: maximumParallel,
    },
    limits: {
      max_attempts: Math.min(
        variant.max_attempts,
        request.limits?.max_attempts ?? variant.max_attempts,
      ),
      max_dispatches: Math.min(
        variant.max_dispatches,
        request.limits?.max_dispatches ?? variant.max_dispatches,
      ),
    },
    preset: {
      id: preset.id,
      revision: preset.revision,
      variant: variant.id,
      topology: variant.topology,
      contract_hash: contractHash,
    },
    ...(request.external_inputs ? { external_inputs: request.external_inputs } : {}),
    ...(request.existing_assets ? { existing_assets: request.existing_assets } : {}),
    ...(request.workers ? { workers: request.workers } : {}),
    ...(request.dei ? { dei: request.dei } : {}),
    ...(request.improvement ? { improvement: request.improvement } : {}),
    ...(request.intake_triage ? { intake_triage: request.intake_triage } : {}),
  };
  validateWorkGraph(brief);
  const plan = request.workers ? planWork(brief, request.workers) : null;
  const constrained =
    request.planning_limits?.budget_usd !== undefined ||
    request.planning_limits?.deadline_seconds !== undefined;
  const readiness = plan
    ? plan.status
    : constrained
      ? 'needs-evidence'
      : 'requires-host-qualification';
  return {
    status: 'draft' as const,
    selection,
    brief,
    dispatch_readiness: readiness,
    dispatch_plan: plan,
    staffing: {
      existing_supervisor: request.lead_context,
      additional_managers: 0,
      execution_pool_ceiling: maximumWorkers,
      planned_execution_contexts: plan?.organization?.length ?? null,
      max_parallel: maximumParallel,
      reason: request.parallel_reason ?? variant.reason,
      reuse:
        'Integration reuses a qualified member of the bounded execution pool. A failed owner may be replaced after reassessment; history is retained.',
    },
    operating_stages: preset.stages,
    exception_paths: preset.exceptions,
    source_ids: preset.sources.map((source) => source.id),
    boundary:
      'This is a versioned draft work graph. The host binds actual qualified routes, inspects evidence and enforces permissions. Missing cost, capability or stopped-execution evidence is not a successful dispatch. Stages do not imply additional agents.',
    automatic_execution: false as const,
  };
}
