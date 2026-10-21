import type {
  Attribution,
  Difficulty,
  Dimension,
  Domain,
  EvaluationKind,
  Report,
  Skill,
  TaskType,
} from './contract.ts';

export type {
  Attribution,
  Difficulty,
  Dimension,
  Domain,
  EvaluationKind,
  Relationship,
  Report,
  Skill,
  TaskContext,
  TaskType,
  Usage,
} from './contract.ts';

/** Error carrying an HTTP-ish status (thrown by `assert`) or a Node error code. */
export interface StatusError extends Error {
  status?: number;
  code?: string;
}

export interface ReportRow {
  collection_id: string;
  report: Report;
}

export interface RegistryEntry {
  model_id: string;
  scores: Partial<Record<Dimension, number | null>>;
}

export interface Vote {
  score: number;
  weight: number;
  reviewer: string;
  report_id: string;
}

export interface TaskAggregate {
  score: number;
  spread: number;
  votes: Vote[];
}

export type Support =
  | 'unmeasured'
  | 'mixed-observations'
  | 'supported-peer-observations'
  | 'limited-observations';

export interface DimensionEstimate {
  score: number | null;
  samples: number;
  peers: number;
  support: Support;
  tasks: TaskAggregate[];
}

export interface GuidanceEntry {
  report_id: string;
  comment: string;
  example: string;
  guidance: string;
}

export interface Profile {
  model_id: string;
  evaluation_kind: EvaluationKind;
  domain: Domain;
  task_type: TaskType;
  difficulty: Difficulty;
  skill: Skill;
  effort: string;
  route: string;
  dimensions: Record<Dimension, DimensionEstimate>;
  capability_estimate: number | null;
  observed_cost_usd: number | null;
  observed_wall_seconds: number | null;
  guidance: GuidanceEntry[];
  meaning: string;
}

export interface OperationalNote {
  report_id: string;
  model: string;
  attribution: Attribution;
  guidance: string;
}

export interface Projection {
  profiles: Profile[];
  operational: OperationalNote[];
  records: number;
  weighting_basis: string;
}

export interface DispatchNeeds {
  skill: Skill;
  difficulty: Difficulty;
  task_type?: TaskType;
  domain?: Domain;
  dimensions?: Dimension[];
  minimum_score?: number;
  max_cost_usd?: number;
  max_wall_seconds?: number;
}

export interface Recommendation {
  recommended: Profile | null;
  eligible: Profile[];
  unknown_cost_or_speed: Profile[];
  strategy: string;
  cost_basis: string;
  automatic_execution: false;
}

export interface DisplayRow {
  model_id: string;
  route: string;
  effort: string;
  domain: Domain;
  task_type: TaskType;
  difficulty: Difficulty;
  evaluation_kind: EvaluationKind;
  tags: Skill[];
  dimensions: Record<Dimension, number | null>;
  display_score: number | null;
  cost_usd: number | null;
  wall_seconds: number | null;
  use: string;
}

export interface ClientRow {
  id: string;
  collection_id: string;
  model: string;
  public_key: string;
  enabled: number;
}

export interface ClientEnrollment {
  id: string;
  collection_id: string;
  model: string;
  public_key: string;
}

export interface DimensionDefinition {
  id: Dimension;
  name: string;
  evaluates: string;
}

export interface PublicBenchmark {
  name: string;
  value: string;
  conditions: string;
}

export interface PublicModel {
  model_id: string;
  coarse_assessment: string;
  source_title: string;
  source_url: string;
  source_type: string;
  benchmarks: PublicBenchmark[];
}

export interface PublicSnapshot {
  version: number;
  checked_on: string;
  purpose: string;
  models: PublicModel[];
}

export interface PublicReference extends PublicModel {
  checked_on: string;
  assessment_basis: string;
  dispatch_eligible: false;
}

export interface PublicReferences {
  checked_on: string;
  purpose: string;
  models: PublicReference[];
}

export type ProfileFilters = Partial<
  Record<
    'evaluation_kind' | 'route' | 'effort' | 'domain' | 'task_type' | 'difficulty' | 'skill',
    string
  >
>;

export interface ModelDetail {
  model_id: string;
  filters: ProfileFilters;
  contexts: DisplayRow[];
  profiles: Profile[];
  comments: GuidanceEntry[];
  radar: Record<Dimension, number | null>;
  radar_scope: string;
  public_reference: PublicReference | null;
  dimension_definitions: DimensionDefinition[];
}

export interface ProfilesResponse {
  total: number;
  offset: number;
  profiles: Profile[];
  operational: OperationalNote[];
  weighting_basis: string;
}

export interface RankingRow extends DisplayRow {
  public_reference: PublicReference | null;
}

export interface RankingsResponse {
  rows: RankingRow[];
  kind: string;
  purpose: string;
}
