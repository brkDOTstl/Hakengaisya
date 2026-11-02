import { createHash, createHmac } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ClientCredentials,
  type LocalReport,
  prepareReport,
  submitReport,
} from '../packages/evaluator/sdk/client.ts';
import type { Report, Usage } from '../packages/evaluator/src/contract.ts';
import { canonical, identifier, validateReport } from '../packages/evaluator/src/contract.ts';
import type { Assignment, PacketResult, PacketReview, Run } from './types.ts';
import { check, requireText } from './validate.ts';

export interface ContextIdentity {
  context: string;
  model_id: string;
  evidence_reference: string;
}

export interface PeerObservation {
  reviewer_context: string;
  identities: ContextIdentity[];
  task_salt: string;
  report_id: string;
  ratings: LocalReport['ratings'];
  comment: string;
  example: string;
  guidance: string;
  attribution: LocalReport['attribution'];
  usage?: Partial<Usage>;
  usage_evidence?: string;
  cost_basis?: 'actual-billed' | 'api-equivalent-estimate';
  cost_reference?: { url: string; checked_at: string; assumptions: string };
}

type Attempt = {
  assignment: Assignment | null;
  result: PacketResult | null;
  review: PacketReview | null;
};

export type PreparedFeedback =
  | {
      status: 'ready';
      report: Report;
      task_token_scope: string;
      boundary: string;
      usage_evidence: string | null;
      local_cost_estimate: {
        usd: number;
        basis: string;
        source: { url: string; checked_at: string; assumptions: string };
        usage_evidence: string;
      } | null;
    }
  | {
      status: 'operational-only';
      record_id: string;
      reason: string;
      boundary: string;
      local_record: {
        run_id: string;
        packet_id: string;
        attempt: number;
        task_token: string;
        task_token_scope: string;
        subject_context: string;
        reviewer_context: string;
        model_id: string;
        decision: string;
        identity_evidence: string[];
        task: {
          domain: string | undefined;
          task_type: string | undefined;
          difficulty: string | undefined;
          skills: string[] | undefined;
          evidence_kind: string;
          route: string | undefined;
          effort: string | undefined;
        };
        usage: Partial<Usage> | null;
        usage_evidence: string | null;
        cost_basis: string | null;
        cost_reference: PeerObservation['cost_reference'] | null;
      };
    };

export function preparePeerFeedback(
  run: Run,
  packetId: string,
  attemptNumber: number,
  observation: PeerObservation,
): PreparedFeedback {
  const packet = Object.hasOwn(run.packets, packetId) ? run.packets[packetId] : undefined;
  check(
    packet && Number.isInteger(attemptNumber) && attemptNumber > 0,
    'Unknown packet or attempt',
  );
  let attempt: Attempt | undefined;
  if (packet.attempt === attemptNumber && packet.result && packet.review) attempt = packet;
  else attempt = packet.history.find((item) => item.attempt === attemptNumber);
  check(attempt?.assignment && attempt.result && attempt.review, 'A reviewed attempt is required');
  const { assignment, result, review } = attempt;
  check(
    result.attempt === attemptNumber && review.attempt === attemptNumber,
    'Feedback attempt must match the submitted and reviewed attempt',
  );
  check(
    observation.reviewer_context === assignment.reviewer_context &&
      review.reviewer_context === observation.reviewer_context &&
      ![assignment.owner_context, ...assignment.contributor_contexts].includes(
        observation.reviewer_context,
      ),
    'Feedback requires the actual independent reviewer context',
  );
  check(Array.isArray(observation.identities), 'Supply observed context identities');
  check(
    new Set(observation.identities.map((item) => item.context)).size ===
      observation.identities.length,
    'Context identities must be unique',
  );
  const subject = observation.identities.find((item) => item.context === assignment.owner_context);
  const reviewer = observation.identities.find(
    (item) => item.context === observation.reviewer_context,
  );
  check(subject && reviewer, 'Supply host-observed subject and reviewer identities');
  const boundReview = [...(run.journal ?? [])]
    .reverse()
    .find(
      ({ event }) =>
        event.type === 'review' &&
        event.packet_id === packetId &&
        event.attempt === attemptNumber &&
        event.actor_context === observation.reviewer_context,
    )?.event;
  if (boundReview?.type === 'review' && boundReview.reviewer_model)
    check(
      boundReview.reviewer_model === reviewer.model_id,
      'Reviewer model differs from the recorded review identity',
    );
  for (const item of [subject, reviewer]) {
    requireText(item.model_id, 'Observed model');
    requireText(item.evidence_reference, 'Identity evidence');
  }
  check(
    assignment.model_id === subject.model_id && assignment.route && assignment.effort,
    'Observed subject must match the declared model, route and effort',
  );
  identifier(observation.report_id);
  check(
    typeof observation.task_salt === 'string' && observation.task_salt.length >= 32,
    'Use a local random task salt of at least 32 characters',
  );
  const tokenScope = createHmac('sha256', observation.task_salt)
    .update('hakengaisya-cost-token-scope-v1')
    .digest('hex');
  if (observation.usage && Object.values(observation.usage).some((value) => value != null)) {
    requireText(observation.usage_evidence, 'Usage evidence');
  }
  if (observation.usage) {
    for (const [key, value] of Object.entries(observation.usage)) {
      check(
        ['input_tokens', 'output_tokens', 'cost_usd', 'wall_seconds'].includes(key) &&
          (value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)),
        'Invalid observed usage',
      );
    }
  }
  if (observation.usage?.cost_usd != null)
    check(
      ['actual-billed', 'api-equivalent-estimate'].includes(observation.cost_basis ?? ''),
      'A non-null cost needs an explicit actual-billed or api-equivalent-estimate basis',
    );
  if (observation.cost_basis === 'api-equivalent-estimate' && observation.usage?.cost_usd != null) {
    const source = observation.cost_reference;
    check(source && typeof source === 'object', 'API-equivalent cost needs a pricing source');
    requireText(source.url, 'Pricing source URL');
    requireText(source.checked_at, 'Pricing source date');
    requireText(source.assumptions, 'Pricing assumptions');
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new Error('Invalid pricing source URL');
    }
    check(
      url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        Number.isFinite(Date.parse(source.checked_at)),
      'Invalid pricing source provenance',
    );
  }
  const boundary =
    'Host-reported identities, ratings and usage are not provider-authenticated; review does not imply user acceptance. No report is transmitted.';
  if (subject.model_id === reviewer.model_id) {
    return {
      status: 'operational-only',
      record_id: observation.report_id,
      reason:
        'The current evaluator contract does not accept equal subject and reviewer model IDs, even for distinct contexts.',
      boundary,
      local_record: {
        run_id: run.run_id,
        packet_id: packetId,
        attempt: attemptNumber,
        task_token: createHmac('sha256', observation.task_salt)
          .update(`${run.run_id}/${packetId}/${attemptNumber}`)
          .digest('hex'),
        task_token_scope: tokenScope,
        subject_context: assignment.owner_context,
        reviewer_context: observation.reviewer_context,
        model_id: subject.model_id,
        decision: review.decision,
        identity_evidence: [subject.evidence_reference, reviewer.evidence_reference],
        task: {
          domain: run.domain,
          task_type: packet.task_type,
          difficulty: packet.difficulty,
          skills: packet.skills,
          evidence_kind: run.evidence_kind,
          route: assignment.route,
          effort: assignment.effort,
        },
        usage: observation.usage ?? null,
        usage_evidence: observation.usage_evidence ?? null,
        cost_basis: observation.cost_basis ?? null,
        cost_reference: observation.cost_reference ?? null,
      },
    };
  }
  check(packet.task_type && packet.difficulty && packet.skills?.length, 'Task context is required');
  const domain = run.domain === 'technical-product-design' ? 'technical-product' : run.domain;
  const report = prepareReport(
    {
      report_id: observation.report_id,
      reviewer_model: reviewer.model_id,
      subject_model: subject.model_id,
      route: assignment.route,
      effort: assignment.effort,
      local_task_identity: `${run.run_id}/${packetId}/${attemptNumber}`,
      evaluation_kind: run.evidence_kind,
      task: {
        domain: domain as LocalReport['task']['domain'],
        type: packet.task_type as LocalReport['task']['type'],
        difficulty: packet.difficulty,
        skills: packet.skills as LocalReport['task']['skills'],
      },
      ratings: observation.ratings,
      comment: observation.comment,
      example: observation.example,
      guidance: observation.guidance,
      relationship: 'review',
      attribution: observation.attribution,
      usage:
        observation.usage && observation.cost_basis === 'api-equivalent-estimate'
          ? { ...observation.usage, cost_usd: null }
          : observation.usage,
    },
    observation.task_salt,
  );
  return {
    status: 'ready',
    report,
    task_token_scope: tokenScope,
    boundary,
    usage_evidence: observation.usage_evidence ?? null,
    local_cost_estimate:
      observation.cost_basis === 'api-equivalent-estimate' && observation.usage?.cost_usd != null
        ? {
            usd: observation.usage.cost_usd,
            basis: 'api-equivalent-estimate',
            source: observation.cost_reference as NonNullable<PeerObservation['cost_reference']>,
            usage_evidence: observation.usage_evidence as string,
          }
        : null,
  };
}

export async function queuePeerFeedback(
  prepared: PreparedFeedback,
  directory: string,
): Promise<{ status: 'queued-local'; record_id: string; path: string; kind: string }> {
  check(path.isAbsolute(directory), 'Use an absolute local feedback directory');
  const id = prepared.status === 'ready' ? prepared.report.report_id : prepared.record_id;
  identifier(id);
  if (prepared.status === 'ready') validateReport(prepared.report);
  const value =
    prepared.status === 'ready'
      ? {
          kind: 'evaluator-report',
          report: prepared.report,
          task_token_scope: prepared.task_token_scope,
          local_cost_estimate: prepared.local_cost_estimate,
        }
      : { kind: 'operational-only', reason: prepared.reason, record: prepared.local_record };
  const filename = path.join(directory, `${id}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const queueStat = await lstat(directory);
  check(
    queueStat.isDirectory() && !queueStat.isSymbolicLink(),
    'Feedback queue must be a real directory',
  );
  try {
    await writeFile(filename, `${canonical(value)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    check(
      canonical(JSON.parse(await readFile(filename, 'utf8'))) === canonical(value),
      'Feedback ID has conflicting content',
    );
  }
  return { status: 'queued-local', record_id: id, path: filename, kind: value.kind };
}

export async function submitPeerFeedbackLocal(
  prepared: PreparedFeedback,
  endpoint: string,
  credentials: ClientCredentials,
): Promise<{
  status: 'accepted' | 'queued' | 'rejected' | 'operational-only';
  report_id?: string;
  reason?: string;
}> {
  if (prepared.status === 'operational-only')
    return { status: 'operational-only', reason: prepared.reason };
  const url = new URL(endpoint);
  check(
    url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'Use an explicit loopback evaluator origin',
  );
  validateReport(prepared.report);
  try {
    const receipt = await submitReport(url.origin, prepared.report, credentials);
    check(
      receipt.accepted === true && receipt.report_id === prepared.report.report_id,
      'Unexpected evaluator receipt',
    );
    return { status: 'accepted', report_id: receipt.report_id };
  } catch (error) {
    const status = (error as { status?: number }).status;
    return {
      status:
        status !== undefined && [400, 401, 403, 409, 413, 415].includes(status)
          ? 'rejected'
          : 'queued',
      report_id: prepared.report.report_id,
      reason:
        status !== undefined
          ? `Evaluator returned HTTP ${status}.`
          : 'Evaluator unavailable or receipt unverified.',
    };
  }
}

export async function flushPeerFeedbackLocal(
  directory: string,
  endpoint: string,
  credentials: ClientCredentials,
  maximum: number | undefined,
  expectedReviewerModel: string,
) {
  check(
    typeof expectedReviewerModel === 'string' && expectedReviewerModel.trim().length > 0,
    'Select the actual reviewer model before signing queued feedback',
  );
  identifier(expectedReviewerModel);
  check(path.isAbsolute(directory), 'Use an absolute local feedback directory');
  const limit = maximum ?? 3;
  check(Number.isInteger(limit) && limit >= 1 && limit <= 3, 'Flush limit must be 1 to 3');
  const url = new URL(endpoint);
  check(
    url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'Use an explicit loopback evaluator origin',
  );
  const rootStat = await lstat(directory);
  check(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    'Feedback directory must be a real directory',
  );
  const root = await realpath(directory);
  const receiptDir = path.join(root, 'receipts');
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const receiptStat = await lstat(receiptDir);
  check(
    receiptStat.isDirectory() &&
      !receiptStat.isSymbolicLink() &&
      (await realpath(receiptDir)) === receiptDir,
    'Feedback receipt directory must remain inside the queue',
  );
  const names = (await readdir(root))
    .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.json$/.test(name))
    .sort();
  check(names.length <= 10000, 'Feedback queue exceeds the bounded record limit');
  const endpointId = createHash('sha256').update(url.origin).digest('hex').slice(0, 16);
  const results: Array<{ record_id: string; status: string; reason?: string }> = [];
  let skipped = 0;
  let unmatched = 0;
  for (const name of names) {
    if (results.length >= limit) break;
    const filename = path.join(root, name);
    try {
      const stat = await lstat(filename);
      check(
        stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000,
        'Invalid queued feedback file',
      );
      const stored: unknown = JSON.parse(await readFile(filename, 'utf8'));
      check(
        stored && typeof stored === 'object' && !Array.isArray(stored),
        'Invalid queued feedback',
      );
      const value = stored as Record<string, unknown>;
      if (value.kind === 'operational-only') {
        skipped++;
        continue;
      }
      check(value.kind === 'evaluator-report', 'Unknown queued feedback kind');
      const report = validateReport(value.report);
      check(`${report.report_id}.json` === name, 'Feedback filename and report ID differ');
      if (report.reviewer_model !== expectedReviewerModel) {
        unmatched++;
        continue;
      }
      const reportHash = createHash('sha256').update(canonical(report)).digest('hex');
      const receiptFile = path.join(receiptDir, `${report.report_id}-${endpointId}.json`);
      try {
        const existing: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));
        check(
          existing &&
            typeof existing === 'object' &&
            !Array.isArray(existing) &&
            (existing as Record<string, unknown>).report_id === report.report_id &&
            (existing as Record<string, unknown>).report_sha256 === reportHash &&
            (existing as Record<string, unknown>).endpoint === url.origin &&
            (existing as Record<string, unknown>).status === 'accepted',
          'Feedback receipt differs from queued report',
        );
        skipped++;
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const prepared: PreparedFeedback = {
        status: 'ready',
        report,
        task_token_scope: '',
        local_cost_estimate: null,
        usage_evidence: null,
        boundary: 'Queued sanitized report.',
      };
      const submitted = await submitPeerFeedbackLocal(prepared, url.origin, credentials);
      results.push({
        record_id: report.report_id,
        status: submitted.status,
        ...(submitted.reason ? { reason: submitted.reason } : {}),
      });
      if (submitted.status !== 'accepted') break;
      const receipt = {
        report_id: report.report_id,
        report_sha256: reportHash,
        endpoint: url.origin,
        status: 'accepted',
      };
      try {
        await writeFile(receiptFile, `${canonical(receipt)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        check(
          canonical(JSON.parse(await readFile(receiptFile, 'utf8'))) === canonical(receipt),
          'Feedback receipt conflicts',
        );
      }
    } catch (error) {
      results.push({
        record_id: name.slice(0, -5),
        status: 'invalid',
        reason: error instanceof Error ? error.message : 'Invalid queued feedback.',
      });
      break;
    }
  }
  return {
    results,
    skipped,
    unmatched,
    boundary:
      'Only sanitized evaluator reports are sent to the explicit numeric-loopback endpoint. Other reviewer identities remain queued. Local cost metadata and operational-only records are never uploaded.',
  };
}
