import { sha256Digest } from './canonical.ts';
import type {
  AssignmentInput,
  BriefInput,
  ComplianceCheckpoint,
  ComplianceCheckpointEvent,
  ComplianceCitation,
  ComplianceCiteEvent,
  ComplianceMonitorState,
  ComplianceResolveEvent,
  ComplianceRuleEvent,
  ComplianceSeverity,
  ComplianceViolationKind,
  GoverningDocument,
  GoverningDocumentInput,
  Packet,
  ReviewDecision,
  Run,
  SettledDecision,
  SettledDecisionInput,
  WorkerInput,
} from './types.ts';
import { check, isRecord, requireText } from './validate.ts';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_CONTEXT_LENGTH = 160;
const MAX_RULE_TEXT = 1200;

const CONFIG_FIELDS = [
  'enabled',
  'monitor_context',
  'watched_contexts',
  'decisions',
  'documents',
  'block_handover_on_open_citations',
  'block_dispatch_on_target_citation',
  'require_checkpoint_before_handover',
];

const DECISION_FIELDS = ['id', 'summary', 'source', 'must_not_reask', 'applies_to'];
const DOCUMENT_FIELDS = ['id', 'reference', 'requirement'];

export const COMPLIANCE_VIOLATION_KINDS: readonly ComplianceViolationKind[] = [
  'forgotten-decision',
  'violated-decision',
  'reasked-settled-decision',
  'doc-drift',
  'unapproved-deviation',
];

const SEVERITIES: readonly ComplianceSeverity[] = ['blocking', 'warning'];

const L0_MONITOR_CHARTER =
  'You are the isolated Requirement & Decision Compliance Monitor. You perform ZERO production work, write NO deliverables, and never take delivery-signoff authority. Your sole job is to hold the authoritative ledger of settled owner decisions, governing documents, and declared requirements in a clean uncompacted context, audit the primary lead and major executors against them, and immediately issue a compliance citation whenever anyone forgets a settled decision, drifts from a document, substitutes an unapproved approach, or attempts to re-ask the owner an already-settled decision.';

function requireIdentifier(value: unknown, label: string): string {
  check(
    typeof value === 'string' && ID_PATTERN.test(value),
    `${label} must match ${ID_PATTERN.source}`,
  );
  return value;
}

function requireBoundedText(value: unknown, label: string, max = MAX_RULE_TEXT): string {
  requireText(value, label);
  check(value.length <= max, `${label} exceeds maximum length of ${max} characters`);
  return value.trim();
}

function normalizeAppliesTo(value: unknown): string[] {
  if (value === undefined) return [];
  check(Array.isArray(value), 'Decision applies_to must be an array');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    requireText(item, 'Decision applies_to entry');
    const trimmed = item.trim();
    check(!seen.has(trimmed), 'Decision applies_to entries must be unique');
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeDecisionInput(
  raw: unknown,
  recordedBy: string,
  revision: number,
): SettledDecision {
  check(
    isRecord(raw) && Object.keys(raw).every((key) => DECISION_FIELDS.includes(key)),
    'Unknown or invalid settled decision fields',
  );
  const input = raw as unknown as SettledDecisionInput;
  const id = requireIdentifier(input.id, 'Settled decision identifier');
  const summary = requireBoundedText(input.summary, 'Settled decision summary');
  const source = requireBoundedText(input.source, 'Settled decision source', 400);
  if (input.must_not_reask !== undefined) {
    check(typeof input.must_not_reask === 'boolean', 'Decision must_not_reask must be boolean');
  }
  return {
    id,
    summary,
    source,
    must_not_reask: input.must_not_reask ?? true,
    applies_to: normalizeAppliesTo(input.applies_to),
    status: 'active',
    recorded_by: recordedBy,
    recorded_at_revision: revision,
  };
}

function normalizeDocumentInput(
  raw: unknown,
  recordedBy: string,
  revision: number,
): GoverningDocument {
  check(
    isRecord(raw) && Object.keys(raw).every((key) => DOCUMENT_FIELDS.includes(key)),
    'Unknown or invalid governing document fields',
  );
  const input = raw as unknown as GoverningDocumentInput;
  const id = requireIdentifier(input.id, 'Governing document identifier');
  const reference = requireBoundedText(input.reference, 'Governing document reference', 400);
  const requirement = requireBoundedText(input.requirement, 'Governing document requirement');
  return {
    id,
    reference,
    requirement,
    status: 'active',
    recorded_by: recordedBy,
    recorded_at_revision: revision,
  };
}

function assertMonitorIsolatedFromBrief(monitor: string, brief: BriefInput): void {
  check(
    monitor !== brief.lead_context,
    'Compliance monitor must use a dedicated context separate from lead_context',
  );
  for (const line of brief.reporting_lines ?? []) {
    check(
      line.supervisor_context !== monitor && line.subordinate_context !== monitor,
      'Compliance monitor does no production or delivery-signoff work; keep it outside reporting_lines',
    );
  }
  for (const work of brief.work_items ?? []) {
    check(
      work.supervisor_context !== monitor,
      'Compliance monitor cannot act as a work packet supervisor',
    );
  }
  for (const worker of brief.workers ?? []) {
    check(
      worker.context_id !== monitor,
      'Compliance monitor cannot appear as a production worker context',
    );
  }
  for (const key of brief.planning_limits?.warm_context_keys ?? []) {
    check(key !== monitor, 'Compliance monitor cannot be listed in warm_context_keys');
  }
}

export function normalizeComplianceMonitor(
  value: unknown,
  brief: BriefInput,
): ComplianceMonitorState | undefined {
  if (value === undefined) return undefined;
  check(
    isRecord(value) && Object.keys(value).every((key) => CONFIG_FIELDS.includes(key)),
    'Unknown or invalid compliance_monitor fields',
  );
  check(typeof value.enabled === 'boolean', 'compliance_monitor.enabled must be boolean');
  if (!value.enabled) {
    return {
      enabled: false,
      monitor_context: '',
      watched_contexts: [],
      block_handover_on_open_citations: true,
      block_dispatch_on_target_citation: true,
      require_checkpoint_before_handover: true,
      decisions: [],
      documents: [],
      citations: [],
      checkpoints: [],
    };
  }
  requireText(value.monitor_context, 'Compliance monitor context');
  const monitor = value.monitor_context.trim();
  check(
    monitor === value.monitor_context && monitor.length <= MAX_CONTEXT_LENGTH,
    'Compliance monitor context must be a trimmed identifier',
  );
  assertMonitorIsolatedFromBrief(monitor, brief);

  const watchedRaw = value.watched_contexts ?? [];
  check(Array.isArray(watchedRaw), 'watched_contexts must be an array');
  const watchedSet = new Set<string>();
  const watched: string[] = [];
  for (const item of watchedRaw) {
    requireText(item, 'Watched context');
    const trimmed = item.trim();
    check(trimmed !== monitor, 'Compliance monitor cannot watch itself');
    check(!watchedSet.has(trimmed), 'watched_contexts entries must be unique');
    watchedSet.add(trimmed);
    watched.push(trimmed);
  }

  for (const flag of [
    'block_handover_on_open_citations',
    'block_dispatch_on_target_citation',
    'require_checkpoint_before_handover',
  ] as const) {
    if (value[flag] !== undefined) {
      check(typeof value[flag] === 'boolean', `compliance_monitor.${flag} must be boolean`);
    }
  }

  const decisionsRaw = value.decisions ?? [];
  check(Array.isArray(decisionsRaw), 'compliance_monitor.decisions must be an array');
  const decisionIds = new Set<string>();
  const decisions = decisionsRaw.map((item) => {
    const normalized = normalizeDecisionInput(item, monitor, 0);
    check(!decisionIds.has(normalized.id), `Duplicate settled decision id: ${normalized.id}`);
    decisionIds.add(normalized.id);
    return normalized;
  });

  const documentsRaw = value.documents ?? [];
  check(Array.isArray(documentsRaw), 'compliance_monitor.documents must be an array');
  const documentIds = new Set<string>();
  const documents = documentsRaw.map((item) => {
    const normalized = normalizeDocumentInput(item, monitor, 0);
    check(!documentIds.has(normalized.id), `Duplicate governing document id: ${normalized.id}`);
    documentIds.add(normalized.id);
    return normalized;
  });

  return {
    enabled: true,
    monitor_context: monitor,
    watched_contexts: watched,
    block_handover_on_open_citations: (value.block_handover_on_open_citations as boolean) ?? true,
    block_dispatch_on_target_citation: (value.block_dispatch_on_target_citation as boolean) ?? true,
    require_checkpoint_before_handover:
      (value.require_checkpoint_before_handover as boolean) ?? true,
    decisions,
    documents,
    citations: [],
    checkpoints: [],
  };
}

export function assertMonitorNotInWorkers(
  monitorContext: string | undefined,
  workers: WorkerInput[],
): void {
  if (!monitorContext) return;
  for (const worker of workers) {
    check(
      worker.context_id !== monitorContext,
      'Compliance monitor cannot appear as a production worker context',
    );
  }
}

export function assertMonitorIsolation(
  run: Run,
  assignment: Partial<AssignmentInput>,
  actorContext?: string,
): void {
  const cm = run.compliance_monitor;
  if (!cm?.enabled) return;
  const monitor = cm.monitor_context;
  check(
    assignment.owner_context !== monitor &&
      assignment.reviewer_context !== monitor &&
      assignment.supervisor_context !== monitor &&
      !(assignment.contributor_contexts ?? []).includes(monitor) &&
      actorContext !== monitor,
    'Compliance monitor does no production or delivery-signoff work; keep it strictly isolated',
  );
}

export function watchedTargetsOf(run: Run): string[] {
  const cm = run.compliance_monitor;
  if (!cm?.enabled) return [];
  const targets = new Set<string>([run.lead_context, ...cm.watched_contexts]);
  for (const packet of Object.values(run.packets)) {
    if (packet.assignment?.owner_context) targets.add(packet.assignment.owner_context);
    for (const contributor of packet.assignment?.contributor_contexts ?? []) {
      targets.add(contributor);
    }
    if (packet.supervisor_context) targets.add(packet.supervisor_context);
  }
  for (const bound of Object.values(run.bound_execution_contexts ?? {})) {
    targets.add(bound);
  }
  targets.delete(cm.monitor_context);
  return [...targets].sort();
}

export function assertComplianceStartable(run: Run, packet: Packet): void {
  const cm = run.compliance_monitor;
  if (!cm?.enabled || !cm.block_dispatch_on_target_citation) return;
  const openBlocking = cm.citations.filter(
    (item) => item.status === 'open' && item.severity === 'blocking',
  );
  if (openBlocking.length === 0) return;

  const owner = packet.assignment?.owner_context;
  for (const citation of openBlocking) {
    if (citation.target_context === run.lead_context) {
      throw new Error(
        `Lead context has an open blocking compliance citation (${citation.id}); resolve forgotten decisions or drift before starting more work`,
      );
    }
    const matchesOwner = owner !== undefined && citation.target_context === owner;
    const matchesPacket = citation.packet_id !== null && citation.packet_id === packet.id;
    if (!matchesOwner && !matchesPacket) continue;
    // Allow corrective rework strictly for the exact reopened packet on a newer attempt.
    const isCorrectiveRework =
      citation.packet_id === packet.id &&
      citation.attempt !== null &&
      packet.attempt > citation.attempt;
    if (!isCorrectiveRework) {
      throw new Error(
        `Target executor or packet has an open blocking compliance citation (${citation.id}); correct and resolve the violation before starting work`,
      );
    }
  }
}

export interface HandoverComplianceClearance {
  ready: boolean;
  latest_required_revision: number;
  open_blocking_citation_ids: string[];
  missing_decision_ids: string[];
  missing_document_ids: string[];
  latest_clear_checkpoint_id: string | null;
  latest_clear_checkpoint_revision: number | null;
}

export function handoverClearance(run: Run): HandoverComplianceClearance {
  const cm = run.compliance_monitor;
  if (!cm?.enabled) {
    return {
      ready: true,
      latest_required_revision: 0,
      open_blocking_citation_ids: [],
      missing_decision_ids: [],
      missing_document_ids: [],
      latest_clear_checkpoint_id: null,
      latest_clear_checkpoint_revision: null,
    };
  }
  let latestRequiredRevision = 0;
  for (const entry of run.journal) {
    const type = entry?.event?.type;
    if (type === 'submit' || type === 'compliance_rule' || type === 'replan') {
      if (entry.revision > latestRequiredRevision) latestRequiredRevision = entry.revision;
    }
  }
  const activeDecisionIds = cm.decisions
    .filter((item) => item.status === 'active')
    .map((item) => item.id);
  const activeDocumentIds = cm.documents
    .filter((item) => item.status === 'active')
    .map((item) => item.id);
  const openBlocking = cm.citations
    .filter((item) => item.status === 'open' && item.severity === 'blocking')
    .map((item) => item.id);

  const clearCheckpoints = cm.checkpoints
    .filter(
      (cp) =>
        cp.status === 'clear' &&
        cp.recorded_by === cm.monitor_context &&
        cp.recorded_at_revision >= latestRequiredRevision,
    )
    .sort((a, b) => b.recorded_at_revision - a.recorded_at_revision);

  let bestMissingDecisions = activeDecisionIds;
  let bestMissingDocuments = activeDocumentIds;
  let qualifying: ComplianceCheckpoint | null = null;

  for (const cp of clearCheckpoints) {
    const missingDecisions = activeDecisionIds.filter(
      (id) => !cp.checked_decision_ids.includes(id),
    );
    const missingDocuments = activeDocumentIds.filter(
      (id) => !cp.checked_document_ids.includes(id),
    );
    if (missingDecisions.length === 0 && missingDocuments.length === 0) {
      qualifying = cp;
      bestMissingDecisions = [];
      bestMissingDocuments = [];
      break;
    }
    if (
      missingDecisions.length + missingDocuments.length <
      bestMissingDecisions.length + bestMissingDocuments.length
    ) {
      bestMissingDecisions = missingDecisions;
      bestMissingDocuments = missingDocuments;
    }
  }

  const ready =
    (!cm.block_handover_on_open_citations || openBlocking.length === 0) &&
    (!cm.require_checkpoint_before_handover || qualifying !== null);

  return {
    ready,
    latest_required_revision: latestRequiredRevision,
    open_blocking_citation_ids: openBlocking,
    missing_decision_ids: bestMissingDecisions,
    missing_document_ids: bestMissingDocuments,
    latest_clear_checkpoint_id: qualifying?.id ?? null,
    latest_clear_checkpoint_revision: qualifying?.recorded_at_revision ?? null,
  };
}

export function assertComplianceReviewGate(
  run: Run,
  packet: Packet,
  decision: ReviewDecision,
  finalAcceptance: boolean,
): void {
  const cm = run.compliance_monitor;
  if (!cm?.enabled || decision !== 'accepted') return;

  const packetCitation = cm.citations.find(
    (item) =>
      item.status === 'open' && item.severity === 'blocking' && item.packet_id === packet.id,
  );
  check(
    !packetCitation,
    `Open blocking compliance citation (${packetCitation?.id ?? ''}) on packet ${packet.id} must be resolved by the compliance monitor before acceptance`,
  );

  if (!finalAcceptance) return;

  const clearance = handoverClearance(run);
  if (cm.block_handover_on_open_citations) {
    check(
      clearance.open_blocking_citation_ids.length === 0,
      `Open blocking compliance citations (${clearance.open_blocking_citation_ids.join(', ')}) prevent final handover acceptance`,
    );
  }
  if (cm.require_checkpoint_before_handover) {
    check(
      clearance.latest_clear_checkpoint_id !== null,
      'Final handover requires a current clear compliance monitor checkpoint covering all active decisions and governing documents',
    );
  }
}

export function applicableComplianceForDispatch(run: Run, packet: Packet) {
  const cm = run.compliance_monitor;
  if (!cm?.enabled) return null;
  const owner = packet.assignment?.owner_context;
  const scopeMatches = (appliesTo: string[]) =>
    appliesTo.length === 0 ||
    appliesTo.includes(packet.id) ||
    (packet.source_work_id !== undefined && appliesTo.includes(packet.source_work_id)) ||
    (owner !== undefined && appliesTo.includes(owner));

  const applicableDecisions = cm.decisions
    .filter((item) => item.status === 'active' && scopeMatches(item.applies_to))
    .map((item) => ({
      id: item.id,
      summary: item.summary,
      source: item.source,
      must_not_reask: item.must_not_reask,
    }));

  const governingDocuments = cm.documents
    .filter((item) => item.status === 'active')
    .map((item) => ({
      id: item.id,
      reference: item.reference,
      requirement: item.requirement,
    }));

  const activeCitations = cm.citations
    .filter(
      (item) =>
        item.status === 'open' &&
        (item.packet_id === packet.id ||
          (owner !== undefined && item.target_context === owner) ||
          item.target_context === run.lead_context),
    )
    .map((item) => ({
      id: item.id,
      target_context: item.target_context,
      violation_kind: item.violation_kind,
      decision_ids: [...item.decision_ids],
      document_ids: [...item.document_ids],
      observed_deviation: item.observed_deviation,
      required_correction: item.required_correction,
    }));

  return {
    monitor_context: cm.monitor_context,
    applicable_decisions: applicableDecisions,
    governing_documents: governingDocuments,
    open_correction_directives: activeCitations,
    rule: 'Follow every applicable settled decision and governing document verbatim. Never silently substitute an alternative or re-ask the owner a must_not_reask decision.',
  };
}

function cloneMonitorState(cm: ComplianceMonitorState): ComplianceMonitorState {
  return structuredClone(cm);
}

function requireEnabledMonitor(run: Run): ComplianceMonitorState {
  check(run.compliance_monitor?.enabled, 'Compliance monitor is not enabled for this run');
  return run.compliance_monitor;
}

function terminalPacketRef(
  run: Run,
  packetId?: string | null,
): { packet_id: string; attempt: number } {
  if (packetId) {
    check(Object.hasOwn(run.packets, packetId), `Unknown packet: ${packetId}`);
    return { packet_id: packetId, attempt: run.packets[packetId].attempt };
  }
  const fallback = Object.hasOwn(run.packets, 'handover')
    ? 'handover'
    : Object.keys(run.packets)[0];
  check(fallback !== undefined, 'Run has no packets');
  return { packet_id: fallback, attempt: run.packets[fallback].attempt };
}

function reopenPacketTree(run: Run, targetId: string, reason: string): string[] {
  const downstream = new Set([targetId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const packet of Object.values(run.packets)) {
      if (downstream.has(packet.id) || !packet.depends_on.some((id) => downstream.has(id))) {
        continue;
      }
      downstream.add(packet.id);
      grew = true;
    }
  }
  const reopened: string[] = [];
  for (const id of downstream) {
    const packet = structuredClone(run.packets[id]);
    if (packet.status !== 'pending' || packet.result) {
      packet.history.push({
        attempt: packet.attempt,
        status: packet.status,
        assignment: packet.assignment,
        result: packet.result,
        review: packet.review,
        invalidated_by: reason,
      });
      packet.attempt += 1;
    }
    packet.status = 'pending';
    packet.result = null;
    packet.review = null;
    packet.blocker = null;
    for (const output of packet.required_outputs) delete run.artifacts[output];
    run.packets[id] = packet;
    reopened.push(id);
  }
  return reopened;
}

export interface ComplianceRuleRequest {
  expected_revision: number;
  actor_context: string;
  event_id?: string;
  decision?: SettledDecisionInput;
  document?: GoverningDocumentInput;
  supersedes_id?: string;
  owner_change_reference?: string;
}

export function recordComplianceRule(
  current: Run,
  request: ComplianceRuleRequest,
  recordedAt: string = new Date().toISOString(),
): { run: Run; kind: 'decision' | 'document'; rule: SettledDecision | GoverningDocument } {
  const cm = requireEnabledMonitor(current);
  check(isRecord(request), 'Supply a compliance rule request object');
  check(
    request.expected_revision === current.revision,
    'Stale run revision; reload before recording a compliance rule',
  );
  requireText(request.actor_context, 'Actor context');
  const hasDecision = request.decision !== undefined;
  const hasDocument = request.document !== undefined;
  check(
    hasDecision !== hasDocument,
    'Supply exactly one of decision or document per compliance rule update',
  );

  const isSuperseding = request.supersedes_id !== undefined;
  if (isSuperseding) {
    check(
      request.actor_context === cm.monitor_context,
      'Only the compliance monitor may supersede an existing settled decision or governing document',
    );
    requireBoundedText(
      request.owner_change_reference,
      'Owner change reference for superseding a settled rule',
      400,
    );
  } else {
    check(
      request.actor_context === cm.monitor_context ||
        request.actor_context === current.lead_context,
      'Only the compliance monitor or lead context may record a new settled decision or governing document',
    );
  }

  const nextRevision = current.revision + 1;
  const nextCm = cloneMonitorState(cm);
  let kind: 'decision' | 'document';
  let rule: SettledDecision | GoverningDocument;

  if (hasDecision) {
    kind = 'decision';
    const normalized = normalizeDecisionInput(
      request.decision,
      request.actor_context,
      nextRevision,
    );
    check(
      !nextCm.decisions.some((item) => item.id === normalized.id),
      `Settled decision id already exists: ${normalized.id}`,
    );
    if (isSuperseding) {
      const target = nextCm.decisions.find(
        (item) => item.id === request.supersedes_id && item.status === 'active',
      );
      check(target, `No active settled decision found to supersede: ${request.supersedes_id}`);
      target.status = 'superseded';
      target.superseded_by = normalized.id;
      target.owner_change_reference = request.owner_change_reference?.trim();
    }
    nextCm.decisions.push(normalized);
    rule = normalized;
  } else {
    kind = 'document';
    const normalized = normalizeDocumentInput(
      request.document,
      request.actor_context,
      nextRevision,
    );
    check(
      !nextCm.documents.some((item) => item.id === normalized.id),
      `Governing document id already exists: ${normalized.id}`,
    );
    if (isSuperseding) {
      const target = nextCm.documents.find(
        (item) => item.id === request.supersedes_id && item.status === 'active',
      );
      check(target, `No active governing document found to supersede: ${request.supersedes_id}`);
      target.status = 'superseded';
      target.superseded_by = normalized.id;
      target.owner_change_reference = request.owner_change_reference?.trim();
    }
    nextCm.documents.push(normalized);
    rule = normalized;
  }

  const ref = terminalPacketRef(current, null);
  const eventId = request.event_id
    ? requireBoundedText(request.event_id, 'Event identifier', 160)
    : `compliance-rule-${nextRevision}-${rule.id}`;
  check(
    !current.journal.some((entry) => entry.event.id === eventId),
    'Event identifier already recorded',
  );
  const event: ComplianceRuleEvent = {
    type: 'compliance_rule',
    id: eventId,
    expected_revision: current.revision,
    packet_id: ref.packet_id,
    attempt: ref.attempt,
    actor_context: request.actor_context,
    kind,
    rule_id: rule.id,
    ...(request.supersedes_id ? { supersedes_id: request.supersedes_id } : {}),
    ...(request.owner_change_reference
      ? { owner_change_reference: request.owner_change_reference.trim() }
      : {}),
  };

  const updated: Run = {
    ...current,
    revision: nextRevision,
    compliance_monitor: nextCm,
    journal: [...current.journal, { revision: nextRevision, recorded_at: recordedAt, event }],
  };
  return { run: updated, kind, rule };
}

export interface ComplianceCiteRequest {
  expected_revision: number;
  actor_context: string;
  citation_id: string;
  target_context: string;
  violation_kind: ComplianceViolationKind;
  severity?: ComplianceSeverity;
  packet_id?: string;
  reopen_packet?: boolean;
  decision_ids?: string[];
  document_ids?: string[];
  observed_deviation: string;
  evidence_reference: string;
  required_correction: string;
}

export function issueComplianceCitation(
  current: Run,
  request: ComplianceCiteRequest,
  recordedAt: string = new Date().toISOString(),
) {
  const cm = requireEnabledMonitor(current);
  check(isRecord(request), 'Supply a compliance citation request object');
  check(
    request.expected_revision === current.revision,
    'Stale run revision; reload before issuing a compliance citation',
  );
  check(
    request.actor_context === cm.monitor_context,
    'Only the compliance monitor may issue compliance citations',
  );
  const citationId = requireIdentifier(request.citation_id, 'Citation identifier');
  check(
    !cm.citations.some((item) => item.id === citationId),
    `Compliance citation id already exists: ${citationId}`,
  );
  requireText(request.target_context, 'Target context');
  const target = request.target_context.trim();
  check(target !== cm.monitor_context, 'Compliance monitor cannot cite itself');
  const watched = watchedTargetsOf(current);
  check(
    watched.includes(target),
    `Target context must be lead_context or an active/watched executor: ${target}`,
  );
  check(
    COMPLIANCE_VIOLATION_KINDS.includes(request.violation_kind),
    `Invalid compliance violation kind: ${String(request.violation_kind)}`,
  );
  const severity: ComplianceSeverity = request.severity ?? 'blocking';
  check(SEVERITIES.includes(severity), 'Invalid compliance citation severity');

  const decisionIds = request.decision_ids ?? [];
  const documentIds = request.document_ids ?? [];
  check(Array.isArray(decisionIds), 'decision_ids must be an array');
  check(Array.isArray(documentIds), 'document_ids must be an array');
  check(
    new Set(decisionIds).size === decisionIds.length &&
      new Set(documentIds).size === documentIds.length,
    'Referenced decision_ids and document_ids must be unique',
  );
  check(
    decisionIds.length > 0 || documentIds.length > 0,
    'A compliance citation must cite at least one active settled decision or governing document',
  );

  const citedDecisions: SettledDecision[] = [];
  for (const id of decisionIds) {
    const found = cm.decisions.find((item) => item.id === id && item.status === 'active');
    check(found, `Unknown or inactive settled decision: ${id}`);
    citedDecisions.push(found);
  }
  const citedDocuments: GoverningDocument[] = [];
  for (const id of documentIds) {
    const found = cm.documents.find((item) => item.id === id && item.status === 'active');
    check(found, `Unknown or inactive governing document: ${id}`);
    citedDocuments.push(found);
  }

  const observedDeviation = requireBoundedText(request.observed_deviation, 'Observed deviation');
  const evidenceReference = requireBoundedText(
    request.evidence_reference,
    'Evidence reference',
    400,
  );
  const requiredCorrection = requireBoundedText(request.required_correction, 'Required correction');

  const reopenRequested = Boolean(request.reopen_packet);
  if (reopenRequested) {
    check(Boolean(request.packet_id), 'reopen_packet requires a specific packet_id');
    check(severity === 'blocking', 'Only a blocking compliance citation may reopen a packet');
  }

  const ref = terminalPacketRef(current, request.packet_id ?? null);
  const citedPacketId = request.packet_id ?? null;
  const citedAttempt = citedPacketId ? current.packets[citedPacketId].attempt : null;

  const nextRevision = current.revision + 1;
  const eventId = `compliance-cite-${citationId}`;
  check(
    !current.journal.some((entry) => entry.event.id === eventId),
    'Event identifier already recorded',
  );

  const nextCm = cloneMonitorState(cm);
  const citation: ComplianceCitation = {
    id: citationId,
    status: 'open',
    severity,
    violation_kind: request.violation_kind,
    target_context: target,
    packet_id: citedPacketId,
    attempt: citedAttempt,
    decision_ids: [...decisionIds],
    document_ids: [...documentIds],
    observed_deviation: observedDeviation,
    evidence_reference: evidenceReference,
    required_correction: requiredCorrection,
    issued_by: cm.monitor_context,
    issued_at_revision: nextRevision,
    ...(reopenRequested ? { reopened_packet: true } : {}),
  };
  nextCm.citations.push(citation);

  const updated: Run = {
    ...current,
    revision: nextRevision,
    packets: { ...current.packets },
    artifacts: { ...current.artifacts },
    compliance_monitor: nextCm,
    journal: [...current.journal],
  };

  const reopenedPackets =
    reopenRequested && citedPacketId
      ? reopenPacketTree(
          updated,
          citedPacketId,
          `Compliance citation ${citationId}: ${request.violation_kind}`,
        )
      : [];

  const event: ComplianceCiteEvent = {
    type: 'compliance_cite',
    id: eventId,
    expected_revision: current.revision,
    packet_id: ref.packet_id,
    attempt: ref.attempt,
    actor_context: cm.monitor_context,
    citation_id: citationId,
    target_context: target,
    violation_kind: request.violation_kind,
    severity,
    decision_ids: [...decisionIds],
    document_ids: [...documentIds],
    reopened_packet: reopenRequested,
  };
  updated.journal.push({ revision: nextRevision, recorded_at: recordedAt, event });

  const mustNotReask = citedDecisions.some((item) => item.must_not_reask);
  const correctionNotice = {
    addressed_to: target,
    issued_by: cm.monitor_context,
    citation_id: citationId,
    severity,
    violation_kind: request.violation_kind,
    do_not_reask_owner: mustNotReask,
    message: mustNotReask
      ? `COMPLIANCE VIOLATION (${request.violation_kind}): ${target} forgot or deviated from already-settled owner decisions [${decisionIds.join(', ')}]. Do NOT re-ask the owner — follow the settled decision and apply the required correction immediately.`
      : `COMPLIANCE VIOLATION (${request.violation_kind}): ${target} deviated from recorded requirements. Apply the required correction immediately.`,
    violated_decisions: citedDecisions.map((item) => ({
      id: item.id,
      summary: item.summary,
      source: item.source,
      must_not_reask: item.must_not_reask,
    })),
    violated_documents: citedDocuments.map((item) => ({
      id: item.id,
      reference: item.reference,
      requirement: item.requirement,
    })),
    observed_deviation: observedDeviation,
    required_correction: requiredCorrection,
    reopened_packets: reopenedPackets,
  };

  return {
    run: updated,
    citation,
    reopened_packets: reopenedPackets,
    correction_notice: correctionNotice,
  };
}

export interface ComplianceResolveRequest {
  expected_revision: number;
  actor_context: string;
  citation_id: string;
  resolution_evidence: string;
  resolution_note: string;
}

export function resolveComplianceCitation(
  current: Run,
  request: ComplianceResolveRequest,
  recordedAt: string = new Date().toISOString(),
) {
  const cm = requireEnabledMonitor(current);
  check(isRecord(request), 'Supply a compliance resolve request object');
  check(
    request.expected_revision === current.revision,
    'Stale run revision; reload before resolving a compliance citation',
  );
  check(
    request.actor_context === cm.monitor_context,
    'Only the compliance monitor may resolve a compliance citation; the cited target cannot self-clear',
  );
  requireText(request.citation_id, 'Citation identifier');
  const resolutionEvidence = requireBoundedText(
    request.resolution_evidence,
    'Resolution evidence',
    400,
  );
  const resolutionNote = requireBoundedText(request.resolution_note, 'Resolution note');

  const nextRevision = current.revision + 1;
  const nextCm = cloneMonitorState(cm);
  const citation = nextCm.citations.find((item) => item.id === request.citation_id);
  check(citation, `Unknown compliance citation: ${request.citation_id}`);
  check(
    citation.status === 'open',
    `Compliance citation is already resolved: ${request.citation_id}`,
  );

  citation.status = 'resolved';
  citation.resolved_at_revision = nextRevision;
  citation.resolved_by = cm.monitor_context;
  citation.resolution_evidence = resolutionEvidence;
  citation.resolution_note = resolutionNote;

  const ref = terminalPacketRef(current, citation.packet_id);
  const eventId = `compliance-resolve-${citation.id}`;
  check(
    !current.journal.some((entry) => entry.event.id === eventId),
    'Event identifier already recorded',
  );
  const event: ComplianceResolveEvent = {
    type: 'compliance_resolve',
    id: eventId,
    expected_revision: current.revision,
    packet_id: ref.packet_id,
    attempt: ref.attempt,
    actor_context: cm.monitor_context,
    citation_id: citation.id,
    resolution_evidence: resolutionEvidence,
    resolution_note: resolutionNote,
  };
  const updated: Run = {
    ...current,
    revision: nextRevision,
    compliance_monitor: nextCm,
    journal: [...current.journal, { revision: nextRevision, recorded_at: recordedAt, event }],
  };
  return { run: updated, citation };
}

export interface ComplianceCheckpointRequest {
  expected_revision: number;
  actor_context: string;
  checkpoint_id: string;
  target_context?: string;
  packet_id?: string;
  status: 'clear' | 'violations-found';
  checked_decision_ids: string[];
  checked_document_ids: string[];
  evidence_reference: string;
  note: string;
}

export function recordComplianceCheckpoint(
  current: Run,
  request: ComplianceCheckpointRequest,
  recordedAt: string = new Date().toISOString(),
) {
  const cm = requireEnabledMonitor(current);
  check(isRecord(request), 'Supply a compliance checkpoint request object');
  check(
    request.expected_revision === current.revision,
    'Stale run revision; reload before recording a compliance checkpoint',
  );
  check(
    request.actor_context === cm.monitor_context,
    'Only the compliance monitor may record compliance checkpoints',
  );
  const checkpointId = requireIdentifier(request.checkpoint_id, 'Checkpoint identifier');
  check(
    !cm.checkpoints.some((item) => item.id === checkpointId),
    `Compliance checkpoint id already exists: ${checkpointId}`,
  );
  check(
    request.status === 'clear' || request.status === 'violations-found',
    'Checkpoint status must be clear or violations-found',
  );
  const target = request.target_context?.trim() || 'run';
  if (target !== 'run') {
    check(target !== cm.monitor_context, 'Compliance monitor cannot checkpoint itself as a target');
    check(
      watchedTargetsOf(current).includes(target),
      `Checkpoint target must be run, lead_context, or a watched executor: ${target}`,
    );
  }
  check(Array.isArray(request.checked_decision_ids), 'checked_decision_ids must be an array');
  check(Array.isArray(request.checked_document_ids), 'checked_document_ids must be an array');
  check(
    new Set(request.checked_decision_ids).size === request.checked_decision_ids.length &&
      new Set(request.checked_document_ids).size === request.checked_document_ids.length,
    'Checked decision and document identifiers must be unique',
  );
  for (const id of request.checked_decision_ids) {
    check(
      cm.decisions.some((item) => item.id === id && item.status === 'active'),
      `Checked decision is unknown or inactive: ${id}`,
    );
  }
  for (const id of request.checked_document_ids) {
    check(
      cm.documents.some((item) => item.id === id && item.status === 'active'),
      `Checked document is unknown or inactive: ${id}`,
    );
  }
  const evidenceReference = requireBoundedText(
    request.evidence_reference,
    'Evidence reference',
    400,
  );
  const note = requireBoundedText(request.note, 'Checkpoint note');

  if (request.status === 'clear') {
    const blockingInScope = cm.citations.filter(
      (item) =>
        item.status === 'open' &&
        item.severity === 'blocking' &&
        (target === 'run' || item.target_context === target),
    );
    check(
      blockingInScope.length === 0,
      `Cannot record a clear compliance checkpoint while blocking citations remain open (${blockingInScope.map((item) => item.id).join(', ')})`,
    );
  }

  const ref = terminalPacketRef(current, request.packet_id ?? null);
  const nextRevision = current.revision + 1;
  const eventId = `compliance-checkpoint-${checkpointId}`;
  check(
    !current.journal.some((entry) => entry.event.id === eventId),
    'Event identifier already recorded',
  );

  const nextCm = cloneMonitorState(cm);
  const checkpoint: ComplianceCheckpoint = {
    id: checkpointId,
    target_context: target,
    packet_id: request.packet_id ?? null,
    attempt: request.packet_id ? current.packets[request.packet_id].attempt : null,
    status: request.status,
    checked_decision_ids: [...request.checked_decision_ids],
    checked_document_ids: [...request.checked_document_ids],
    evidence_reference: evidenceReference,
    note,
    recorded_by: cm.monitor_context,
    recorded_at_revision: nextRevision,
  };
  nextCm.checkpoints.push(checkpoint);

  const event: ComplianceCheckpointEvent = {
    type: 'compliance_checkpoint',
    id: eventId,
    expected_revision: current.revision,
    packet_id: ref.packet_id,
    attempt: ref.attempt,
    actor_context: cm.monitor_context,
    checkpoint_id: checkpointId,
    target_context: target,
    status: request.status,
    checked_decision_ids: [...request.checked_decision_ids],
    checked_document_ids: [...request.checked_document_ids],
  };
  const updated: Run = {
    ...current,
    revision: nextRevision,
    compliance_monitor: nextCm,
    journal: [...current.journal, { revision: nextRevision, recorded_at: recordedAt, event }],
  };
  return { run: updated, checkpoint, handover_clearance: handoverClearance(updated) };
}

export function prepareComplianceAudit(
  run: Run,
  options?: { target_context?: string; packet_id?: string },
) {
  const cm = requireEnabledMonitor(run);
  const targetFilter = options?.target_context?.trim();
  const packetFilter = options?.packet_id?.trim();
  if (packetFilter) {
    check(Object.hasOwn(run.packets, packetFilter), `Unknown packet: ${packetFilter}`);
  }
  const activeDecisions = cm.decisions.filter((item) => item.status === 'active');
  const activeDocuments = cm.documents.filter((item) => item.status === 'active');
  const openCitations = cm.citations.filter((item) => item.status === 'open');
  const watched = watchedTargetsOf(run);
  if (targetFilter) {
    check(watched.includes(targetFilter), `Unknown watched target: ${targetFilter}`);
  }

  const packets = Object.values(run.packets)
    .filter((packet) => {
      if (packetFilter && packet.id !== packetFilter) return false;
      if (
        targetFilter &&
        targetFilter !== run.lead_context &&
        packet.assignment?.owner_context !== targetFilter
      ) {
        return false;
      }
      return true;
    })
    .map((packet) => ({
      id: packet.id,
      status: packet.status,
      attempt: packet.attempt,
      owner_context: packet.assignment?.owner_context ?? null,
      supervisor_context: packet.supervisor_context ?? null,
      objective: packet.objective,
      declared_writes: packet.declared_writes ?? packet.assignment?.writes ?? [],
      outputs: packet.result?.outputs ?? [],
      evidence: packet.result?.evidence ?? [],
      review_decision: packet.review?.decision ?? null,
    }));

  const ledgerSnapshot = {
    run_id: run.run_id,
    objective: run.objective,
    constraints: run.constraints,
    acceptance: run.acceptance,
    active_decisions: activeDecisions.map((item) => ({
      id: item.id,
      summary: item.summary,
      source: item.source,
      must_not_reask: item.must_not_reask,
      applies_to: item.applies_to,
    })),
    active_documents: activeDocuments.map((item) => ({
      id: item.id,
      reference: item.reference,
      requirement: item.requirement,
    })),
  };

  const clearance = handoverClearance(run);
  return {
    run_id: run.run_id,
    expected_revision: run.revision,
    role: 'compliance_monitor' as const,
    actor_context: cm.monitor_context,
    writes: [] as string[],
    lead_context: run.lead_context,
    watched_targets: watched,
    filter: {
      target_context: targetFilter ?? null,
      packet_id: packetFilter ?? null,
    },
    ledger: ledgerSnapshot,
    ledger_sha256: sha256Digest(ledgerSnapshot),
    must_not_reask_decision_ids: activeDecisions
      .filter((item) => item.must_not_reask)
      .map((item) => item.id),
    superseded_counts: {
      decisions: cm.decisions.length - activeDecisions.length,
      documents: cm.documents.length - activeDocuments.length,
    },
    open_citations: structuredClone(openCitations),
    resolved_citations_count: cm.citations.length - openCitations.length,
    recent_checkpoints: structuredClone(cm.checkpoints.slice(-5)),
    handover_clearance: clearance,
    observed_packets: packets,
    prefix_cache_contract: {
      l0_monitor_charter: L0_MONITOR_CHARTER,
      frozen_charter_sha256: sha256Digest(L0_MONITOR_CHARTER),
      ledger_sha256: sha256Digest(ledgerSnapshot),
    },
    directive:
      'Perform ZERO production work. Compare lead_context and active executor actions, artifacts and pending user questions strictly against active_decisions, active_documents, constraints and acceptance. If any watched actor forgot a decision, drifted from a document, substituted an unapproved approach or attempted to re-ask a must_not_reask decision, call compliance_cite immediately citing exact decision_ids/document_ids and the mandatory correction. When verified clean, record compliance_checkpoint with status="clear".',
    boundary:
      'The compliance monitor inspects recorded artifacts and host-supplied observations without executing production edits or replacing direct-supervisor technical signoff.',
  };
}

export interface ComplianceMonitorReview {
  enabled: boolean;
  status:
    | 'disabled'
    | 'compliant'
    | 'compliant-with-citations'
    | 'pending-checkpoint'
    | 'violations-open';
  monitor_context: string | null;
  score: number | null;
  score_range: [number, number];
  tags: string[];
  active_decisions: number;
  active_documents: number;
  total_citations: number;
  open_blocking_citations: number;
  open_warning_citations: number;
  reask_violations: number;
  lead_citations: number;
  handover_clearance_ready: boolean;
}

export function summarizeComplianceMonitor(
  run: Run,
  complete = Object.values(run.packets).every((packet) => packet.status === 'accepted'),
): ComplianceMonitorReview {
  const cm = run.compliance_monitor;
  if (!cm?.enabled) {
    return {
      enabled: false,
      status: 'disabled',
      monitor_context: null,
      score: null,
      score_range: [1, 10],
      tags: [],
      active_decisions: 0,
      active_documents: 0,
      total_citations: 0,
      open_blocking_citations: 0,
      open_warning_citations: 0,
      reask_violations: 0,
      lead_citations: 0,
      handover_clearance_ready: true,
    };
  }
  const activeDecisions = cm.decisions.filter((item) => item.status === 'active').length;
  const activeDocuments = cm.documents.filter((item) => item.status === 'active').length;
  const openBlocking = cm.citations.filter(
    (item) => item.status === 'open' && item.severity === 'blocking',
  ).length;
  const openWarning = cm.citations.filter(
    (item) => item.status === 'open' && item.severity === 'warning',
  ).length;
  const blockingTotal = cm.citations.filter((item) => item.severity === 'blocking').length;
  const warningTotal = cm.citations.filter((item) => item.severity === 'warning').length;
  const reaskViolations = cm.citations.filter(
    (item) => item.violation_kind === 'reasked-settled-decision',
  ).length;
  const leadCitations = cm.citations.filter(
    (item) => item.target_context === run.lead_context,
  ).length;
  const clearance = handoverClearance(run);

  const tags: string[] = [];
  if (openBlocking > 0) tags.push('open-compliance-citation');
  if (leadCitations > 0) tags.push('lead-compliance-drift');
  if (reaskViolations > 0) tags.push('reasked-settled-decision');
  if (cm.citations.some((item) => item.violation_kind === 'forgotten-decision')) {
    tags.push('forgotten-decision');
  }
  if (cm.citations.some((item) => item.violation_kind === 'doc-drift')) {
    tags.push('doc-drift');
  }
  if (cm.require_checkpoint_before_handover && !clearance.ready && openBlocking === 0) {
    tags.push('missing-compliance-checkpoint');
  }

  let score = 10 - blockingTotal * 3 - reaskViolations - warningTotal;
  if (openBlocking > 0 && complete) score = 1;
  score = Math.max(1, Math.min(10, score));

  const status: ComplianceMonitorReview['status'] =
    openBlocking > 0
      ? 'violations-open'
      : cm.require_checkpoint_before_handover && !clearance.ready
        ? 'pending-checkpoint'
        : cm.citations.length > 0
          ? 'compliant-with-citations'
          : 'compliant';

  return {
    enabled: true,
    status,
    monitor_context: cm.monitor_context,
    score,
    score_range: [1, 10],
    tags,
    active_decisions: activeDecisions,
    active_documents: activeDocuments,
    total_citations: cm.citations.length,
    open_blocking_citations: openBlocking,
    open_warning_citations: openWarning,
    reask_violations: reaskViolations,
    lead_citations: leadCitations,
    handover_clearance_ready: clearance.ready,
  };
}
