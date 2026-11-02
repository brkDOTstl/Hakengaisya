import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness2Job, Harness2Report } from './adapter.ts';

type JsonRecord = Record<string, unknown>;
export type HostRequestKind = 'execute' | 'edit' | 'adoption-review' | 'experience';
export interface HostRequest {
  version: 1;
  job_id: string;
  job_fingerprint: string;
  kind: HostRequestKind;
  label: string;
  actor_context: string;
  payload: JsonRecord;
  request_id: string;
  request_fingerprint: string;
}
export interface HostResponse extends JsonRecord {
  request_id: string;
  request_fingerprint: string;
  actor_context: string;
  status: 'completed' | 'failed';
  cost_usd: number | null;
}
export interface IsolatedExecution {
  workspace: string;
  source_fingerprint: string;
}
export interface IsolationProvider {
  root: string;
  live_workspace: string;
  source_fingerprint: string;
  prepare: (request: HostRequest) => Promise<IsolatedExecution>;
  verify: (workspace: string, request: HostRequest) => Promise<string>;
}
export interface BridgeInvocation {
  job_file: string;
  state_dir: string;
  python: string;
  bridge_file: string;
  upstream?: string;
  timeout_ms: number;
}
export type BridgeRunner = (invocation: BridgeInvocation) => Promise<JsonRecord>;
export interface HostDriverOptions {
  job: Harness2Job;
  job_file: string;
  state_dir: string;
  handle: (request: HostRequest, execution?: IsolatedExecution) => Promise<HostResponse>;
  isolation?: IsolationProvider;
  python?: string;
  upstream?: string;
  bridge_file?: string;
  timeout_ms?: number;
  run_bridge?: BridgeRunner;
}
export interface HostStepOptions {
  job_file: string;
  state_dir: string;
  python?: string;
  upstream?: string;
  bridge_file?: string;
  timeout_ms?: number;
  run_bridge?: BridgeRunner;
}
export interface StepIsolation {
  root: string;
  live_workspace: string;
  snapshot: string;
  workspace: string;
  source_fingerprint: string;
}
export interface HostClaimOptions extends HostStepOptions {
  session: string;
  request_id: string;
  isolation?: StepIsolation;
}
export interface HostCompleteOptions extends HostStepOptions {
  session: string;
  request_id: string;
  response: HostResponse;
}
export interface HostBaselineOptions extends HostStepOptions {
  session: string;
}
export interface PendingRequest {
  request_id: string;
  request_fingerprint: string;
  kind: HostRequestKind;
  label: string;
  actor_context: string;
  claimed: boolean;
}
export type HostStepResult =
  | { status: 'needs-host'; session: string; requests: PendingRequest[]; boundary: string }
  | { status: 'ready-for-submission' | 'rejected'; report: JsonRecord; boundary: string }
  | { status: 'claimed'; request: HostRequest; execution?: IsolatedExecution; boundary: string }
  | { status: 'submitted' | 'already-submitted'; request_id: string; boundary: string }
  | {
      status: 'baseline-ready-for-submission';
      job_id: string;
      packet_id: string;
      attempt: number;
      owner_context: string;
      supervisor_context: string;
      declared_model_binding: Harness2Job['dispatch']['model_binding'];
      baseline_request_id: string;
      source_fingerprint: string;
      outputs: { id: string; reference: string; summary: string }[];
      evidence: { reference: string; summary: string }[];
      host_reported_cost_usd: number | null;
      response_record: string;
      requires_supervisor_task_review: true;
      boundary: string;
    }
  | {
      status: 'blocked' | 'unavailable' | 'uncertain-execution';
      reason: string;
      request_id?: string;
      boundary: string;
    };
export type HostDriverResult =
  | { status: 'ready-for-submission'; report: Harness2Report; processed: number; boundary: string }
  | { status: 'rejected'; report: JsonRecord; processed: number; boundary: string }
  | {
      status: 'blocked' | 'unavailable' | 'uncertain-execution';
      reason: string;
      processed: number;
      request_id?: string;
      boundary: string;
    };

const MAX_RECORD_BYTES = 512 * 1024;
const REPORT_BOUNDARY =
  'Host-supplied execution and workspace verification are not provider authentication or an OS sandbox. Distinct filesystems do not isolate agent conversation history or prove independent or blind comparisons. Supervisor adoption does not accept the ordinary task. No automatic evaluator upload occurs.';
const kinds = new Set<HostRequestKind>(['execute', 'edit', 'adoption-review', 'experience']);
const responseFields = new Set([
  'request_id',
  'request_fingerprint',
  'actor_context',
  'status',
  'cost_usd',
  'text',
  'harness',
  'outputs',
  'evidence',
  'trajectory',
  'model_id',
  'decision',
  'reason',
]);

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function overlaps(first: string, second: string): boolean {
  return first === second || contains(first, second) || contains(second, first);
}
function absolute(filename: string, label: string): string {
  requireValue(
    typeof filename === 'string' && path.isAbsolute(filename),
    `${label} must be an absolute path`,
  );
  return path.resolve(filename);
}
async function ordinary(filename: string): Promise<void> {
  const stats = await lstat(filename);
  requireValue(stats.isFile() && !stats.isSymbolicLink(), 'Host records must be ordinary files');
  requireValue(stats.size <= MAX_RECORD_BYTES, 'Host record exceeds the size limit');
}
async function readText(filename: string): Promise<string> {
  await ordinary(filename);
  const data = await readFile(filename, 'utf8');
  requireValue(Buffer.byteLength(data) <= MAX_RECORD_BYTES, 'Host record exceeds the size limit');
  return data.replace(/^\uFEFF/, '');
}
async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readText(filename)) as unknown;
}

// The bridge writes Python JSON numbers verbatim; parsing through JS would change 1e-07 to 1e-7.
function canonicalRequest(text: string): string {
  let cursor = 0;
  const whitespace = () => {
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
  };
  const compareKeys = (first: string, second: string) => {
    const a = Array.from(first, (value) => value.codePointAt(0) ?? 0);
    const b = Array.from(second, (value) => value.codePointAt(0) ?? 0);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  };
  const string = (): string => {
    requireValue(text[cursor] === '"', 'Invalid request JSON string');
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor++] === '"') return JSON.parse(text.slice(start, cursor)) as string;
    }
    throw new Error('Invalid request JSON string');
  };
  const value = (root = false): string => {
    whitespace();
    if (text[cursor] === '"') return JSON.stringify(string());
    if (text[cursor] === '[') {
      cursor++;
      const values: string[] = [];
      whitespace();
      while (text[cursor] !== ']') {
        values.push(value());
        whitespace();
        if (text[cursor] === ',') cursor++;
        else requireValue(text[cursor] === ']', 'Invalid request JSON array');
        whitespace();
      }
      cursor++;
      return `[${values.join(',')}]`;
    }
    if (text[cursor] === '{') {
      cursor++;
      const entries: [string, string][] = [];
      const keys = new Set<string>();
      whitespace();
      while (text[cursor] !== '}') {
        const key = string();
        requireValue(!keys.has(key), 'Duplicate request JSON key');
        keys.add(key);
        whitespace();
        requireValue(text[cursor++] === ':', 'Invalid request JSON object');
        const item = value();
        if (!root || !['request_id', 'request_fingerprint'].includes(key))
          entries.push([key, item]);
        whitespace();
        if (text[cursor] === ',') cursor++;
        else requireValue(text[cursor] === '}', 'Invalid request JSON object');
        whitespace();
      }
      cursor++;
      return `{${entries
        .sort(([a], [b]) => compareKeys(a, b))
        .map(([key, item]) => `${JSON.stringify(key)}:${item}`)
        .join(',')}}`;
    }
    const token = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(cursor),
    );
    requireValue(token, 'Invalid request JSON value');
    cursor += token[0].length;
    return token[0];
  };
  const result = value(true);
  whitespace();
  requireValue(cursor === text.length, 'Invalid trailing request JSON');
  return result;
}
async function directory(filename: string): Promise<string> {
  const stats = await lstat(filename);
  requireValue(stats.isDirectory() && !stats.isSymbolicLink(), 'Expected a real directory');
  return realpath(filename);
}
async function writeImmutable(filename: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  requireValue(Buffer.byteLength(body) <= MAX_RECORD_BYTES, 'Host record exceeds the size limit');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, filename);
  } finally {
    await unlink(temporary);
  }
}
function validateJob(job: Harness2Job): void {
  requireValue(
    record(job) && job.version === 1 && job.kind === 'hakengaisya-harness2-job',
    'Unsupported improvement job',
  );
  const { job_id, job_fingerprint, ...content } = job;
  requireValue(
    job_fingerprint === digest(content) && job_id === `h2-${job_fingerprint.slice(0, 24)}`,
    'Improvement job fingerprint differs',
  );
  requireValue(
    job.policy.enabled &&
      Number.isSafeInteger(job.policy.max_host_calls) &&
      job.policy.max_host_calls >= 1 &&
      job.policy.max_host_calls <= 12,
    'Explicit bounded improvement policy required',
  );
  requireValue(
    typeof job.owner_context === 'string' &&
      !!job.owner_context &&
      typeof job.supervisor_context === 'string' &&
      !!job.supervisor_context &&
      job.owner_context !== job.supervisor_context,
    'Distinct owner and supervisor are required',
  );
  requireValue(
    !!job.dispatch.model_binding.model_id && !!job.dispatch.model_binding.route,
    'A fixed model and route are required',
  );
}
function validateRequest(
  raw: unknown,
  text: string,
  job: Harness2Job,
  filename: string,
): HostRequest {
  requireValue(record(raw), 'Invalid host request');
  const expectedKeys = [
    'version',
    'job_id',
    'job_fingerprint',
    'kind',
    'label',
    'actor_context',
    'payload',
    'request_id',
    'request_fingerprint',
  ];
  requireValue(
    Object.keys(raw).length === expectedKeys.length &&
      expectedKeys.every((key) => Object.hasOwn(raw, key)),
    'Invalid host request fields',
  );
  const { request_id, request_fingerprint } = raw;
  requireValue(
    raw.version === 1 && raw.job_id === job.job_id && raw.job_fingerprint === job.job_fingerprint,
    'Host request belongs to another job',
  );
  requireValue(
    typeof raw.kind === 'string' &&
      kinds.has(raw.kind as HostRequestKind) &&
      typeof raw.label === 'string' &&
      !!raw.label &&
      record(raw.payload),
    'Invalid host request type',
  );
  requireValue(
    request_fingerprint === createHash('sha256').update(canonicalRequest(text)).digest('hex') &&
      request_id === `request-${String(request_fingerprint).slice(0, 32)}` &&
      path.basename(filename) === `${request_id}.json`,
    'Host request fingerprint differs',
  );
  const actor =
    raw.kind === 'execute' || raw.kind === 'edit' ? job.owner_context : job.supervisor_context;
  requireValue(raw.actor_context === actor, 'Host request actor lacks authority');
  if (raw.kind === 'execute') {
    requireValue(
      raw.payload.isolated_workspace_required === true &&
        canonical(raw.payload.dispatch) === canonical(job.dispatch),
      'Execution must use the fixed isolated dispatch',
    );
    requireValue(
      record(raw.payload.harness) &&
        raw.payload.harness['guardrails.md'] === job.base_harness['guardrails.md'],
      'Execution guardrails changed',
    );
  }
  if (raw.kind === 'adoption-review')
    requireValue(
      canonical(raw.payload.contract) === canonical(job.dispatch),
      'Adoption review contract changed',
    );
  return raw as unknown as HostRequest;
}
function validateResponse(raw: unknown, request: HostRequest, job: Harness2Job): HostResponse {
  requireValue(
    record(raw) && Object.keys(raw).every((key) => responseFields.has(key)),
    'Invalid host response fields',
  );
  for (const key of ['request_id', 'request_fingerprint', 'actor_context'] as const)
    requireValue(raw[key] === request[key], 'Host response identity differs');
  requireValue(
    raw.status === 'completed' || raw.status === 'failed',
    'Invalid host response status',
  );
  requireValue(
    raw.cost_usd === null ||
      (typeof raw.cost_usd === 'number' && Number.isFinite(raw.cost_usd) && raw.cost_usd >= 0),
    'Host cost must be observed or null',
  );
  if (raw.status === 'completed' && request.kind === 'execute') {
    requireValue(
      raw.model_id === job.dispatch.model_binding.model_id,
      'Execution silently switched models',
    );
    requireValue(
      Array.isArray(raw.outputs) &&
        Array.isArray(raw.evidence) &&
        typeof raw.trajectory === 'string' &&
        !!raw.trajectory.trim(),
      'Execution evidence is incomplete',
    );
  }
  if (raw.status === 'completed' && request.kind === 'adoption-review') {
    requireValue(
      (raw.decision === 'accepted' || raw.decision === 'rejected') &&
        typeof raw.reason === 'string' &&
        !!raw.reason.trim() &&
        Array.isArray(raw.evidence) &&
        raw.evidence.length > 0,
      'Supervisor decision requires a reason and evidence',
    );
  }
  return raw as HostResponse;
}

function checkClaim(
  raw: unknown,
  request: HostRequest,
  job: Harness2Job,
): asserts raw is JsonRecord {
  requireValue(
    record(raw) &&
      raw.job_id === job.job_id &&
      raw.job_fingerprint === job.job_fingerprint &&
      raw.request_id === request.request_id &&
      raw.request_fingerprint === request.request_fingerprint &&
      raw.actor_context === request.actor_context &&
      raw.kind === request.kind,
    'Host claim identity differs',
  );
}
function responseReceipt(
  request: HostRequest,
  job: Harness2Job,
  claim: JsonRecord,
  response: HostResponse,
): JsonRecord {
  return {
    version: 1,
    job_id: job.job_id,
    job_fingerprint: job.job_fingerprint,
    request_id: request.request_id,
    request_fingerprint: request.request_fingerprint,
    actor_context: request.actor_context,
    kind: request.kind,
    claim_fingerprint: digest(claim),
    response_fingerprint: digest(response),
  };
}
async function assertReceiptsForJob(state: string, job: Harness2Job): Promise<void> {
  const sessions = path.join(state, 'sessions');
  if (!(await pathExists(sessions))) return;
  requireValue((await directory(sessions)) === sessions, 'Session directory is not local');
  const names = await readdir(sessions);
  requireValue(names.length <= 4096, 'Too many learning sessions to inspect safely');
  let matches = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const session = path.join(sessions, name);
    requireValue((await directory(session)) === session, 'Learning session is not local');
    const input = path.join(session, 'input.json');
    if (!(await pathExists(input))) continue;
    if (canonical(await readJson(input)) !== canonical(job)) continue;
    requireValue(++matches === 1, 'Multiple sessions match the same job');
    const responses = path.join(session, 'responses');
    if (!(await pathExists(responses))) continue;
    requireValue((await directory(responses)) === responses, 'Response directory is not local');
    const names = (await readdir(responses)).filter((item) => item.endsWith('.json'));
    requireValue(
      job.policy.enabled && names.length <= job.policy.max_host_calls,
      'Host response ceiling exceeded',
    );
    for (const filename of names) {
      requireValue(/^request-[a-f0-9]{32}\.json$/.test(filename), 'Invalid response file name');
      const requestFile = path.join(session, 'requests', filename);
      const claimFile = path.join(session, 'host-claims', filename);
      const receiptFile = path.join(session, 'host-receipts', filename);
      if (
        !(await pathExists(requestFile)) ||
        !(await pathExists(claimFile)) ||
        !(await pathExists(receiptFile))
      ) {
        throw new Error(
          `UNCERTAIN:${filename.slice(0, -5)}:A response lacks its request, claim, or immutable receipt; inspect its provenance before resuming.`,
        );
      }
      const requestText = await readText(requestFile);
      const request = validateRequest(JSON.parse(requestText), requestText, job, requestFile);
      const claim = await readJson(claimFile);
      checkClaim(claim, request, job);
      const response = validateResponse(
        await readJson(path.join(responses, filename)),
        request,
        job,
      );
      requireValue(
        canonical(await readJson(receiptFile)) ===
          canonical(responseReceipt(request, job, claim, response)),
        'Host response receipt does not match its immutable request and claim',
      );
    }
  }
}

function uncertain(error: unknown): { request_id: string; reason: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^UNCERTAIN:(request-[a-f0-9]{32}):(.*)$/.exec(message);
  return match ? { request_id: match[1], reason: match[2] } : null;
}
async function persistResponse(
  session: string,
  request: HostRequest,
  job: Harness2Job,
  response: HostResponse,
): Promise<boolean> {
  const name = `${request.request_id}.json`;
  const responses = await directory(path.join(session, 'responses'));
  const claims = await directory(path.join(session, 'host-claims'));
  const receiptDir = path.join(session, 'host-receipts');
  await mkdir(receiptDir, { recursive: true });
  requireValue((await directory(receiptDir)) === receiptDir, 'Host receipt directory is not local');
  const claim = await readJson(path.join(claims, name));
  checkClaim(claim, request, job);
  const filename = path.join(responses, name);
  const receiptFile = path.join(receiptDir, name);
  const expected = responseReceipt(request, job, claim, response);
  const hasResponse = await pathExists(filename);
  const hasReceipt = await pathExists(receiptFile);
  if (hasResponse !== hasReceipt)
    throw new Error(
      `UNCERTAIN:${request.request_id}:A response or receipt is missing; inspect the host execution before resuming.`,
    );
  if (hasResponse) {
    requireValue(
      canonical(await readJson(filename)) === canonical(response),
      'A different response already exists; preserve the prior result',
    );
    requireValue(
      canonical(await readJson(receiptFile)) === canonical(expected),
      'The existing host receipt does not match its response',
    );
    return false;
  }
  await writeImmutable(filename, response);
  try {
    await writeImmutable(receiptFile, expected);
  } catch {
    throw new Error(
      `UNCERTAIN:${request.request_id}:The response was written but its immutable receipt was not; inspect the host execution before resuming.`,
    );
  }
  return true;
}

function checkedTerminal(
  result: JsonRecord,
  job: Harness2Job,
): { status: 'ready-for-submission' | 'rejected'; report: JsonRecord } | null {
  if (result.status !== 'ready-for-submission' && result.status !== 'rejected') return null;
  requireValue(
    result.job_id === job.job_id &&
      result.job_fingerprint === job.job_fingerprint &&
      result.evidence_kind === job.evidence_kind,
    'Bridge report identity differs',
  );
  requireValue(
    record(result.supervisor_review) &&
      result.supervisor_review.actor_context === job.supervisor_context &&
      result.supervisor_review.decision ===
        (result.status === 'rejected' ? 'rejected' : 'accepted'),
    'Direct supervisor review is required',
  );
  requireValue(
    typeof result.supervisor_review.reason === 'string' &&
      !!result.supervisor_review.reason.trim() &&
      Array.isArray(result.supervisor_review.evidence) &&
      result.supervisor_review.evidence.length > 0 &&
      result.supervisor_review.evidence.every(
        (item: unknown) =>
          record(item) &&
          typeof item.reference === 'string' &&
          !!item.reference &&
          typeof item.summary === 'string' &&
          !!item.summary,
      ),
    'Supervisor review needs a reason and inspectable evidence',
  );
  if (result.status === 'ready-for-submission') {
    requireValue(
      Array.isArray(result.outputs) &&
        result.outputs.length === job.dispatch.outputs.length &&
        new Set(result.outputs.map((item: unknown) => (record(item) ? item.id : null))).size ===
          result.outputs.length &&
        result.outputs.every(
          (item: unknown) =>
            record(item) &&
            typeof item.id === 'string' &&
            job.dispatch.outputs.includes(item.id) &&
            typeof item.reference === 'string' &&
            !!item.reference &&
            typeof item.summary === 'string' &&
            !!item.summary,
        ) &&
        Array.isArray(result.evidence) &&
        result.evidence.length > 0 &&
        result.evidence.every(
          (item: unknown) =>
            record(item) &&
            typeof item.reference === 'string' &&
            !!item.reference &&
            typeof item.summary === 'string' &&
            !!item.summary,
        ),
      'Improvement report needs the exact outputs and inspectable evidence',
    );
  }
  const report = {
    ...result,
    observed_cost_usd:
      result.cost_evidence_complete === true &&
      result.upstream_cost_placeholder_used === false &&
      typeof result.observed_cost_usd === 'number' &&
      Number.isFinite(result.observed_cost_usd) &&
      result.observed_cost_usd >= 0
        ? result.observed_cost_usd
        : null,
    cost_comparison_allowed: false,
  };
  return { status: result.status, report };
}

export const invokePythonBridge: BridgeRunner = async (options) => {
  const args = [options.bridge_file, '--job', options.job_file, '--state', options.state_dir];
  if (options.upstream) args.push('--upstream', options.upstream);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const child = spawn(options.python, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (result: JsonRecord) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        status: 'blocked',
        reason: 'Python bridge exceeded the host timeout; inspect its state before retrying.',
      });
    }, options.timeout_ms);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_RECORD_BYTES) {
        child.kill();
        finish({ status: 'blocked', reason: 'Python bridge output exceeded the size limit.' });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
    });
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish({
        status: error.code === 'ENOENT' ? 'unavailable' : 'blocked',
        reason:
          error.code === 'ENOENT'
            ? 'Python executable is unavailable.'
            : `Python bridge failed to start: ${error.message}`,
      }),
    );
    child.once('close', (code) => {
      try {
        const value: unknown = JSON.parse(stdout.trim());
        if (!record(value) || typeof value.status !== 'string')
          throw new Error('Invalid bridge response');
        finish(value);
      } catch {
        finish({
          status: 'blocked',
          reason:
            `Python bridge returned invalid output (exit ${code ?? 'unknown'}). ${stderr.trim()}`.trim(),
        });
      }
    });
  });
};

async function prepareIsolated(
  request: HostRequest,
  isolation: IsolationProvider | undefined,
  claimsDir: string,
): Promise<IsolatedExecution> {
  requireValue(
    isolation && typeof isolation.prepare === 'function' && typeof isolation.verify === 'function',
    'An isolated workspace provider is required for every execution',
  );
  requireValue(
    /^[a-f0-9]{64}$/.test(isolation.source_fingerprint),
    'A frozen source fingerprint is required',
  );
  const root = await directory(absolute(isolation.root, 'Isolation root'));
  const live = await directory(absolute(isolation.live_workspace, 'Live workspace'));
  requireValue(!overlaps(root, live), 'The isolation root must not overlap the live workspace');
  const proposed = await isolation.prepare(request);
  requireValue(
    record(proposed) &&
      typeof proposed.workspace === 'string' &&
      proposed.source_fingerprint === isolation.source_fingerprint,
    'Prepared workspace has the wrong source fingerprint',
  );
  const workspace = await directory(absolute(proposed.workspace, 'Isolated workspace'));
  requireValue(
    contains(root, workspace) && !overlaps(workspace, live),
    'Execution workspace is outside the isolation root or overlaps live work',
  );
  for (const filename of await readdir(claimsDir)) {
    if (!filename.endsWith('.json')) continue;
    const claim = await readJson(path.join(claimsDir, filename));
    if (record(claim) && typeof claim.workspace === 'string')
      requireValue(
        !overlaps(workspace, claim.workspace),
        'Each execution needs a distinct isolated workspace',
      );
  }
  const observed = await isolation.verify(workspace, request);
  requireValue(
    observed === isolation.source_fingerprint,
    'Isolated workspace did not match the frozen source snapshot',
  );
  return { workspace, source_fingerprint: observed };
}

export async function driveHarness2(options: HostDriverOptions): Promise<HostDriverResult> {
  validateJob(options.job);
  requireValue(options.job.policy.enabled, 'Explicit bounded improvement policy required');
  const maximum = options.job.policy.max_host_calls;
  requireValue(typeof options.handle === 'function', 'A host callback is required');
  const jobFile = absolute(options.job_file, 'Job file');
  const stateDir = absolute(options.state_dir, 'Learning state');
  requireValue(
    canonical(await readJson(jobFile)) === canonical(options.job),
    'Saved job differs from the supplied job',
  );
  await mkdir(stateDir, { recursive: true });
  const state = await directory(stateDir);
  const timeout = options.timeout_ms ?? 30000;
  requireValue(
    Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 60000,
    'Bridge timeout must be between 1 and 60000 milliseconds',
  );
  const bridgeFile = absolute(
    options.bridge_file ?? fileURLToPath(new URL('../harness2_bridge.py', import.meta.url)),
    'Bridge file',
  );
  const runner = options.run_bridge ?? invokePythonBridge;
  const lock = path.join(state, 'host-driver.lock');
  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    lockHandle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return {
        status: 'blocked',
        reason: 'Another host driver or a crash lock exists; inspect it before retrying.',
        processed: 0,
        boundary: REPORT_BOUNDARY,
      };
    throw error;
  }
  let processed = 0;
  try {
    await lockHandle.writeFile(
      JSON.stringify({
        pid: process.pid,
        job_id: options.job.job_id,
        started_at: new Date().toISOString(),
      }),
    );
    for (let iteration = 0; iteration <= maximum; iteration++) {
      requireValue(
        canonical(await readJson(jobFile)) === canonical(options.job),
        'Saved job changed during execution',
      );
      await assertReceiptsForJob(state, options.job);
      const result = await runner({
        job_file: jobFile,
        state_dir: state,
        python: options.python ?? 'python',
        bridge_file: bridgeFile,
        upstream: options.upstream,
        timeout_ms: timeout,
      });
      requireValue(record(result) && typeof result.status === 'string', 'Invalid bridge result');
      const terminal = checkedTerminal(result, options.job);
      if (terminal?.status === 'rejected')
        return {
          status: 'rejected',
          report: terminal.report,
          processed,
          boundary: REPORT_BOUNDARY,
        };
      if (terminal?.status === 'ready-for-submission')
        return {
          status: 'ready-for-submission',
          report: terminal.report as unknown as Harness2Report,
          processed,
          boundary: REPORT_BOUNDARY,
        };
      if (result.status !== 'needs-host')
        return {
          status: result.status === 'unavailable' ? 'unavailable' : 'blocked',
          reason: typeof result.reason === 'string' ? result.reason : 'Bridge did not complete.',
          processed,
          boundary: REPORT_BOUNDARY,
        };
      requireValue(
        result.job_id === options.job.job_id &&
          typeof result.session === 'string' &&
          typeof result.response_directory === 'string' &&
          Array.isArray(result.pending_requests) &&
          result.pending_requests.length > 0,
        'Invalid pending host request list',
      );
      const session = await directory(absolute(result.session, 'Session directory'));
      requireValue(
        path.dirname(session) === path.join(state, 'sessions') &&
          /^[a-f0-9]{64}$/.test(path.basename(session)),
        'Session is outside the learning state',
      );
      const requestDir = await directory(path.join(session, 'requests'));
      const responseDir = await directory(
        absolute(result.response_directory, 'Response directory'),
      );
      requireValue(
        requestDir === path.join(session, 'requests') &&
          responseDir === path.join(session, 'responses'),
        'Host request directories differ from the session',
      );
      requireValue(
        canonical(await readJson(path.join(session, 'input.json'))) === canonical(options.job),
        'Session belongs to a different job',
      );
      const requestNames = (await readdir(requestDir)).filter((name) => name.endsWith('.json'));
      requireValue(requestNames.length <= maximum, 'Host request ceiling exceeded');
      const pending = result.pending_requests;
      requireValue(
        pending.length <= requestNames.length && new Set(pending).size === pending.length,
        'Invalid pending host requests',
      );
      const claimsDir = path.join(session, 'host-claims');
      await mkdir(claimsDir, { recursive: true });
      requireValue((await directory(claimsDir)) === claimsDir, 'Host claim directory is not local');
      for (const candidate of pending) {
        requireValue(typeof candidate === 'string', 'Invalid pending request path');
        const filename = absolute(candidate, 'Pending request');
        requireValue(
          path.dirname(filename) === requestDir &&
            /^request-[a-f0-9]{32}\.json$/.test(path.basename(filename)),
          'Pending request is outside the session',
        );
        const requestText = await readText(filename);
        const request = validateRequest(
          JSON.parse(requestText),
          requestText,
          options.job,
          filename,
        );
        const claimFile = path.join(claimsDir, path.basename(filename));
        try {
          await lstat(claimFile);
          return {
            status: 'uncertain-execution',
            reason:
              'A previously claimed request has no response. Inspect and reconcile it before any retry.',
            request_id: request.request_id,
            processed,
            boundary: REPORT_BOUNDARY,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const execution =
          request.kind === 'execute'
            ? await prepareIsolated(request, options.isolation, claimsDir)
            : undefined;
        await writeImmutable(claimFile, {
          job_id: options.job.job_id,
          job_fingerprint: options.job.job_fingerprint,
          request_id: request.request_id,
          request_fingerprint: request.request_fingerprint,
          actor_context: request.actor_context,
          kind: request.kind,
          claimed_at: new Date().toISOString(),
          ...(execution ?? {}),
        });
        let response: HostResponse;
        try {
          response = validateResponse(
            await options.handle(request, execution),
            request,
            options.job,
          );
        } catch (error) {
          return {
            status: 'uncertain-execution',
            reason: `Host callback failed or returned an invalid response: ${error instanceof Error ? error.message : String(error)}`,
            request_id: request.request_id,
            processed,
            boundary: REPORT_BOUNDARY,
          };
        }
        await persistResponse(session, request, options.job, response);
        processed++;
      }
    }
    return {
      status: 'blocked',
      reason: 'Host request ceiling reached.',
      processed,
      boundary: REPORT_BOUNDARY,
    };
  } catch (error) {
    const issue = uncertain(error);
    if (issue)
      return { status: 'uncertain-execution', ...issue, processed, boundary: REPORT_BOUNDARY };
    return {
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      processed,
      boundary: REPORT_BOUNDARY,
    };
  } finally {
    await lockHandle.close();
    await unlink(lock);
  }
}

export async function fingerprintHarness2Snapshot(snapshot: string): Promise<string> {
  const root = await directory(absolute(snapshot, 'Source snapshot'));
  const entries: { path: string; kind: 'directory' | 'file'; size?: number; sha256?: string }[] =
    [];
  let totalBytes = 0;
  const visit = async (current: string): Promise<void> => {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const filename = path.join(current, name);
      const stats = await lstat(filename);
      requireValue(!stats.isSymbolicLink(), 'Snapshot links are not allowed');
      requireValue(contains(root, await realpath(filename)), 'Snapshot entry escaped its root');
      const relative = path.relative(root, filename).split(path.sep).join('/');
      requireValue(++totalEntries <= 4096, 'Snapshot exceeds the file-count limit');
      if (stats.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' });
        await visit(filename);
      } else {
        requireValue(stats.isFile(), 'Snapshot entries must be ordinary files');
        totalBytes += stats.size;
        requireValue(totalBytes <= 64 * 1024 * 1024, 'Snapshot exceeds the byte limit');
        const bytes = await readFile(filename);
        const after = await lstat(filename);
        requireValue(
          after.isFile() &&
            !after.isSymbolicLink() &&
            after.size === stats.size &&
            after.mtimeMs === stats.mtimeMs &&
            bytes.length === stats.size,
          'Snapshot changed during inspection',
        );
        entries.push({
          path: relative,
          kind: 'file',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  };
  let totalEntries = 0;
  await visit(root);
  return digest({ version: 1, entries });
}

interface StepContext {
  job: Harness2Job;
  jobFile: string;
  state: string;
}
interface SessionPaths {
  session: string;
  requests: string;
  responses: string;
  claims: string;
}

async function withStepLock(
  options: HostStepOptions,
  operation: (context: StepContext) => Promise<HostStepResult>,
  existingState = false,
): Promise<HostStepResult> {
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  let lock = '';
  try {
    const jobFile = absolute(options.job_file, 'Job file');
    const job = (await readJson(jobFile)) as Harness2Job;
    validateJob(job);
    const stateDir = absolute(options.state_dir, 'Learning state');
    if (!existingState) await mkdir(stateDir, { recursive: true });
    const state = await directory(stateDir);
    lock = path.join(state, 'host-driver.lock');
    try {
      lockHandle = await open(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        return {
          status: 'blocked',
          reason: 'Another host driver or a crash lock exists; inspect it before retrying.',
          boundary: REPORT_BOUNDARY,
        };
      throw error;
    }
    await lockHandle.writeFile(
      JSON.stringify({
        pid: process.pid,
        job_id: job.job_id,
        started_at: new Date().toISOString(),
      }),
    );
    requireValue(
      canonical(await readJson(jobFile)) === canonical(job),
      'Saved job changed while acquiring the host lock',
    );
    await assertReceiptsForJob(state, job);
    return await operation({ job, jobFile, state });
  } catch (error) {
    const issue = uncertain(error);
    if (issue) return { status: 'uncertain-execution', ...issue, boundary: REPORT_BOUNDARY };
    return {
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      boundary: REPORT_BOUNDARY,
    };
  } finally {
    if (lockHandle) {
      await lockHandle.close();
      await unlink(lock);
    }
  }
}

async function sessionPaths(
  context: StepContext,
  filename: string,
  existingClaims = false,
): Promise<SessionPaths> {
  const session = await directory(absolute(filename, 'Session directory'));
  requireValue(
    path.dirname(session) === path.join(context.state, 'sessions') &&
      /^[a-f0-9]{64}$/.test(path.basename(session)),
    'Session is outside the learning state',
  );
  const requests = await directory(path.join(session, 'requests'));
  const responses = await directory(path.join(session, 'responses'));
  requireValue(
    requests === path.join(session, 'requests') && responses === path.join(session, 'responses'),
    'Host request directories differ from the session',
  );
  requireValue(
    canonical(await readJson(path.join(session, 'input.json'))) === canonical(context.job),
    'Session belongs to a different job',
  );
  const names = (await readdir(requests)).filter((name) => name.endsWith('.json'));
  requireValue(
    context.job.policy.enabled && names.length <= context.job.policy.max_host_calls,
    'Host request ceiling exceeded',
  );
  const claims = path.join(session, 'host-claims');
  if (!existingClaims) await mkdir(claims, { recursive: true });
  requireValue((await directory(claims)) === claims, 'Host claim directory is not local');
  return { session, requests, responses, claims };
}

async function requestAt(
  paths: SessionPaths,
  requestId: string,
  job: Harness2Job,
): Promise<HostRequest> {
  requireValue(/^request-[a-f0-9]{32}$/.test(requestId), 'Invalid request identifier');
  const filename = path.join(paths.requests, `${requestId}.json`);
  const text = await readText(filename);
  return validateRequest(JSON.parse(text), text, job, filename);
}
async function pathExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function stepIsolation(
  isolation: StepIsolation | undefined,
  paths: SessionPaths,
  state: string,
): Promise<IsolatedExecution> {
  requireValue(
    isolation && /^[a-f0-9]{64}$/.test(isolation.source_fingerprint),
    'A frozen source snapshot fingerprint is required',
  );
  const root = await directory(absolute(isolation.root, 'Isolation root'));
  const live = await directory(absolute(isolation.live_workspace, 'Live workspace'));
  const snapshot = await directory(absolute(isolation.snapshot, 'Source snapshot'));
  const workspace = await directory(absolute(isolation.workspace, 'Isolated workspace'));
  requireValue(
    !overlaps(root, live) && !overlaps(root, state),
    'The isolation root must not overlap live work or learning state',
  );
  requireValue(
    contains(root, workspace) && !overlaps(workspace, live),
    'Execution workspace is outside the isolation root or overlaps live work',
  );
  requireValue(
    !overlaps(snapshot, workspace) && !overlaps(snapshot, live),
    'The frozen snapshot must be separate from live and isolated workspaces',
  );
  for (const filename of await readdir(paths.claims)) {
    if (!filename.endsWith('.json')) continue;
    const claim = await readJson(path.join(paths.claims, filename));
    if (record(claim) && claim.kind === 'execute') {
      requireValue(
        claim.source_fingerprint === isolation.source_fingerprint,
        'All probe executions must use the same frozen source snapshot',
      );
      requireValue(
        typeof claim.workspace === 'string' && !overlaps(workspace, claim.workspace),
        'Each execution needs a distinct isolated workspace',
      );
    }
  }
  requireValue(
    (await fingerprintHarness2Snapshot(snapshot)) === isolation.source_fingerprint,
    'Frozen source snapshot fingerprint differs',
  );
  requireValue(
    (await fingerprintHarness2Snapshot(workspace)) === isolation.source_fingerprint,
    'Isolated workspace differs from the frozen source snapshot',
  );
  return { workspace, source_fingerprint: isolation.source_fingerprint };
}

async function runStepBridge(options: HostStepOptions, context: StepContext): Promise<JsonRecord> {
  const timeout = options.timeout_ms ?? 30000;
  requireValue(
    Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 60000,
    'Bridge timeout must be between 1 and 60000 milliseconds',
  );
  const result = await (options.run_bridge ?? invokePythonBridge)({
    job_file: context.jobFile,
    state_dir: context.state,
    python: options.python ?? 'python',
    bridge_file: absolute(
      options.bridge_file ?? fileURLToPath(new URL('../harness2_bridge.py', import.meta.url)),
      'Bridge file',
    ),
    upstream: options.upstream,
    timeout_ms: timeout,
  });
  requireValue(record(result) && typeof result.status === 'string', 'Invalid bridge result');
  return result;
}

export async function nextHarness2Step(options: HostStepOptions): Promise<HostStepResult> {
  return withStepLock(options, async (context) => {
    const result = await runStepBridge(options, context);
    const terminal = checkedTerminal(result, context.job);
    if (terminal) return { ...terminal, boundary: REPORT_BOUNDARY };
    if (result.status !== 'needs-host')
      return {
        status: result.status === 'unavailable' ? 'unavailable' : 'blocked',
        reason: typeof result.reason === 'string' ? result.reason : 'Bridge did not complete.',
        boundary: REPORT_BOUNDARY,
      };
    requireValue(
      result.job_id === context.job.job_id &&
        typeof result.session === 'string' &&
        typeof result.response_directory === 'string' &&
        Array.isArray(result.pending_requests) &&
        result.pending_requests.length > 0,
      'Invalid pending host request list',
    );
    const paths = await sessionPaths(context, result.session);
    requireValue(
      (await directory(absolute(result.response_directory, 'Response directory'))) ===
        paths.responses,
      'Response directory differs from the session',
    );
    requireValue(
      new Set(result.pending_requests).size === result.pending_requests.length,
      'Duplicate pending request',
    );
    const requests: PendingRequest[] = [];
    for (const candidate of result.pending_requests) {
      requireValue(typeof candidate === 'string', 'Invalid pending request path');
      const filename = absolute(candidate, 'Pending request');
      requireValue(
        path.dirname(filename) === paths.requests &&
          /^request-[a-f0-9]{32}\.json$/.test(path.basename(filename)),
        'Pending request is outside the session',
      );
      const request = await requestAt(paths, path.basename(filename, '.json'), context.job);
      requireValue(
        !(await pathExists(path.join(paths.responses, path.basename(filename)))),
        'Bridge reported a response as pending',
      );
      const claimFile = path.join(paths.claims, path.basename(filename));
      const claimed = await pathExists(claimFile);
      if (claimed) {
        const claim = await readJson(claimFile);
        checkClaim(claim, request, context.job);
      }
      requests.push({
        request_id: request.request_id,
        request_fingerprint: request.request_fingerprint,
        kind: request.kind,
        label: request.label,
        actor_context: request.actor_context,
        claimed,
      });
    }
    return { status: 'needs-host', session: paths.session, requests, boundary: REPORT_BOUNDARY };
  });
}

export async function claimHarness2Request(options: HostClaimOptions): Promise<HostStepResult> {
  return withStepLock(options, async (context) => {
    const paths = await sessionPaths(context, options.session);
    const request = await requestAt(paths, options.request_id, context.job);
    const name = `${request.request_id}.json`;
    requireValue(
      !(await pathExists(path.join(paths.responses, name))),
      'Request already has a response; advance the bridge instead',
    );
    if (await pathExists(path.join(paths.claims, name)))
      return {
        status: 'uncertain-execution',
        reason:
          'This request was already claimed. Inspect its host execution and reconcile a response before retrying.',
        request_id: request.request_id,
        boundary: REPORT_BOUNDARY,
      };
    const current = await runStepBridge(options, context);
    if (current.status === 'unavailable')
      return {
        status: 'unavailable',
        reason: typeof current.reason === 'string' ? current.reason : 'Bridge is unavailable.',
        boundary: REPORT_BOUNDARY,
      };
    if (current.status === 'blocked')
      return {
        status: 'blocked',
        reason: typeof current.reason === 'string' ? current.reason : 'Bridge did not complete.',
        boundary: REPORT_BOUNDARY,
      };
    requireValue(
      current.status === 'needs-host' &&
        current.job_id === context.job.job_id &&
        current.session === paths.session &&
        current.response_directory === paths.responses &&
        Array.isArray(current.pending_requests) &&
        current.pending_requests.includes(path.join(paths.requests, name)),
      'The request is no longer pending in the bridge',
    );
    const execution =
      request.kind === 'execute'
        ? await stepIsolation(options.isolation, paths, context.state)
        : undefined;
    await writeImmutable(path.join(paths.claims, name), {
      job_id: context.job.job_id,
      job_fingerprint: context.job.job_fingerprint,
      request_id: request.request_id,
      request_fingerprint: request.request_fingerprint,
      actor_context: request.actor_context,
      kind: request.kind,
      claimed_at: new Date().toISOString(),
      ...(execution ?? {}),
      ...(request.kind === 'execute' && options.isolation
        ? {
            snapshot: await directory(absolute(options.isolation.snapshot, 'Source snapshot')),
            isolation_root: await directory(absolute(options.isolation.root, 'Isolation root')),
            live_workspace: await directory(
              absolute(options.isolation.live_workspace, 'Live workspace'),
            ),
          }
        : {}),
    });
    return {
      status: 'claimed',
      request,
      ...(execution ? { execution } : {}),
      boundary: REPORT_BOUNDARY,
    };
  });
}

export async function completeHarness2Request(
  options: HostCompleteOptions,
): Promise<HostStepResult> {
  return withStepLock(options, async (context) => {
    const paths = await sessionPaths(context, options.session);
    const request = await requestAt(paths, options.request_id, context.job);
    const name = `${request.request_id}.json`;
    const claim = await readJson(path.join(paths.claims, name));
    checkClaim(claim, request, context.job);
    if (request.kind === 'execute' && typeof claim.snapshot === 'string') {
      requireValue(
        typeof claim.source_fingerprint === 'string' &&
          (await fingerprintHarness2Snapshot(claim.snapshot)) === claim.source_fingerprint,
        'Frozen source snapshot changed after execution was claimed',
      );
    }
    const response = validateResponse(options.response, request, context.job);
    const created = await persistResponse(paths.session, request, context.job, response);
    return {
      status: created ? 'submitted' : 'already-submitted',
      request_id: request.request_id,
      boundary: REPORT_BOUNDARY,
    };
  });
}

export async function rejectedHarness2Baseline(
  options: HostBaselineOptions,
): Promise<HostStepResult> {
  return withStepLock(
    options,
    async (context) => {
      const paths = await sessionPaths(context, options.session, true);
      const report = await readJson(path.join(paths.session, 'report.json'));
      requireValue(
        record(report) && report.status === 'rejected' && report.learned === false,
        'Only a terminal rejected improvement may return its baseline',
      );
      const terminal = checkedTerminal(report, context.job);
      requireValue(terminal?.status === 'rejected', 'The improvement rejection is invalid');
      const requests: HostRequest[] = [];
      for (const filename of await readdir(paths.requests)) {
        if (!filename.endsWith('.json')) continue;
        requireValue(/^request-[a-f0-9]{32}\.json$/.test(filename), 'Invalid request file name');
        requests.push(await requestAt(paths, path.basename(filename, '.json'), context.job));
      }
      const baselines = requests.filter(
        (item) => item.kind === 'execute' && item.label === 'base1',
      );
      const reviews = requests.filter((item) => item.kind === 'adoption-review');
      requireValue(
        baselines.length === 1 && reviews.length === 1,
        'A unique baseline and adoption review are required',
      );
      const baseline = baselines[0];
      const review = reviews[0];
      requireValue(
        canonical(baseline.payload.harness) === canonical(context.job.base_harness),
        'Baseline harness differs from the saved job',
      );
      const loadRecorded = async (request: HostRequest) => {
        const name = `${request.request_id}.json`;
        const claim = await readJson(path.join(paths.claims, name));
        checkClaim(claim, request, context.job);
        const response = validateResponse(
          await readJson(path.join(paths.responses, name)),
          request,
          context.job,
        );
        requireValue(response.status === 'completed', 'A completed host response is required');
        const receipt = await readJson(path.join(paths.session, 'host-receipts', name));
        requireValue(
          canonical(receipt) === canonical(responseReceipt(request, context.job, claim, response)),
          'Host response receipt differs',
        );
        return { claim, response };
      };
      const recordedBaseline = await loadRecorded(baseline);
      const recordedReview = await loadRecorded(review);
      requireValue(
        recordedReview.response.decision === 'rejected' &&
          record(report.supervisor_review) &&
          recordedReview.response.reason === report.supervisor_review.reason &&
          canonical(recordedReview.response.evidence) ===
            canonical(report.supervisor_review.evidence),
        'The recorded supervisor rejection differs from the terminal report',
      );
      const claim = recordedBaseline.claim;
      requireValue(
        typeof claim.snapshot === 'string' &&
          typeof claim.workspace === 'string' &&
          typeof claim.isolation_root === 'string' &&
          typeof claim.live_workspace === 'string' &&
          typeof claim.source_fingerprint === 'string' &&
          /^[a-f0-9]{64}$/.test(claim.source_fingerprint),
        'A verified baseline isolation claim is required',
      );
      const snapshot = await directory(absolute(claim.snapshot, 'Source snapshot'));
      const workspace = await directory(absolute(claim.workspace, 'Baseline workspace'));
      const root = await directory(absolute(claim.isolation_root, 'Isolation root'));
      const live = await directory(absolute(claim.live_workspace, 'Live workspace'));
      requireValue(
        contains(root, workspace) &&
          !overlaps(root, live) &&
          !overlaps(root, context.state) &&
          !overlaps(snapshot, workspace) &&
          !overlaps(snapshot, live),
        'Baseline isolation claim is no longer valid',
      );
      requireValue(
        (await fingerprintHarness2Snapshot(snapshot)) === claim.source_fingerprint,
        'Frozen baseline source snapshot changed',
      );
      const response = recordedBaseline.response;
      requireValue(
        Array.isArray(response.outputs) &&
          response.outputs.length === context.job.dispatch.outputs.length &&
          new Set(response.outputs.map((item: unknown) => (record(item) ? item.id : null))).size ===
            response.outputs.length &&
          response.outputs.every(
            (item: unknown) =>
              record(item) &&
              typeof item.id === 'string' &&
              context.job.dispatch.outputs.includes(item.id) &&
              typeof item.reference === 'string' &&
              !!item.reference.trim() &&
              typeof item.summary === 'string' &&
              !!item.summary.trim() &&
              typeof item.text === 'string' &&
              !!item.text.trim(),
          ),
        'Recorded baseline outputs are incomplete',
      );
      requireValue(
        Array.isArray(response.evidence) &&
          response.evidence.length > 0 &&
          response.evidence.every(
            (item: unknown) =>
              record(item) &&
              typeof item.reference === 'string' &&
              !!item.reference.trim() &&
              typeof item.summary === 'string' &&
              !!item.summary.trim(),
          ),
        'Recorded baseline evidence is incomplete',
      );
      requireValue(
        typeof context.job.owner_context === 'string' &&
          typeof context.job.supervisor_context === 'string',
        'Baseline authority is missing',
      );
      return {
        status: 'baseline-ready-for-submission',
        job_id: context.job.job_id,
        packet_id: context.job.packet_id,
        attempt: context.job.attempt,
        owner_context: context.job.owner_context,
        supervisor_context: context.job.supervisor_context,
        declared_model_binding: context.job.dispatch.model_binding,
        baseline_request_id: baseline.request_id,
        source_fingerprint: claim.source_fingerprint,
        outputs: response.outputs.map((item: JsonRecord) => ({
          id: item.id as string,
          reference: item.reference as string,
          summary: item.summary as string,
        })),
        evidence: response.evidence.map((item: JsonRecord) => ({
          reference: item.reference as string,
          summary: item.summary as string,
        })),
        host_reported_cost_usd: response.cost_usd,
        response_record: path.join(paths.responses, `${baseline.request_id}.json`),
        requires_supervisor_task_review: true,
        boundary: REPORT_BOUNDARY,
      };
    },
    true,
  );
}
