import type { DimensionObservation, RouteProfile, WorkerInput } from './types.ts';
import { check, isRecord, isText } from './validate.ts';

export type HostRoute = Omit<WorkerInput, 'profiles'>;

export interface HostInventory {
  complete: boolean;
  routes: HostRoute[];
}

export interface ExternalEvidence {
  model_id: string;
  route: string;
  effort: string;
  task: { domain: string; task_type: string; difficulty: string; skill: string };
  source: { url: string; title: string; published_at?: string; accessed_at: string };
  assessment: {
    kind: 'qualitative' | 'ordinal';
    summary: string;
    trial_fit?: 'supports' | 'unknown' | 'opposes';
    ordinal?: { value: number; scale_min: number; scale_max: number };
  };
  estimates?: {
    kind: 'unobserved_estimate';
    cost_usd?: number;
    wall_seconds?: number;
    basis: string;
  };
}

export type EvaluatorSnapshot =
  | { status: 'available'; profiles: unknown[]; total: number }
  | { status: 'unavailable' | 'invalid_response' | 'not_requested'; reason: string };

export interface WorkerCatalog {
  inventory_status: 'complete' | 'incomplete';
  inventory_unknown_fields: Array<{ worker_id: string; fields: string[] }>;
  evaluator: {
    status: EvaluatorSnapshot['status'];
    data_quality: 'complete' | 'partial' | 'unknown';
    received: number;
    accepted: number;
    rejected: number;
    reason?: string;
  };
  workers: WorkerInput[];
  historical: {
    status: EvaluatorSnapshot['status'];
    received: number;
    accepted: number;
    rejected: number;
    reason?: string;
  };
  historical_evidence: Array<{
    use: 'advisory_only';
    profile: RouteProfile;
    matching_worker_ids: string[];
  }>;
  external_evidence: Array<{
    use: 'advisory_only';
    evidence: ExternalEvidence;
    matching_worker_ids: string[];
  }>;
  rejected_external_evidence: number;
  incomplete_external_evidence: Array<{ use: 'advisory_only'; evidence: unknown; reason: string }>;
}

const supports = new Set([
  'unmeasured',
  'limited-observations',
  'mixed-observations',
  'supported-peer-observations',
]);
const dimensions = new Set(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
const validNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validDate = (value: unknown) => isText(value) && Number.isFinite(Date.parse(value));

function routeCopy(raw: unknown): HostRoute {
  check(isRecord(raw), 'Inventory route must be an object');
  for (const key of ['id', 'model_id', 'route'])
    check(isText(raw[key]), `Inventory ${key} must be nonempty`);
  check(!Object.hasOwn(raw, 'profiles'), 'Inventory routes must not supply evaluator profiles');
  for (const key of ['effort', 'model_family', 'context_id'])
    check(
      raw[key] === undefined || isText(raw[key]),
      `Inventory ${key} must be nonempty if supplied`,
    );
  for (const key of ['available', 'tools_verified'])
    check(
      raw[key] === undefined || typeof raw[key] === 'boolean',
      `Inventory ${key} must be boolean if supplied`,
    );
  check(
    raw.tools === undefined || (Array.isArray(raw.tools) && raw.tools.every(isText)),
    'Inventory tools must be an array of nonempty strings',
  );
  return {
    id: raw.id as string,
    model_id: raw.model_id as string,
    route: raw.route as string,
    ...(raw.effort === undefined ? {} : { effort: raw.effort as string }),
    ...(raw.model_family === undefined ? {} : { model_family: raw.model_family as string }),
    ...(raw.context_id === undefined ? {} : { context_id: raw.context_id as string }),
    ...(raw.available === undefined ? {} : { available: raw.available as boolean }),
    ...(raw.tools_verified === undefined ? {} : { tools_verified: raw.tools_verified as boolean }),
    ...(raw.tools === undefined ? {} : { tools: [...(raw.tools as string[])] }),
  };
}

function profileCopy(
  raw: unknown,
  kind: 'local_work' | 'historical_summary' = 'local_work',
): RouteProfile | null {
  if (!isRecord(raw) || raw.evaluation_kind !== kind) return null;
  for (const key of ['model_id', 'route', 'effort', 'domain', 'task_type', 'difficulty', 'skill'])
    if (!isText(raw[key])) return null;
  if (!['routine', 'standard', 'complex'].includes(raw.difficulty as string)) return null;
  if (!isRecord(raw.dimensions)) return null;
  if (Object.keys(raw.dimensions).length !== dimensions.size) return null;
  const outputDimensions: Record<string, DimensionObservation> = {};
  for (const [key, value] of Object.entries(raw.dimensions)) {
    if (!dimensions.has(key) || !isRecord(value) || !supports.has(String(value.support)))
      return null;
    if (
      !Number.isSafeInteger(value.samples) ||
      (value.samples as number) < 0 ||
      !Number.isSafeInteger(value.peers) ||
      (value.peers as number) < 0 ||
      !Array.isArray(value.tasks) ||
      value.tasks.length !== value.samples
    )
      return null;
    if (value.score === null) {
      if (value.support !== 'unmeasured' || value.samples !== 0 || value.peers !== 0) return null;
      continue;
    }
    if (!validNumber(value.score) || (value.score as number) > 10) return null;
    if (value.support === 'unmeasured' || value.samples === 0 || value.peers === 0) return null;
    if (
      value.support === 'supported-peer-observations' &&
      ((value.samples as number) < 2 || (value.peers as number) < 2)
    )
      return null;
    outputDimensions[key] = { score: value.score as number, support: value.support as string };
  }
  for (const key of ['observed_cost_usd', 'observed_wall_seconds'])
    if (raw[key] !== undefined && raw[key] !== null && !validNumber(raw[key])) return null;
  return {
    model_id: raw.model_id as string,
    route: raw.route as string,
    effort: raw.effort as string,
    evaluation_kind: kind,
    domain: raw.domain as string,
    task_type: raw.task_type as string,
    difficulty: raw.difficulty as string,
    skill: raw.skill as string,
    dimensions: outputDimensions,
    ...(raw.observed_cost_usd == null
      ? {}
      : { observed_cost_usd: raw.observed_cost_usd as number }),
    ...(raw.observed_wall_seconds == null
      ? {}
      : { observed_wall_seconds: raw.observed_wall_seconds as number }),
  };
}

function validExternal(raw: unknown): raw is ExternalEvidence {
  if (!isRecord(raw) || !isRecord(raw.task) || !isRecord(raw.source) || !isRecord(raw.assessment))
    return false;
  if (!['model_id', 'route', 'effort'].every((key) => isText(raw[key]))) return false;
  if (
    !['domain', 'task_type', 'difficulty', 'skill'].every((key) =>
      isText((raw.task as Record<string, unknown>)[key]),
    )
  )
    return false;
  if (!['routine', 'standard', 'complex'].includes(String(raw.task.difficulty))) return false;
  if (!isText(raw.source.url) || !isText(raw.source.title) || !validDate(raw.source.accessed_at))
    return false;
  if (raw.source.published_at !== undefined && !validDate(raw.source.published_at)) return false;
  try {
    const url = new URL(raw.source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  } catch {
    return false;
  }
  if (
    !['qualitative', 'ordinal'].includes(String(raw.assessment.kind)) ||
    !isText(raw.assessment.summary)
  )
    return false;
  if (
    raw.assessment.trial_fit !== undefined &&
    !['supports', 'unknown', 'opposes'].includes(String(raw.assessment.trial_fit))
  )
    return false;
  if (raw.assessment.kind === 'ordinal') {
    const ordinal = raw.assessment.ordinal;
    if (
      !isRecord(ordinal) ||
      typeof ordinal.value !== 'number' ||
      typeof ordinal.scale_min !== 'number' ||
      typeof ordinal.scale_max !== 'number'
    )
      return false;
    if (
      ![ordinal.value, ordinal.scale_min, ordinal.scale_max].every(Number.isFinite) ||
      ordinal.scale_min >= ordinal.scale_max ||
      ordinal.value < ordinal.scale_min ||
      ordinal.value > ordinal.scale_max
    )
      return false;
  } else if (raw.assessment.ordinal !== undefined) return false;
  if (raw.estimates !== undefined) {
    if (
      !isRecord(raw.estimates) ||
      raw.estimates.kind !== 'unobserved_estimate' ||
      !isText(raw.estimates.basis)
    )
      return false;
    if (raw.estimates.cost_usd === undefined && raw.estimates.wall_seconds === undefined)
      return false;
    if (raw.estimates.cost_usd !== undefined && !validNumber(raw.estimates.cost_usd)) return false;
    if (
      raw.estimates.wall_seconds !== undefined &&
      (!validNumber(raw.estimates.wall_seconds) || raw.estimates.wall_seconds === 0)
    )
      return false;
  }
  return true;
}

export function buildWorkerCatalog(
  inventory: HostInventory,
  snapshot: EvaluatorSnapshot,
  externalEvidence: ExternalEvidence[] = [],
  history: EvaluatorSnapshot = {
    status: 'not_requested',
    reason: 'No historical snapshot supplied.',
  },
): WorkerCatalog {
  check(
    isRecord(inventory) &&
      typeof inventory.complete === 'boolean' &&
      Array.isArray(inventory.routes),
    'Supply a host inventory and its completeness status',
  );
  check(
    isRecord(snapshot) &&
      ['available', 'unavailable', 'invalid_response', 'not_requested'].includes(
        String(snapshot.status),
      ),
    'Supply evaluator status explicitly',
  );
  check(Array.isArray(externalEvidence), 'External evidence must be an array');
  check(
    isRecord(history) &&
      ['available', 'unavailable', 'invalid_response', 'not_requested'].includes(
        String(history.status),
      ),
    'Supply historical evaluator status explicitly',
  );
  const routes = inventory.routes.map(routeCopy);
  check(
    new Set(routes.map((route) => route.id)).size === routes.length,
    'Inventory worker ids must be unique',
  );
  let received = 0;
  let rejected = 0;
  let profiles: RouteProfile[] = [];
  if (snapshot.status === 'available') {
    check(
      Array.isArray(snapshot.profiles) &&
        Number.isSafeInteger(snapshot.total) &&
        snapshot.total === snapshot.profiles.length,
      'Available evaluator snapshot must be complete',
    );
    received = snapshot.profiles.length;
    for (const raw of snapshot.profiles) {
      const profile = profileCopy(raw);
      if (profile) profiles.push(profile);
      else rejected++;
    }
    const key = (p: RouteProfile) =>
      JSON.stringify([
        p.model_id,
        p.route,
        p.effort,
        p.evaluation_kind,
        p.domain,
        p.task_type,
        p.difficulty,
        p.skill,
      ]);
    const counts = new Map<string, number>();
    for (const profile of profiles) counts.set(key(profile), (counts.get(key(profile)) ?? 0) + 1);
    const distinct = profiles.filter((profile) => counts.get(key(profile)) === 1);
    rejected += profiles.length - distinct.length;
    profiles = distinct;
  } else {
    check(isText(snapshot.reason), 'Unavailable evaluator status needs a reason');
  }
  const workers = routes.map(
    (route): WorkerInput => ({
      ...route,
      profiles:
        route.effort === undefined || route.effort === 'unknown'
          ? []
          : profiles
              .filter(
                (profile) =>
                  profile.model_id === route.model_id &&
                  profile.route === route.route &&
                  profile.effort === route.effort,
              )
              .map((profile) => ({
                ...profile,
                dimensions: Object.fromEntries(
                  Object.entries(profile.dimensions ?? {}).map(([key, value]) => [
                    key,
                    { ...value },
                  ]),
                ),
              })),
    }),
  );
  const entries: WorkerCatalog['external_evidence'] = [];
  let historicalReceived = 0;
  let historicalRejected = 0;
  const historicalEvidence: WorkerCatalog['historical_evidence'] = [];
  if (history.status === 'available') {
    check(
      Array.isArray(history.profiles) &&
        Number.isSafeInteger(history.total) &&
        history.total === history.profiles.length,
      'Available historical snapshot must be complete',
    );
    historicalReceived = history.profiles.length;
    for (const raw of history.profiles) {
      const profile = profileCopy(raw, 'historical_summary');
      if (!profile) {
        historicalRejected++;
        continue;
      }
      historicalEvidence.push({
        use: 'advisory_only',
        profile,
        matching_worker_ids: routes
          .filter((route) => route.model_id === profile.model_id)
          .map((route) => route.id),
      });
    }
  } else check(isText(history.reason), 'Unavailable historical status needs a reason');
  const incompleteExternal: WorkerCatalog['incomplete_external_evidence'] = [];
  let rejectedExternal = 0;
  for (const evidence of externalEvidence) {
    if (!validExternal(evidence)) {
      rejectedExternal++;
      incompleteExternal.push({
        use: 'advisory_only',
        evidence,
        reason: 'Incomplete or invalid external provenance, assessment, or estimate',
      });
      continue;
    }
    entries.push({
      use: 'advisory_only',
      evidence,
      matching_worker_ids: routes
        .filter(
          (route) =>
            route.model_id === evidence.model_id &&
            route.route === evidence.route &&
            route.effort === evidence.effort,
        )
        .map((route) => route.id),
    });
  }
  return {
    inventory_status: inventory.complete ? 'complete' : 'incomplete',
    inventory_unknown_fields: routes
      .map((route) => ({
        worker_id: route.id,
        fields: ['effort', 'available', 'tools_verified', 'tools'].filter(
          (field) => !Object.hasOwn(route, field),
        ),
      }))
      .filter((item) => item.fields.length),
    evaluator: {
      status: snapshot.status,
      data_quality:
        snapshot.status === 'available' ? (rejected ? 'partial' : 'complete') : 'unknown',
      received,
      accepted: profiles.length,
      rejected,
      ...(snapshot.status === 'available' ? {} : { reason: snapshot.reason }),
    },
    workers,
    historical: {
      status: history.status,
      received: historicalReceived,
      accepted: historicalEvidence.length,
      rejected: historicalRejected,
      ...(history.status === 'available' ? {} : { reason: history.reason }),
    },
    historical_evidence: historicalEvidence,
    external_evidence: entries,
    rejected_external_evidence: rejectedExternal,
    incomplete_external_evidence: incompleteExternal,
  };
}

class InvalidResponse extends Error {}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > 2_000_000)
    throw new InvalidResponse('Evaluator response is too large');
  if (!response.body) throw new InvalidResponse('Evaluator response has no body');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2_000_000) {
      await reader.cancel();
      throw new InvalidResponse('Evaluator response is too large');
    }
    parts.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new InvalidResponse('Evaluator returned invalid JSON');
  }
}

export async function fetchEvaluatorProfiles(
  endpoint: string,
  options: { timeout_ms?: number; kind?: 'local_work' | 'historical_summary' } = {},
): Promise<EvaluatorSnapshot> {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new Error('Use an explicit loopback evaluator origin');
  }
  check(
    ['http:', 'https:'].includes(base.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
    'Evaluator endpoint must be loopback',
  );
  check(
    !base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
    'Evaluator endpoint must be a clean origin',
  );
  const timeout = options.timeout_ms ?? 2500;
  const kind = options.kind ?? 'local_work';
  check(['local_work', 'historical_summary'].includes(kind), 'Unsupported evaluator evidence kind');
  check(
    Number.isInteger(timeout) && timeout >= 1 && timeout <= 10000,
    'Evaluator timeout must be 1 to 10000 ms',
  );
  if (base.hostname === 'localhost') base.hostname = '127.0.0.1';
  const signal = AbortSignal.timeout(timeout);
  const all: unknown[] = [];
  let total: number | null = null;
  try {
    while (total === null || all.length < total) {
      const url = new URL('/api/v1/profiles', base);
      url.searchParams.set('kind', kind);
      url.searchParams.set('limit', '100');
      url.searchParams.set('offset', String(all.length));
      const response = await fetch(url, { method: 'GET', redirect: 'error', signal });
      if (!response.ok)
        return { status: 'unavailable', reason: `Evaluator returned HTTP ${response.status}` };
      const page = await readBoundedJson(response);
      if (
        !isRecord(page) ||
        !Number.isSafeInteger(page.total) ||
        (page.total as number) < 0 ||
        (page.total as number) > 10000 ||
        page.offset !== all.length ||
        !Array.isArray(page.profiles) ||
        page.profiles.length > 100
      )
        throw new InvalidResponse('Evaluator returned an invalid profile page');
      if (total !== null && total !== page.total)
        throw new InvalidResponse('Evaluator profile total changed during pagination');
      total = page.total as number;
      if (
        all.length + page.profiles.length > total ||
        (all.length < total && page.profiles.length === 0)
      )
        throw new InvalidResponse('Evaluator profile pagination is incomplete');
      all.push(...page.profiles);
    }
    return { status: 'available', profiles: all, total: total ?? 0 };
  } catch (error) {
    if (error instanceof InvalidResponse)
      return { status: 'invalid_response', reason: error.message };
    return {
      status: 'unavailable',
      reason: signal.aborted ? 'Evaluator request timed out' : 'Evaluator request failed',
    };
  }
}
