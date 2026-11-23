import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commands } from '../lib/commands.ts';
import {
  issueComplianceCitation,
  prepareComplianceAudit,
  recordComplianceCheckpoint,
  recordComplianceRule,
  resolveComplianceCitation,
} from '../lib/compliance-monitor.ts';
import { prepareDispatch, prepareReview } from '../lib/dispatch.ts';
import { agentReview } from '../lib/participation.ts';
import { planWork } from '../lib/planning.ts';
import { lookupProjectMemory, registerProjectMemory } from '../lib/project-memory.ts';
import { createRunFile } from '../lib/store.ts';
import type { BatchEvent, BriefInput, WorkerInput, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun, nextActions } from '../lib/workflow.ts';

const workflowCli = fileURLToPath(new URL('../scripts/workflow.ts', import.meta.url));

function monitoredBrief(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    run_id: 'cm-run-1',
    objective: 'Build local storage adapter following all settled owner decisions.',
    domain: 'software-engineering',
    evidence_kind: 'simulation',
    lead_context: 'lead',
    acceptance: ['Storage uses SQLite and matches docs/api.md.'],
    constraints: ['No external network.'],
    limits: { max_attempts: 2, max_dispatches: 8 },
    compliance_monitor: {
      enabled: true,
      monitor_context: 'compliance-monitor',
      watched_contexts: ['ctx-alpha'],
      decisions: [
        {
          id: 'dec-storage-sqlite',
          summary: 'Persist all sessions in local SQLite; do not use Redis or in-memory maps.',
          source: 'docs/DECISIONS.md#D-01',
          must_not_reask: true,
        },
      ],
      documents: [
        {
          id: 'doc-api-contract',
          reference: 'docs/api.md',
          requirement:
            'All write endpoints return deterministic JSON envelopes with revision numbers.',
        },
      ],
    },
    work_items: [
      {
        id: 'storage',
        objective: 'Implement SQLite storage backend.',
        task_type: 'implementation',
        difficulty: 'routine',
        skills: ['implementation'],
        depends_on: [],
        writes: ['src/storage.ts'],
        outputs: ['storage_code'],
        acceptance: ['SQLite adapter passes unit checks.'],
      },
      {
        id: 'api',
        objective: 'Implement HTTP write endpoints.',
        task_type: 'implementation',
        difficulty: 'routine',
        skills: ['implementation'],
        depends_on: [],
        writes: ['src/api.ts'],
        outputs: ['api_code'],
        acceptance: ['Write endpoints follow docs/api.md.'],
      },
      {
        id: 'integrate',
        objective: 'Integrate storage and API for handover.',
        task_type: 'implementation',
        difficulty: 'routine',
        skills: ['implementation'],
        depends_on: ['storage', 'api'],
        inputs: ['storage_code', 'api_code'],
        writes: ['src/index.ts'],
        outputs: ['integrated_app'],
        acceptance: ['End-to-end checks pass.'],
      },
    ],
    ...overrides,
  };
}

function stepEvent(run: ReturnType<typeof createRun>, ev: BatchEvent) {
  return applyEvent(run, { ...ev, expected_revision: run.revision } as WorkflowEvent);
}

test('compliance monitor enforces strict zero-production isolation in briefs, planning and runtime assignments', () => {
  // Lead cannot monitor itself.
  assert.throws(
    () =>
      createRun(
        null,
        monitoredBrief({
          compliance_monitor: { enabled: true, monitor_context: 'lead' },
        }),
      ),
    /separate from lead_context/,
  );

  // Monitor cannot sit in reporting_lines, packet supervisors, or warm_context_keys.
  assert.throws(
    () =>
      createRun(
        null,
        monitoredBrief({
          reporting_lines: [
            { supervisor_context: 'lead', subordinate_context: 'compliance-monitor' },
          ],
        }),
      ),
    /outside reporting_lines/,
  );
  assert.throws(
    () =>
      createRun(
        null,
        monitoredBrief({
          planning_limits: { warm_context_keys: ['compliance-monitor'] },
        }),
      ),
    /warm_context_keys/,
  );

  // Monitor cannot appear as a production worker context during planning.
  const monitorWorker: WorkerInput = {
    id: 'w-mon',
    model_id: 'alpha',
    route: 'native',
    effort: 'high',
    context_id: 'compliance-monitor',
    available: true,
    tools_verified: true,
    tools: [],
  };
  assert.throws(() => planWork(monitoredBrief(), [monitorWorker]), /production worker context/);

  // Monitor cannot be assigned as owner, reviewer, or contributor on any work packet.
  const run = createRun(null, monitoredBrief());
  assert.throws(
    () =>
      stepEvent(run, {
        id: 'assign-mon-owner',
        packet_id: 'work_storage',
        attempt: 1,
        type: 'assign',
        actor_context: 'lead',
        assignment: {
          owner_context: 'compliance-monitor',
          reviewer_context: 'lead',
          contributor_contexts: [],
          writes: ['src/storage.ts'],
        },
      }),
    /strictly isolated/,
  );

  // Direct applyEvent rejects compliance event types; must go through dedicated commands.
  assert.throws(
    () =>
      applyEvent(run, {
        id: 'direct-cite',
        expected_revision: run.revision,
        packet_id: 'handover',
        attempt: 1,
        actor_context: 'compliance-monitor',
        type: 'compliance_cite',
        citation_id: 'c1',
        target_context: 'lead',
        violation_kind: 'forgotten-decision',
        severity: 'blocking',
        decision_ids: ['dec-storage-sqlite'],
        document_ids: [],
        reopened_packet: false,
      }),
    /Unknown workflow event|dedicated compliance monitor command/,
  );
});

test('compliance monitor catches lead forgetting a settled decision or re-asking the owner, blocks dispatch, and forbids lead self-clearing or unilateral rule deletion', () => {
  let run = createRun(null, monitoredBrief());

  // Lead may record a new owner decision, but CANNOT unilaterally supersede an existing settled decision.
  const added = recordComplianceRule(run, {
    expected_revision: run.revision,
    actor_context: 'lead',
    decision: {
      id: 'dec-english-artifacts',
      summary: 'Keep code and docs in English.',
      source: 'owner-2026-11-24',
    },
  });
  run = added.run;
  assert.throws(
    () =>
      recordComplianceRule(run, {
        expected_revision: run.revision,
        actor_context: 'lead',
        supersedes_id: 'dec-storage-sqlite',
        owner_change_reference: 'claim-by-lead',
        decision: {
          id: 'dec-storage-redis',
          summary: 'Switch to Redis.',
          source: 'lead-guess',
        },
      }),
    /Only the compliance monitor may supersede/,
  );

  // Assign work_storage so a packet is otherwise ready to start.
  run = stepEvent(run, {
    id: 'assign-storage',
    packet_id: 'work_storage',
    attempt: 1,
    type: 'assign',
    actor_context: 'lead',
    assignment: {
      owner_context: 'ctx-alpha',
      reviewer_context: 'lead',
      contributor_contexts: [],
      writes: ['src/storage.ts'],
      model_id: 'alpha',
      route: 'native',
    },
  });

  // Monitor inspects clean isolated audit packet (read-only, no production writes).
  const audit = prepareComplianceAudit(run);
  assert.equal(audit.role, 'compliance_monitor');
  assert.equal(audit.actor_context, 'compliance-monitor');
  assert.deepEqual(audit.writes, []);
  assert.ok(audit.watched_targets.includes('lead'));
  assert.ok(audit.watched_targets.includes('ctx-alpha'));
  assert.ok(audit.must_not_reask_decision_ids.includes('dec-storage-sqlite'));

  // Lead forgets dec-storage-sqlite after compaction and re-asks the owner!
  // Monitor issues an immediate blocking citation against lead.
  const cited = issueComplianceCitation(run, {
    expected_revision: run.revision,
    actor_context: 'compliance-monitor',
    citation_id: 'cite-lead-reask-1',
    target_context: 'lead',
    violation_kind: 'reasked-settled-decision',
    decision_ids: ['dec-storage-sqlite'],
    observed_deviation:
      'Lead asked the owner whether to use Redis or SQLite after context compaction, forgetting D-01.',
    evidence_reference: 'logs/lead-turn-14.txt',
    required_correction:
      'Withdraw the question to the owner and follow dec-storage-sqlite (local SQLite) immediately.',
  });
  run = cited.run;
  assert.equal(cited.correction_notice.addressed_to, 'lead');
  assert.equal(cited.correction_notice.do_not_reask_owner, true);
  assert.match(cited.correction_notice.message, /Do NOT re-ask the owner/);
  assert.equal(cited.correction_notice.violated_decisions[0].source, 'docs/DECISIONS.md#D-01');

  // While lead has an open blocking citation, NO worker packet can start!
  assert.equal(nextActions(run).dispatchable.length, 0);
  assert.throws(
    () => prepareDispatch(run, 'work_storage'),
    /Lead context has an open blocking compliance citation/,
  );

  // Lead CANNOT self-clear its own citation!
  assert.throws(
    () =>
      resolveComplianceCitation(run, {
        expected_revision: run.revision,
        actor_context: 'lead',
        citation_id: 'cite-lead-reask-1',
        resolution_evidence: 'logs/lead-sorry.txt',
        resolution_note: 'I promise I remember now.',
      }),
    /cannot self-clear/,
  );

  // Monitor verifies correction and resolves citation -> dispatch unblocks!
  run = resolveComplianceCitation(run, {
    expected_revision: run.revision,
    actor_context: 'compliance-monitor',
    citation_id: 'cite-lead-reask-1',
    resolution_evidence: 'logs/lead-turn-15-corrected.txt',
    resolution_note: 'Lead retracted owner question and aligned plan with SQLite decision.',
  }).run;
  assert.deepEqual(
    nextActions(run).dispatchable.map((item) => item.id),
    ['work_storage'],
  );
  const review = agentReview(run);
  assert.equal(review.compliance.reask_violations, 1);
  assert.equal(review.compliance.lead_citations, 1);
  assert.ok(review.compliance.tags.includes('reasked-settled-decision'));
  assert.ok((review.compliance.score ?? 10) < 10);
});

test('executor doc-drift citation reopens tainted packet, blocks unrelated packets while allowing corrective rework, blocks acceptance until resolved, and gates handover on fresh clear checkpoint', () => {
  let run = createRun(null, monitoredBrief());
  const assign = (packetId: string, writes: string[], fitReason?: string) => {
    run = stepEvent(run, {
      id: `assign-${packetId}-${run.packets[packetId].attempt}`,
      packet_id: packetId,
      attempt: run.packets[packetId].attempt,
      type: 'assign',
      actor_context: 'lead',
      assignment: {
        owner_context: 'ctx-alpha',
        reviewer_context: 'lead',
        contributor_contexts: [],
        writes,
        model_id: 'alpha',
        route: 'native',
        ...(fitReason ? { fit_reason: fitReason } : {}),
      },
    });
  };

  assign('work_storage', ['src/storage.ts']);
  assign('work_api', ['src/api.ts']);

  const firstDispatch = prepareDispatch(run, 'work_storage');
  const firstPrefixHash = firstDispatch.prefix_cache_contract.frozen_prefix_sha256;
  assert.equal(firstDispatch.compliance_monitor?.applicable_decisions.length, 1);

  // Start and submit work_storage attempt 1, then monitor catches doc-drift + wrong DB choice and reopens!
  run = stepEvent(run, {
    id: 'start-storage-1',
    packet_id: 'work_storage',
    attempt: 1,
    type: 'start',
    actor_context: 'ctx-alpha',
  });
  run = stepEvent(run, {
    id: 'submit-storage-1',
    packet_id: 'work_storage',
    attempt: 1,
    type: 'submit',
    actor_context: 'ctx-alpha',
    outputs: [{ id: 'storage_code', reference: 'src/storage.ts', summary: 'In-memory map store.' }],
    evidence: [{ reference: 'logs/storage-1.txt', summary: 'Tests pass on map.' }],
  });

  const drift = issueComplianceCitation(run, {
    expected_revision: run.revision,
    actor_context: 'compliance-monitor',
    citation_id: 'cite-storage-drift',
    target_context: 'ctx-alpha',
    packet_id: 'work_storage',
    reopen_packet: true,
    violation_kind: 'violated-decision',
    decision_ids: ['dec-storage-sqlite'],
    document_ids: ['doc-api-contract'],
    observed_deviation: 'ctx-alpha implemented an in-memory map instead of SQLite.',
    evidence_reference: 'src/storage.ts:1-40',
    required_correction: 'Replace in-memory map with local SQLite per dec-storage-sqlite.',
  });
  run = drift.run;
  assert.deepEqual(drift.reopened_packets, ['work_storage', 'handover']);
  assert.equal(run.packets.work_storage.attempt, 2);
  assert.equal(run.packets.work_storage.status, 'pending');

  // ctx-alpha CANNOT start unrelated work_api while citation is open!
  assert.throws(() => prepareDispatch(run, 'work_api'), /open blocking compliance citation/);

  // ctx-alpha CAN receive corrective rework dispatch for work_storage attempt 2 with unchanged frozen L0+L1 prefix!
  assign('work_storage', ['src/storage.ts'], 'Correct SQLite compliance violation.');
  const reworkDispatch = prepareDispatch(run, 'work_storage');
  assert.equal(reworkDispatch.prefix_cache_contract.mode, 'append-turn-delta-only');
  assert.equal(reworkDispatch.prefix_cache_contract.frozen_prefix_sha256, firstPrefixHash);
  assert.equal(reworkDispatch.compliance_monitor?.open_correction_directives.length, 1);

  run = stepEvent(run, {
    id: 'start-storage-2',
    packet_id: 'work_storage',
    attempt: 2,
    type: 'start',
    actor_context: 'ctx-alpha',
  });
  run = stepEvent(run, {
    id: 'submit-storage-2',
    packet_id: 'work_storage',
    attempt: 2,
    type: 'submit',
    actor_context: 'ctx-alpha',
    outputs: [{ id: 'storage_code', reference: 'src/storage.ts', summary: 'SQLite adapter.' }],
    evidence: [{ reference: 'logs/storage-2.txt', summary: 'SQLite checks pass.' }],
  });

  // Lead CANNOT accept work_storage while cite-storage-drift is still open!
  assert.throws(
    () =>
      stepEvent(run, {
        id: 'rev-storage-premature',
        packet_id: 'work_storage',
        attempt: 2,
        type: 'review',
        actor_context: 'lead',
        decision: 'accepted',
        checks: [
          { index: 0, result: 'pass', evidence_reference: 'logs/storage-2.txt', note: 'OK' },
        ],
      }),
    /must be resolved by the compliance monitor before acceptance/,
  );

  // Monitor verifies fix and resolves citation -> lead can now accept work_storage and finish work_api + handover.
  run = resolveComplianceCitation(run, {
    expected_revision: run.revision,
    actor_context: 'compliance-monitor',
    citation_id: 'cite-storage-drift',
    resolution_evidence: 'src/storage.ts:1-60',
    resolution_note: 'Verified SQLite implementation matches dec-storage-sqlite.',
  }).run;

  run = stepEvent(run, {
    id: 'rev-storage-2',
    packet_id: 'work_storage',
    attempt: 2,
    type: 'review',
    actor_context: 'lead',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/storage-2.txt', note: 'OK' }],
  });

  // Complete work_api and submit handover.
  run = stepEvent(run, {
    id: 'start-api-1',
    packet_id: 'work_api',
    attempt: 1,
    type: 'start',
    actor_context: 'ctx-alpha',
  });
  run = stepEvent(run, {
    id: 'submit-api-1',
    packet_id: 'work_api',
    attempt: 1,
    type: 'submit',
    actor_context: 'ctx-alpha',
    outputs: [
      { id: 'api_code', reference: 'src/api.ts', summary: 'Deterministic JSON endpoints.' },
    ],
    evidence: [{ reference: 'logs/api-1.txt', summary: 'API tests pass.' }],
  });
  run = stepEvent(run, {
    id: 'rev-api-1',
    packet_id: 'work_api',
    attempt: 1,
    type: 'review',
    actor_context: 'lead',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/api-1.txt', note: 'OK' }],
  });

  assign('handover', ['src/index.ts'], 'Integrate accepted storage and API.');
  run = stepEvent(run, {
    id: 'start-handover',
    packet_id: 'handover',
    attempt: 1,
    type: 'start',
    actor_context: 'ctx-alpha',
  });
  run = stepEvent(run, {
    id: 'submit-handover',
    packet_id: 'handover',
    attempt: 1,
    type: 'submit',
    actor_context: 'ctx-alpha',
    outputs: [{ id: 'integrated_app', reference: 'src/index.ts', summary: 'Integrated app.' }],
    evidence: [{ reference: 'logs/e2e.txt', summary: 'E2E tests pass.' }],
  });

  // Review preview warns that handover compliance clearance is not yet ready!
  const preview = prepareReview(run, 'handover');
  assert.equal(preview.compliance_preview?.handover_clearance.ready, false);

  // Lead CANNOT accept handover before monitor records a clear checkpoint covering ALL active rules!
  assert.throws(
    () =>
      stepEvent(run, {
        id: 'rev-handover-no-cp',
        packet_id: 'handover',
        attempt: 1,
        type: 'review',
        actor_context: 'lead',
        decision: 'accepted',
        checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/e2e.txt', note: 'OK' }],
        task_checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/e2e.txt', note: 'OK' }],
      }),
    /current clear compliance monitor checkpoint/,
  );

  // Partial checkpoint (missing doc-api-contract) still does NOT unlock handover!
  run = recordComplianceCheckpoint(run, {
    expected_revision: run.revision,
    actor_context: 'compliance-monitor',
    checkpoint_id: 'cp-partial',
    status: 'clear',
    checked_decision_ids: ['dec-storage-sqlite'],
    checked_document_ids: [],
    evidence_reference: 'logs/audit-partial.txt',
    note: 'Checked storage decision only.',
  }).run;
  assert.throws(
    () =>
      stepEvent(run, {
        id: 'rev-handover-partial-cp',
        packet_id: 'handover',
        attempt: 1,
        type: 'review',
        actor_context: 'lead',
        decision: 'accepted',
        checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/e2e.txt', note: 'OK' }],
        task_checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/e2e.txt', note: 'OK' }],
      }),
    /current clear compliance monitor checkpoint/,
  );

  // Full clear checkpoint covering ALL active decisions and documents unlocks handover!
  const cpFull = recordComplianceCheckpoint(run, {
    expected_revision: run.revision,
    actor_context: 'compliance-monitor',
    checkpoint_id: 'cp-final',
    status: 'clear',
    checked_decision_ids: ['dec-storage-sqlite'],
    checked_document_ids: ['doc-api-contract'],
    evidence_reference: 'logs/audit-final.txt',
    note: 'Verified SQLite storage and deterministic API envelopes against all active rules.',
  });
  run = cpFull.run;
  assert.equal(cpFull.handover_clearance.ready, true);

  run = stepEvent(run, {
    id: 'rev-handover-ok',
    packet_id: 'handover',
    attempt: 1,
    type: 'review',
    actor_context: 'lead',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/e2e.txt', note: 'OK' }],
    task_checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/e2e.txt', note: 'OK' }],
  });
  assert.equal(nextActions(run).complete, true);
  assert.equal(agentReview(run).compliance.status, 'compliant-with-citations');
});

test('compliance CLI/MCP commands persist rule updates, citations, checkpoints and allow monitor to persist decisions into project memory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hk-cm-ws-'));
  const stateDir = await mkdtemp(path.join(tmpdir(), 'hk-cm-state-'));
  const runFile = path.join(workspace, 'run.json');
  const run = createRun(null, monitoredBrief());
  await createRunFile(runFile, run);

  // CLI compliance-inspect returns the isolated monitor brief.
  const cliInspect = JSON.parse(
    execFileSync(process.execPath, [workflowCli, 'compliance-inspect', runFile], {
      cwd: workspace,
      encoding: 'utf8',
    }),
  ) as { role: string; actor_context: string; writes: string[] };
  assert.equal(cliInspect.role, 'compliance_monitor');
  assert.equal(cliInspect.actor_context, 'compliance-monitor');
  assert.deepEqual(cliInspect.writes, []);

  // CLI compliance-record-rule supersedes dec-storage-sqlite ONLY when monitor supplies owner_change_reference.
  const ruleReq = path.join(workspace, 'rule.json');
  await writeFile(
    ruleReq,
    JSON.stringify({
      expected_revision: 0,
      actor_context: 'compliance-monitor',
      supersedes_id: 'dec-storage-sqlite',
      owner_change_reference: 'owner-2026-11-24-postgres-switch',
      decision: {
        id: 'dec-storage-postgres',
        summary: 'Owner updated storage decision to PostgreSQL.',
        source: 'docs/DECISIONS.md#D-02',
      },
    }),
  );
  const cliRule = JSON.parse(
    execFileSync(process.execPath, [workflowCli, 'compliance-record-rule', runFile, ruleReq], {
      cwd: workspace,
      encoding: 'utf8',
    }),
  ) as { revision: number; recorded: { rule: { id: string } } };
  assert.equal(cliRule.revision, 1);
  assert.equal(cliRule.recorded.rule.id, 'dec-storage-postgres');

  // Shared command table: cite -> resolve -> checkpoint.
  const cited = (await commands.compliance_cite.run(
    {
      run_file: runFile,
      request: {
        expected_revision: 1,
        actor_context: 'compliance-monitor',
        citation_id: 'cite-cli-1',
        target_context: 'lead',
        violation_kind: 'doc-drift',
        document_ids: ['doc-api-contract'],
        observed_deviation: 'Lead omitted revision field from planned response envelope.',
        evidence_reference: 'logs/plan-draft.txt',
        required_correction: 'Restore revision field per docs/api.md.',
      },
    },
    { base: workspace },
  )) as { revision: number; correction_notice: { addressed_to: string } };
  assert.equal(cited.revision, 2);
  assert.equal(cited.correction_notice.addressed_to, 'lead');

  const resolved = (await commands.compliance_resolve.run(
    {
      run_file: runFile,
      request: {
        expected_revision: 2,
        actor_context: 'compliance-monitor',
        citation_id: 'cite-cli-1',
        resolution_evidence: 'logs/plan-v2.txt',
        resolution_note: 'Revision field restored.',
      },
    },
    { base: workspace },
  )) as { revision: number };
  assert.equal(resolved.revision, 3);

  const cp = (await commands.compliance_checkpoint.run(
    {
      run_file: runFile,
      request: {
        expected_revision: 3,
        actor_context: 'compliance-monitor',
        checkpoint_id: 'cp-cli-1',
        status: 'clear',
        checked_decision_ids: ['dec-storage-postgres'],
        checked_document_ids: ['doc-api-contract'],
        evidence_reference: 'logs/cp-1.txt',
        note: 'All active rules verified.',
      },
    },
    { base: workspace },
  )) as { revision: number; handover_clearance: { ready: boolean } };
  assert.equal(cp.revision, 4);
  assert.equal(cp.handover_clearance.ready, true);

  // Project memory bridge: compliance monitor can persist settled owner decisions directly (ranked first above architecture),
  // but CANNOT register non-decision categories without being an accepted packet's direct supervisor.
  await registerProjectMemory(run, {
    packet_id: 'compliance_monitor',
    attempt: 0,
    scope: 'demo-repo',
    state_dir: stateDir,
    actor_context: 'compliance-monitor',
    evidence_reference: 'docs/DECISIONS.md#D-01',
    entry: {
      entry_id: 'owner-sqlite-rule',
      category: 'decisions',
      title: 'Settled storage engine',
      content: 'Use local SQLite; do not re-ask the owner.',
    },
  });
  await assert.rejects(
    () =>
      registerProjectMemory(run, {
        packet_id: 'work_storage',
        attempt: 1,
        scope: 'demo-repo',
        state_dir: stateDir,
        actor_context: 'compliance-monitor',
        evidence_reference: 'src/storage.ts',
        entry: {
          entry_id: 'not-allowed-arch',
          category: 'architecture',
          title: 'Unauthorized arch entry',
          content: 'Monitor cannot write architecture entries.',
        },
      }),
    /must be accepted/,
  );
  const snapshot = await lookupProjectMemory(run, 'demo-repo', stateDir);
  assert.deepEqual(snapshot.entry_ids, ['owner-sqlite-rule']);
  assert.match(snapshot.rendered_prefix, /## \[decisions\] Settled storage engine/);
});
