import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordComplianceCheckpoint, recordComplianceRule } from '../lib/compliance-monitor.ts';
import { pollComplianceWatchdogOnce, runComplianceWatchdog } from '../lib/compliance-watchdog.ts';
import { createRunFile } from '../lib/store.ts';
import type { BatchEvent, BriefInput, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';

const watchdogCli = fileURLToPath(new URL('../scripts/compliance-watchdog.ts', import.meta.url));

function watchdogBrief(): BriefInput {
  return {
    run_id: 'wd-run-1',
    objective: 'Build module with automatic compliance watchdog.',
    domain: 'software-engineering',
    evidence_kind: 'simulation',
    lead_context: 'lead',
    acceptance: ['All checks pass.'],
    constraints: ['No external network.'],
    limits: { max_attempts: 2, max_dispatches: 8 },
    compliance_monitor: {
      enabled: true,
      monitor_context: 'compliance-monitor',
      audit_every_n_submissions: 1,
      decisions: [
        {
          id: 'dec-sqlite',
          summary: 'Use SQLite only.',
          source: 'docs/DECISIONS.md#D-01',
          must_not_reask: true,
        },
      ],
      documents: [
        {
          id: 'doc-spec',
          reference: 'docs/spec.md',
          requirement: 'Follow spec strictly.',
        },
      ],
    },
    work_items: [
      {
        id: 'step_one',
        objective: 'Build step one.',
        task_type: 'implementation',
        difficulty: 'routine',
        skills: ['implementation'],
        depends_on: [],
        writes: ['src/one.ts'],
        outputs: ['out_one'],
        acceptance: ['Step one passes.'],
      },
    ],
  };
}

function step(
  run: ReturnType<typeof createRun>,
  ev: BatchEvent,
  recordedAt = '2026-11-24T00:00:00.000Z',
) {
  return applyEvent(run, { ...ev, expected_revision: run.revision } as WorkflowEvent, recordedAt);
}

function submittedRun() {
  let run = createRun(null, watchdogBrief());
  run = step(
    run,
    {
      id: 'a1',
      packet_id: 'handover',
      attempt: 1,
      type: 'assign',
      actor_context: 'lead',
      assignment: {
        owner_context: 'ctx-worker',
        reviewer_context: 'lead',
        contributor_contexts: [],
        writes: ['src/one.ts'],
      },
    },
    '2026-11-24T00:00:00.000Z',
  );
  run = step(
    run,
    { id: 's1', packet_id: 'handover', attempt: 1, type: 'start', actor_context: 'ctx-worker' },
    '2026-11-24T00:01:00.000Z',
  );
  run = step(
    run,
    {
      id: 'sub1',
      packet_id: 'handover',
      attempt: 1,
      type: 'submit',
      actor_context: 'ctx-worker',
      outputs: [{ id: 'out_one', reference: 'src/one.ts', summary: 'Done.' }],
      evidence: [{ reference: 'logs/one.txt', summary: 'Passed.' }],
    },
    '2026-11-24T00:02:00.000Z',
  );
  return run;
}

test('compliance watchdog enforces fingerprint dedup, cooldown, 3-file retention, max_wakes cap, lock isolation and clean completion exit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hk-wd-'));
  const stateDir = path.join(dir, 'wd-state');
  const runFile = path.join(dir, 'run.json');

  // Fresh untouched run -> idle.
  let run = createRun(null, watchdogBrief());
  await createRunFile(runFile, run);
  let clockMs = Date.parse('2026-11-24T00:05:00.000Z');
  const now = () => new Date(clockMs);

  const idle = await pollComplianceWatchdogOnce({
    run_file: runFile,
    state_dir: stateDir,
    cooldown_seconds: 30,
    max_wakes: 4,
    retain_wake_files: 3,
    now,
  });
  assert.equal(idle.action, 'idle');

  // After submission -> wakes once in emit-only mode.
  run = submittedRun();
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);
  const wake1 = await pollComplianceWatchdogOnce({
    run_file: runFile,
    state_dir: stateDir,
    cooldown_seconds: 30,
    max_wakes: 4,
    retain_wake_files: 3,
    now,
  });
  assert.equal(wake1.action, 'woken');
  if (wake1.action === 'woken') {
    assert.equal(wake1.mode, 'emit-only');
    assert.equal(wake1.wake_number, 1);
    assert.ok(wake1.reasons.includes('submission-threshold'));
    assert.ok(wake1.reasons.includes('handover-pending'));
    const written = JSON.parse(await readFile(wake1.audit_file, 'utf8')) as {
      monitor_context: string;
      audit_packet: { role: string };
    };
    assert.equal(written.monitor_context, 'compliance-monitor');
    assert.equal(written.audit_packet.role, 'compliance_monitor');
  }

  // Polling again at the same revision skips duplicate!
  const dup = await pollComplianceWatchdogOnce({
    run_file: runFile,
    state_dir: stateDir,
    cooldown_seconds: 30,
    max_wakes: 4,
    retain_wake_files: 3,
    now,
  });
  assert.equal(dup.action, 'skipped-duplicate');

  // Advance revision with a new rule, but stay within cooldown (only +10s) -> skipped-cooldown!
  run = recordComplianceRule(
    run,
    {
      expected_revision: run.revision,
      actor_context: 'lead',
      decision: { id: 'dec-2', summary: 'Keep English docs.', source: 'owner-2026-11-24' },
    },
    '2026-11-24T00:05:10.000Z',
  ).run;
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);
  clockMs += 10_000;
  const cooled = await pollComplianceWatchdogOnce({
    run_file: runFile,
    state_dir: stateDir,
    cooldown_seconds: 30,
    max_wakes: 4,
    retain_wake_files: 3,
    now,
  });
  assert.equal(cooled.action, 'skipped-cooldown');

  // Trigger 3 more distinct wakes past cooldown -> verify retain_wake_files=3 prunes oldest wake file!
  for (let i = 2; i <= 4; i += 1) {
    clockMs += 40_000;
    if (i > 2) {
      run = recordComplianceRule(
        run,
        {
          expected_revision: run.revision,
          actor_context: 'lead',
          decision: {
            id: `dec-${i + 1}`,
            summary: `Owner rule ${i + 1}.`,
            source: 'owner-2026-11-24',
          },
        },
        new Date(clockMs).toISOString(),
      ).run;
      await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);
    }
    const w = await pollComplianceWatchdogOnce({
      run_file: runFile,
      state_dir: stateDir,
      cooldown_seconds: 30,
      max_wakes: 4,
      retain_wake_files: 3,
      now,
    });
    assert.equal(w.action, 'woken');
  }
  const wakeFiles = (await readdir(stateDir)).filter((name) => name.startsWith('wake-')).sort();
  assert.equal(wakeFiles.length, 3);
  assert.ok(!wakeFiles.some((name) => name.startsWith('wake-0001-')));
  assert.ok(wakeFiles.some((name) => name.startsWith('wake-0004-')));

  // One more new revision hits max_wakes=4 ceiling -> cap-reached stops continuous loop!
  clockMs += 40_000;
  run = recordComplianceRule(
    run,
    {
      expected_revision: run.revision,
      actor_context: 'lead',
      decision: { id: 'dec-cap', summary: 'Rule after cap.', source: 'owner-2026-11-24' },
    },
    new Date(clockMs).toISOString(),
  ).run;
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);
  const capped = await runComplianceWatchdog({
    run_file: runFile,
    state_dir: stateDir,
    cooldown_seconds: 30,
    max_wakes: 4,
    retain_wake_files: 3,
    poll_interval_ms: 100,
    now,
  });
  assert.equal(capped.action, 'cap-reached');

  // Lock protection: a live lock file prevents duplicate concurrent watchdog instances.
  await writeFile(path.join(stateDir, 'watchdog.lock'), '{"pid":99999}\n');
  await assert.rejects(
    () =>
      pollComplianceWatchdogOnce({
        run_file: runFile,
        state_dir: stateDir,
        now,
      }),
    /Another compliance watchdog or stale lock exists/,
  );

  // Clean run completion causes watchdog to return complete and exit cleanly.
  const stateDir2 = path.join(dir, 'wd-state-2');
  const activeDecisions =
    run.compliance_monitor?.decisions.filter((d) => d.status === 'active').map((d) => d.id) ?? [];
  run = recordComplianceCheckpoint(
    run,
    {
      expected_revision: run.revision,
      actor_context: 'compliance-monitor',
      checkpoint_id: 'cp-done',
      status: 'clear',
      checked_decision_ids: activeDecisions,
      checked_document_ids: ['doc-spec'],
      evidence_reference: 'logs/cp.txt',
      note: 'All clear.',
    },
    new Date(clockMs + 1000).toISOString(),
  ).run;
  run = step(
    run,
    {
      id: 'rev-final',
      packet_id: 'handover',
      attempt: 1,
      type: 'review',
      actor_context: 'lead',
      decision: 'accepted',
      checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/one.txt', note: 'OK' }],
      task_checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/one.txt', note: 'OK' }],
    },
    new Date(clockMs + 2000).toISOString(),
  );
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);
  const done = await runComplianceWatchdog({
    run_file: runFile,
    state_dir: stateDir2,
    poll_interval_ms: 100,
  });
  assert.equal(done.action, 'complete');
});

test('compliance-watchdog CLI invokes configured local wake command safely with expanded placeholders and env vars', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hk-wd-cli-'));
  const stateDir = path.join(dir, 'state');
  const runFile = path.join(dir, 'run.json');
  const capturedFile = path.join(dir, 'captured.json');
  const probeScript = path.join(dir, 'probe-wake.mjs');

  await createRunFile(runFile, submittedRun());
  await writeFile(
    probeScript,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const [auditFile, monitorCtx] = process.argv.slice(2);',
      'const payload = JSON.parse(readFileSync(auditFile, "utf8"));',
      'writeFileSync(',
      `  ${JSON.stringify(capturedFile)},`,
      '  JSON.stringify({',
      '    argv_audit: auditFile,',
      '    argv_monitor: monitorCtx,',
      '    env_run: process.env.HAKENGAISYA_RUN_FILE,',
      '    env_audit: process.env.HAKENGAISYA_AUDIT_FILE,',
      '    env_monitor: process.env.HAKENGAISYA_MONITOR_CONTEXT,',
      '    env_reasons: process.env.HAKENGAISYA_WAKE_REASONS,',
      '    payload_role: payload.audit_packet?.role,',
      '    decision_ids: payload.audit_packet?.ledger?.active_decisions?.map((d) => d.id),',
      '  }),',
      ');',
      'console.log("monitor-woken-ok");',
    ].join('\n'),
  );

  const proc = spawnSync(
    process.execPath,
    [
      watchdogCli,
      '--run',
      runFile,
      '--state-dir',
      stateDir,
      '--once',
      '--exit-nonzero-on-wake',
      '--wake-cmd',
      process.execPath,
      '--wake-arg',
      probeScript,
      '--wake-arg',
      '{audit_file}',
      '--wake-arg',
      '{monitor_context}',
    ],
    { encoding: 'utf8', cwd: dir },
  );
  assert.equal(proc.status, 2, `Expected exit code 2, got ${proc.status}: ${proc.stderr}`);
  const outcome = JSON.parse(proc.stdout) as {
    action: string;
    mode: string;
    audit_file: string;
    invocation: { exit_code: number; stdout_excerpt: string };
  };
  assert.equal(outcome.action, 'woken');
  assert.equal(outcome.mode, 'command');
  assert.equal(outcome.invocation.exit_code, 0);
  assert.equal(outcome.invocation.stdout_excerpt, 'monitor-woken-ok');

  const captured = JSON.parse(await readFile(capturedFile, 'utf8')) as {
    argv_audit: string;
    argv_monitor: string;
    env_run: string;
    env_audit: string;
    env_monitor: string;
    env_reasons: string;
    payload_role: string;
    decision_ids: string[];
  };
  assert.equal(captured.argv_audit, outcome.audit_file);
  assert.equal(captured.argv_monitor, 'compliance-monitor');
  assert.equal(captured.env_run, path.resolve(runFile));
  assert.equal(captured.env_audit, outcome.audit_file);
  assert.equal(captured.env_monitor, 'compliance-monitor');
  assert.match(captured.env_reasons, /submission-threshold/);
  assert.equal(captured.payload_role, 'compliance_monitor');
  assert.deepEqual(captured.decision_ids, ['dec-sqlite']);
});
