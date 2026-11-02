import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Report } from '../packages/evaluator/src/contract.ts';
import { identifier, validateReport } from '../packages/evaluator/src/contract.ts';
import { isRecord, isText } from './validate.ts';

export interface CostContext {
  model_id: string;
  route: string;
  effort: string;
  domain: string;
  task_type: string;
  difficulty: string;
  skill: string;
  evidence_kind: 'local_work';
}

export interface CostProvenance {
  task_token: string;
  usd: number;
  input_tokens: number;
  output_tokens: number;
  records: Array<{
    record_id: string;
    kind: 'evaluator-report' | 'operational-only';
    usage_evidence: string;
    source: { url: string; checked_at: string; assumptions: string };
  }>;
}

export interface CostEstimate {
  context: CostContext;
  task_token_scope: string;
  basis: 'api-equivalent-estimate';
  estimated_cost_usd: number;
  sample_count: number;
  provenance: CostProvenance[];
}

export interface CostObservations {
  status: 'available' | 'partial' | 'needs-evidence';
  reason: string;
  task_token_scope: string | null;
  available_scopes: string[];
  estimates: CostEstimate[];
  diagnostics: {
    files_seen: number;
    eligible_records: number;
    unknown_records: number;
    malformed_records: number;
    excluded_nonlocal_records: number;
    ignored_other_scope_records: number;
    duplicate_records: number;
    conflicting_tasks: Array<{ task_token_scope: string; task_token: string; reason: string }>;
  };
  boundary: string;
}

interface CostRow {
  task_token_scope: string;
  task_token: string;
  model_id: string;
  route: string;
  effort: string;
  domain: string;
  task_type: string;
  difficulty: string;
  skills: string[];
  usd: number;
  input_tokens: number;
  output_tokens: number;
  record: CostProvenance['records'][number];
}

const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positiveText = (value: unknown): value is string => isText(value) && value.length <= 4096;
const usd = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
const tokens = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function cleanIdentity(value: unknown): value is string {
  try {
    identifier(value);
    return true;
  } catch {
    return false;
  }
}

function source(value: unknown): CostProvenance['records'][number]['source'] | null {
  if (
    !isRecord(value) ||
    !positiveText(value.url) ||
    !positiveText(value.checked_at) ||
    !Number.isFinite(Date.parse(value.checked_at)) ||
    !positiveText(value.assumptions)
  )
    return null;
  try {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  } catch {
    return null;
  }
  return { url: value.url, checked_at: value.checked_at, assumptions: value.assumptions };
}

function taskFields(
  value: unknown,
): { domain: string; task_type: string; difficulty: string; skills: string[] } | null {
  if (
    !isRecord(value) ||
    !['software-engineering', 'technical-product', 'technical-product-design'].includes(
      String(value.domain),
    ) ||
    !cleanIdentity(value.task_type) ||
    !['routine', 'standard', 'complex'].includes(String(value.difficulty)) ||
    !Array.isArray(value.skills) ||
    value.skills.length === 0 ||
    value.skills.length > 5 ||
    !value.skills.every(cleanIdentity) ||
    new Set(value.skills).size !== value.skills.length
  )
    return null;
  return {
    domain:
      value.domain === 'technical-product-design' ? 'technical-product' : (value.domain as string),
    task_type: value.task_type,
    difficulty: value.difficulty as string,
    skills: [...value.skills].sort(),
  };
}

type Parsed =
  | { status: 'eligible'; row: CostRow }
  | { status: 'unknown' | 'malformed' | 'nonlocal' };

function parseRecord(value: unknown, fileId: string): Parsed {
  if (!isRecord(value) || !cleanIdentity(fileId)) return { status: 'malformed' };
  if (value.kind === 'evaluator-report') {
    let report: Report;
    try {
      report = validateReport(value.report);
    } catch {
      return { status: 'malformed' };
    }
    if (report.report_id !== fileId) return { status: 'malformed' };
    if (report.evaluation_kind !== 'local_work') return { status: 'nonlocal' };
    const task = taskFields({
      domain: report.task.domain,
      task_type: report.task.type,
      difficulty: report.task.difficulty,
      skills: report.task.skills,
    });
    const price = value.local_cost_estimate;
    if (
      !hash(value.task_token_scope) ||
      !task ||
      !isRecord(price) ||
      price.basis !== 'api-equivalent-estimate' ||
      !usd(price.usd) ||
      !positiveText(price.usage_evidence) ||
      !tokens(report.usage.input_tokens) ||
      !tokens(report.usage.output_tokens) ||
      report.usage.cost_usd !== null
    )
      return { status: 'unknown' };
    const reference = source(price.source);
    if (!reference) return { status: 'unknown' };
    return {
      status: 'eligible',
      row: {
        task_token_scope: value.task_token_scope,
        task_token: report.task_token,
        model_id: report.subject_model,
        route: report.route,
        effort: report.effort,
        ...task,
        usd: price.usd,
        input_tokens: report.usage.input_tokens,
        output_tokens: report.usage.output_tokens,
        record: {
          record_id: fileId,
          kind: 'evaluator-report',
          usage_evidence: price.usage_evidence,
          source: reference,
        },
      },
    };
  }
  if (value.kind !== 'operational-only' || !isRecord(value.record)) return { status: 'malformed' };
  const record = value.record;
  if (!isRecord(record.task)) return { status: 'unknown' };
  if (record.task.evidence_kind !== 'local_work')
    return ['simulation', 'historical_summary'].includes(String(record.task.evidence_kind))
      ? { status: 'nonlocal' }
      : { status: 'unknown' };
  const task = taskFields(record.task);
  const reference = source(record.cost_reference);
  if (
    !hash(record.task_token_scope) ||
    !hash(record.task_token) ||
    !task ||
    !cleanIdentity(record.model_id) ||
    !cleanIdentity(record.task.route) ||
    !cleanIdentity(record.task.effort) ||
    !positiveText(record.subject_context) ||
    !positiveText(record.reviewer_context) ||
    record.subject_context === record.reviewer_context ||
    !Array.isArray(record.identity_evidence) ||
    record.identity_evidence.length < 2 ||
    !record.identity_evidence.every(positiveText) ||
    !['accepted', 'rejected'].includes(String(record.decision)) ||
    record.cost_basis !== 'api-equivalent-estimate' ||
    !isRecord(record.usage) ||
    !usd(record.usage.cost_usd) ||
    !tokens(record.usage.input_tokens) ||
    !tokens(record.usage.output_tokens) ||
    !positiveText(record.usage_evidence) ||
    !reference
  )
    return { status: 'unknown' };
  return {
    status: 'eligible',
    row: {
      task_token_scope: record.task_token_scope,
      task_token: record.task_token,
      model_id: record.model_id,
      route: record.task.route,
      effort: record.task.effort,
      ...task,
      usd: record.usage.cost_usd,
      input_tokens: record.usage.input_tokens,
      output_tokens: record.usage.output_tokens,
      record: {
        record_id: fileId,
        kind: 'operational-only',
        usage_evidence: record.usage_evidence,
        source: reference,
      },
    },
  };
}

const identity = (row: CostRow) =>
  JSON.stringify([
    row.model_id,
    row.route,
    row.effort,
    row.domain,
    row.task_type,
    row.difficulty,
    row.skills,
  ]);

export async function readCostObservations(
  directory: string,
  options: { task_token_scope?: string } = {},
): Promise<CostObservations> {
  const diagnostics: CostObservations['diagnostics'] = {
    files_seen: 0,
    eligible_records: 0,
    unknown_records: 0,
    malformed_records: 0,
    excluded_nonlocal_records: 0,
    ignored_other_scope_records: 0,
    duplicate_records: 0,
    conflicting_tasks: [],
  };
  const boundary =
    'Host-declared API-equivalent estimates from prior local attempts are not actual billing, authenticated identities, capability scores, or guaranteed future cost. Distinct token scopes cannot be deduplicated.';
  const empty = (reason: string): CostObservations => ({
    status: 'needs-evidence',
    reason,
    task_token_scope: options.task_token_scope ?? null,
    available_scopes: [],
    estimates: [],
    diagnostics,
    boundary,
  });
  if (!path.isAbsolute(directory))
    return empty('Use an explicit absolute local feedback directory.');
  if (options.task_token_scope !== undefined && !hash(options.task_token_scope))
    return empty('Invalid task token scope.');
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return empty('Feedback directory is unavailable.');
  }
  const files = entries
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  diagnostics.files_seen = files.length;
  if (files.length > 10000) return empty('Feedback directory exceeds the bounded record limit.');
  const rows: CostRow[] = [];
  for (const entry of files) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      diagnostics.malformed_records++;
      continue;
    }
    const filename = path.join(directory, entry.name);
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) {
        diagnostics.malformed_records++;
        continue;
      }
      const parsed = parseRecord(
        JSON.parse(await readFile(filename, 'utf8')),
        entry.name.slice(0, -5),
      );
      if (parsed.status === 'eligible') rows.push(parsed.row);
      else if (parsed.status === 'unknown') diagnostics.unknown_records++;
      else if (parsed.status === 'nonlocal') diagnostics.excluded_nonlocal_records++;
      else diagnostics.malformed_records++;
    } catch {
      diagnostics.malformed_records++;
    }
  }
  const scopes = [...new Set(rows.map((row) => row.task_token_scope))].sort();
  if (!options.task_token_scope && scopes.length > 1)
    return {
      ...empty('Several token scopes cannot be safely deduplicated; select one explicitly.'),
      available_scopes: scopes,
    };
  const scope = options.task_token_scope ?? scopes[0] ?? null;
  if (!scope || !scopes.includes(scope))
    return {
      ...empty('No eligible cost evidence exists for the selected scope.'),
      available_scopes: scopes,
    };
  const selected = rows.filter((row) => row.task_token_scope === scope);
  diagnostics.ignored_other_scope_records = rows.length - selected.length;
  diagnostics.eligible_records = selected.length;
  const byTask = new Map<string, CostRow[]>();
  for (const row of selected)
    byTask.set(row.task_token, [...(byTask.get(row.task_token) ?? []), row]);
  const contexts = new Map<string, CostEstimate>();
  for (const [taskToken, copies] of byTask) {
    const first = copies[0];
    if (
      copies.some(
        (row) =>
          identity(row) !== identity(first) ||
          row.usd !== first.usd ||
          row.input_tokens !== first.input_tokens ||
          row.output_tokens !== first.output_tokens,
      )
    ) {
      diagnostics.conflicting_tasks.push({
        task_token_scope: scope,
        task_token: taskToken,
        reason: 'Conflicting identity, task context, token counts or estimated cost for one task.',
      });
      continue;
    }
    diagnostics.duplicate_records += copies.length - 1;
    for (const skill of first.skills) {
      const context: CostContext = {
        model_id: first.model_id,
        route: first.route,
        effort: first.effort,
        domain: first.domain,
        task_type: first.task_type,
        difficulty: first.difficulty,
        skill,
        evidence_kind: 'local_work',
      };
      const key = JSON.stringify(context);
      let estimate = contexts.get(key);
      if (!estimate) {
        estimate = {
          context,
          task_token_scope: scope,
          basis: 'api-equivalent-estimate',
          estimated_cost_usd: 0,
          sample_count: 0,
          provenance: [],
        };
        contexts.set(key, estimate);
      }
      estimate.sample_count++;
      estimate.estimated_cost_usd += first.usd;
      estimate.provenance.push({
        task_token: taskToken,
        usd: first.usd,
        input_tokens: first.input_tokens,
        output_tokens: first.output_tokens,
        records: copies.map((row) => row.record),
      });
    }
  }
  const estimates = [...contexts.values()];
  for (const estimate of estimates) estimate.estimated_cost_usd /= estimate.sample_count;
  const partial =
    diagnostics.unknown_records > 0 ||
    diagnostics.malformed_records > 0 ||
    diagnostics.conflicting_tasks.length > 0 ||
    diagnostics.ignored_other_scope_records > 0;
  return {
    status: !estimates.length ? 'needs-evidence' : partial ? 'partial' : 'available',
    reason: !estimates.length
      ? 'No non-conflicting local cost observations are available.'
      : partial
        ? 'Some records were unknown, conflicting, malformed or outside the selected scope.'
        : 'Local cost observations are available.',
    task_token_scope: scope,
    available_scopes: scopes,
    estimates,
    diagnostics,
    boundary,
  };
}
