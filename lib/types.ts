// Shapes of the documented host forms and of persisted run state.
//
// Host forms arrive as untrusted JSON written by an AI host, so every library entry point still
// validates at runtime. Input types describe what that validation accepts; normalized types
// describe what the library produces after validation.

import type { ImprovementInput, ImprovementPolicy } from '../packages/optimizer/src/contract.ts';
import type { DispatchPlan } from './planning.ts';
import type { TriageRecord } from './triage.ts';

export type Difficulty = 'routine' | 'standard' | 'complex';
export type EvidenceKind = 'local_work' | 'simulation';
export type CheckOutcome = 'pass' | 'fail' | 'unverified';
export type ReviewDecision = 'accepted' | 'rejected';
export type PacketStatus = 'pending' | 'running' | 'in_review' | 'blocked' | 'accepted';

// ---------------------------------------------------------------------------
// Supervision

export interface ReportingLine {
  subordinate_context: string;
  supervisor_context: string;
}

export interface Supervision {
  root_context: string;
  reporting_lines: ReportingLine[];
  acceptance_rule: string;
}

// ---------------------------------------------------------------------------
// Optional model participation (DEI)

export interface DeiInput {
  enabled: boolean;
  model_ids?: string[];
}

export interface DeiPolicy {
  enabled: boolean;
  model_ids: string[];
}

// ---------------------------------------------------------------------------
// Task-first briefs

export interface WorkItemInput {
  id: string;
  objective: string;
  task_type: string;
  difficulty: string;
  skills: string[];
  depends_on: string[];
  writes: string[];
  outputs: string[];
  acceptance: string[];
  inputs?: string[];
  audit_sources?: string[];
  required_tools?: string[];
  minimum_score?: number;
  dimensions?: string[];
  supervisor_context?: string;
}

export interface WorkItem extends WorkItemInput {
  difficulty: Difficulty;
  inputs: string[];
  audit_sources: string[];
  required_tools: string[];
  minimum_score: number;
  dimensions: string[];
}

export interface WorkGraph {
  items: WorkItem[];
  order: string[];
  terminal: string;
}

export interface PlanningLimitsInput {
  max_parallel?: number;
  max_workers?: number;
  parallel_cost_premium?: number;
  overhead_seconds?: number;
  overhead_cost_usd?: number;
  context_startup_seconds?: number;
  context_startup_cost_usd?: number;
  budget_usd?: number;
  deadline_seconds?: number;
  minimum_parallel_savings_seconds?: number;
  unproven_routes?: string;
  trial_estimate?: TrialEstimate;
  max_trial_assignments?: number;
}

// A host-declared estimate for routes that have no qualifying observations yet.
export interface TrialEstimate {
  wall_seconds: number;
  cost_usd: number;
}

export interface DimensionObservation {
  score: number;
  support: string;
}

export interface RouteProfile {
  model_id: string;
  route: string;
  effort: string;
  evaluation_kind: string;
  domain: string;
  task_type: string;
  difficulty: string;
  skill: string;
  dimensions?: Record<string, DimensionObservation>;
  observed_cost_usd?: number;
  observed_wall_seconds?: number;
}

export interface WorkerInput {
  id: string;
  model_id: string;
  route: string;
  effort?: string;
  model_family?: string;
  available?: boolean;
  tools_verified?: boolean;
  tools?: string[];
  context_id?: string;
  profiles?: RouteProfile[];
}

export interface FailureInput {
  work_id: string;
  worker_id: string;
  confirmed?: boolean;
  attribution?: string;
}

export interface RunLimits {
  max_parallel: number;
  max_attempts: number;
  max_dispatches: number;
}

export interface BriefInput {
  objective: string;
  domain: string;
  run_id?: string;
  lead_context?: string;
  acceptance?: string[];
  constraints?: string[];
  evidence_kind?: string;
  work_items?: WorkItemInput[];
  planning_limits?: PlanningLimitsInput;
  limits?: Partial<RunLimits>;
  workers?: WorkerInput[];
  failures?: FailureInput[];
  reporting_lines?: ReportingLine[];
  dei?: DeiInput;
  improvement?: ImprovementInput;
  intake_triage?: TriageResponse;
  external_inputs?: Record<string, unknown>;
  existing_assets?: unknown[];
  // Reference-template rehearsal fields.
  difficulty?: string;
  independent_streams?: number;
  product_discovery?: boolean;
  request_company?: boolean;
  reference_workflow?: boolean;
}

// ---------------------------------------------------------------------------
// Intake triage

export interface TriageAnswer {
  choice: string;
  confidence: number;
}

export interface TriageResponse {
  input_fingerprint: string;
  answers?: Record<string, TriageAnswer>;
  source?: { kind: string; model_id: string | null };
}

// ---------------------------------------------------------------------------
// Reference templates

export interface TemplateRole {
  id: string;
  purpose: string;
  [field: string]: unknown;
}

export interface TemplateStage {
  id: string;
  owner: string;
  contributors: string[];
  depends_on: string[];
  inputs: string[];
  outputs: string[];
  audits?: string[];
  gate: { reviewer: string; checks: string[]; rework_to: string };
}

export interface Template {
  id: string;
  root: string;
  roles: TemplateRole[];
  authority: unknown[];
  interactions: unknown[];
  workflow: { stages: TemplateStage[] };
}

// ---------------------------------------------------------------------------
// Persisted run state

export interface AssignmentInput {
  owner_context: string;
  reviewer_context: string;
  contributor_contexts: string[];
  writes: string[];
  supervisor_context?: string;
  worker_id?: string;
  model_id?: string;
  route?: string;
  effort?: string;
  fit_reason?: string;
}

export interface Assignment extends AssignmentInput {}

export interface ArtifactReference {
  id: string;
  reference: string;
  summary: string;
}

export interface EvidenceReference {
  reference: string;
  summary: string;
}

export interface CheckRecord {
  index: number;
  result: CheckOutcome;
  evidence_reference: string;
  note: string;
}

export interface PacketResult {
  outputs: ArtifactReference[];
  evidence: EvidenceReference[];
  attempt: number;
  reports_to?: string;
}

export interface PacketReview {
  reviewer_context: string;
  decision: ReviewDecision;
  checks: CheckRecord[];
  task_checks: CheckRecord[];
  attempt: number;
  agent_review?: unknown;
}

export interface PacketBlocker {
  reason: string;
  previous_status: PacketStatus;
}

export interface PacketAttempt {
  attempt: number;
  status: PacketStatus;
  assignment: Assignment | null;
  result: PacketResult | null;
  review: PacketReview | null;
  invalidated_by: string;
}

export interface Packet {
  id: string;
  role: string;
  contributor_roles: string[];
  reviewer_role: string;
  depends_on: string[];
  inputs: string[];
  required_outputs: string[];
  checks: string[];
  rework_to: string;
  audit_sources?: string[];
  objective: string;
  status: PacketStatus;
  attempt: number;
  assignment: Assignment | null;
  assignment_attempt?: number;
  result: PacketResult | null;
  review: PacketReview | null;
  blocker?: PacketBlocker | null;
  history: PacketAttempt[];
  // Task-first packets only.
  source_work_id?: string;
  task_type?: string;
  difficulty?: Difficulty;
  skills?: string[];
  required_tools?: string[];
  supervisor_context?: string;
  declared_writes?: string[];
  qualification?: 'qualified' | 'trial';
}

export interface Artifact extends ArtifactReference {
  producer: string;
  attempt: number;
}

interface EventBase {
  id: string;
  expected_revision: number;
  packet_id: string;
  attempt: number;
  actor_context: string;
}

export type AssignEvent = EventBase & {
  type: 'assign';
  assignment: AssignmentInput;
  objective?: string;
};
export type StartEvent = EventBase & { type: 'start' };
export type SubmitEvent = EventBase & {
  type: 'submit';
  outputs: ArtifactReference[];
  evidence: EvidenceReference[];
};
export type ReviewEvent = EventBase & {
  type: 'review';
  decision: ReviewDecision;
  checks: CheckRecord[];
  task_checks?: CheckRecord[];
};
export type ReasonEvent = EventBase & { type: 'block' | 'resume' | 'reopen'; reason: string };

export type WorkflowEvent = AssignEvent | StartEvent | SubmitEvent | ReviewEvent | ReasonEvent;
export type EventType = WorkflowEvent['type'];

// Later events of a batch may omit expected_revision; the controller fills it in order.
type WithOptionalRevision<T> = T extends unknown
  ? Omit<T, 'expected_revision'> & { expected_revision?: number }
  : never;
export type BatchEvent = WithOptionalRevision<WorkflowEvent>;

export interface JournalEntry {
  revision: number;
  recorded_at?: string;
  event: WorkflowEvent;
}

export interface RunOrganization {
  root: string;
  roles: unknown[];
  authority: unknown[];
  interactions: unknown[];
  separate_management_agent_required?: boolean;
}

export interface Run {
  schema_version: 1 | 2;
  run_id: string;
  template_id: string;
  mode: 'compact' | 'company';
  objective: string;
  domain?: string;
  acceptance: string[];
  constraints: string[];
  lead_context: string;
  evidence_kind: EvidenceKind;
  limits: RunLimits;
  organization: RunOrganization;
  external_inputs: Record<string, unknown>;
  revision: number;
  dispatches: number;
  packets: Record<string, Packet>;
  artifacts: Record<string, Artifact>;
  journal: JournalEntry[];
  // Task-first runs only.
  intake_triage?: TriageRecord | null;
  dei?: DeiPolicy;
  improvement?: ImprovementPolicy;
  planning_limits?: PlanningLimitsInput;
  supervision?: Supervision;
  dispatch_plan?: DispatchPlan | null;
  bound_execution_contexts?: Record<string, string>;
  routing_status?: string;
}
