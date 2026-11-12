import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commands } from '../lib/commands.ts';
import type { ExternalEvidence, HostInventory } from '../lib/evaluator-bridge.ts';
import {
  lookupProjectMemory,
  projectMemoryId,
  registerProjectMemory,
} from '../lib/project-memory.ts';
import { createRunFile } from '../lib/store.ts';
import type { BatchEvent, BriefInput, WorkflowEvent } from '../lib/types.ts';
import { applyEvent, createRun } from '../lib/workflow.ts';

function sampleBrief(evidenceKind: 'simulation' | 'local_work' = 'simulation'): BriefInput {
  return {
    run_id: `pm-run-${evidenceKind}`,
    objective: 'Build and verify module with stable prefix cache.',
    domain: 'software-engineering',
    evidence_kind: evidenceKind,
    lead_context: 'lead',
    acceptance: ['All checks pass.'],
    constraints: ['No external network.'],
    work_items: [
      {
        id: 'step_one',
        objective: 'Scope architecture.',
        task_type: 'scoping',
        difficulty: 'routine',
        skills: ['scoping'],
        depends_on: [],
        writes: ['docs/plan'],
        outputs: ['plan_out'],
        acceptance: ['Plan complete.'],
      },
      {
        id: 'step_two',
        objective: 'Implement code.',
        task_type: 'implementation',
        difficulty: 'standard',
        skills: ['implementation'],
        depends_on: ['step_one'],
        inputs: ['plan_out'],
        writes: ['src/app'],
        outputs: ['code_out'],
        acceptance: ['Code passes tests.'],
      },
    ],
  };
}

function acceptFirstPacket(brief: BriefInput) {
  let run = createRun(null, brief);
  const step = (ev: BatchEvent) => {
    run = applyEvent(run, { ...ev, expected_revision: run.revision } as WorkflowEvent);
  };
  step({
    id: 'a1',
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'assign',
    actor_context: 'lead',
    assignment: {
      owner_context: 'worker-1',
      reviewer_context: 'lead',
      contributor_contexts: [],
      writes: ['docs/plan'],
      model_id: 'model-alpha',
      route: 'native',
    },
  });
  step({
    id: 's1',
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'start',
    actor_context: 'worker-1',
  });
  step({
    id: 'sub1',
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'submit',
    actor_context: 'worker-1',
    outputs: [{ id: 'plan_out', reference: 'docs/plan/spec.md', summary: 'Scoped.' }],
    evidence: [{ reference: 'logs/s1.txt', summary: 'Reviewed.' }],
  });
  step({
    id: 'rev1',
    packet_id: 'work_step_one',
    attempt: 1,
    type: 'review',
    actor_context: 'lead',
    decision: 'accepted',
    checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/s1.txt', note: 'Pass.' }],
  });
  return run;
}

test('project memory shares deterministic snapshots across task types while isolating evidence kinds and superseding cleanly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hk-pm-'));
  const simRun = acceptFirstPacket(sampleBrief('simulation'));

  // Producer cannot self-register project memory; only independent direct supervisor can.
  await assert.rejects(
    () =>
      registerProjectMemory(simRun, {
        packet_id: 'work_step_one',
        attempt: 1,
        scope: 'hakengaisya',
        state_dir: dir,
        actor_context: 'worker-1',
        evidence_reference: 'logs/s1.txt',
        entry: {
          entry_id: 'bad-actor',
          category: 'commands',
          title: 'Test command',
          content: 'Run npm test.',
        },
      }),
    /independent direct supervisor/,
  );

  // Register a pitfalls entry first, then an architecture entry -> canonical output still puts architecture first.
  await registerProjectMemory(simRun, {
    packet_id: 'work_step_one',
    attempt: 1,
    scope: 'hakengaisya',
    state_dir: dir,
    actor_context: 'lead',
    evidence_reference: 'logs/s1.txt',
    entry: {
      entry_id: 'win-realpath',
      category: 'pitfalls',
      title: 'Windows 8.3 short paths',
      content: 'Always compare realpath-resolved directories on Windows runners.',
    },
  });
  await registerProjectMemory(simRun, {
    packet_id: 'work_step_one',
    attempt: 1,
    scope: 'hakengaisya',
    state_dir: dir,
    actor_context: 'lead',
    evidence_reference: 'logs/s1.txt',
    entry: {
      entry_id: 'core-layout',
      category: 'architecture',
      title: 'Controller layout',
      content: 'lib/workflow.ts is pure; lib/store.ts owns file locks.',
    },
  });

  // Lookup from a brand-new run with different task_type/difficulty/skills finds both entries in canonical order.
  const otherTaskRun = createRun(null, sampleBrief('simulation'));
  const snapshotA = await lookupProjectMemory(otherTaskRun, 'hakengaisya', dir);
  assert.equal(snapshotA.status, 'available');
  assert.deepEqual(snapshotA.entry_ids, ['core-layout', 'win-realpath']);
  assert.equal(
    snapshotA.memory_id,
    projectMemoryId('hakengaisya', 'simulation', 'software-engineering'),
  );

  // Local_work run never sees simulation project memory.
  const localWorkRun = createRun(null, sampleBrief('local_work'));
  const isolated = await lookupProjectMemory(localWorkRun, 'hakengaisya', dir);
  assert.equal(isolated.status, 'empty');
  assert.deepEqual(isolated.entry_ids, []);

  // Superseding core-layout replaces it in active snapshots without mutating prior files.
  await registerProjectMemory(simRun, {
    packet_id: 'work_step_one',
    attempt: 1,
    scope: 'hakengaisya',
    state_dir: dir,
    actor_context: 'lead',
    evidence_reference: 'logs/s1.txt',
    entry: {
      entry_id: 'core-layout-v2',
      category: 'architecture',
      title: 'Controller and cache layout',
      content: 'lib/workflow.ts, lib/cache-policy.ts and lib/project-memory.ts stay pure/local.',
      supersedes_entry_id: 'core-layout',
    },
  });
  const snapshotB = await lookupProjectMemory(otherTaskRun, 'hakengaisya', dir);
  assert.deepEqual(snapshotB.entry_ids, ['core-layout-v2', 'win-realpath']);
  assert.notEqual(snapshotB.snapshot_sha256, snapshotA.snapshot_sha256);
});

test('integrated_reserve freezes L1 project memory on first context turn and emits append-only delta on continuation even if disk memory updates mid-run', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hk-pm-ws-'));
  const stateDir = await mkdtemp(path.join(tmpdir(), 'hk-pm-state-'));
  const seedRunFile = path.join(workspace, 'seed.json');
  const seedRun = acceptFirstPacket(sampleBrief('simulation'));
  await createRunFile(seedRunFile, seedRun);

  const regResult = (await commands.project_memory_register.run(
    {
      run_file: seedRunFile,
      request: {
        packet_id: 'work_step_one',
        attempt: 1,
        scope: 'repo-main',
        state_dir: stateDir,
        actor_context: 'lead',
        evidence_reference: 'logs/seed.txt',
        entry: {
          entry_id: 'test-cmd',
          category: 'commands',
          title: 'Verification command',
          content: 'Run npm test and npm run typecheck.',
        },
      },
    },
    { base: workspace },
  )) as { status: string };
  assert.equal(regResult.status, 'registered');

  const inventory: HostInventory = {
    complete: true,
    routes: [
      {
        id: 'slot-alpha',
        model_id: 'alpha',
        route: 'native',
        effort: 'high',
        context_id: 'ctx-alpha',
        available: true,
        tools_verified: true,
        tools: [],
      },
    ],
  };
  const mkEv = (
    taskType: string,
    difficulty: 'routine' | 'standard',
    skill: string,
  ): ExternalEvidence => ({
    model_id: 'alpha',
    route: 'native',
    effort: 'high',
    task: {
      domain: 'software-engineering',
      task_type: taskType,
      difficulty,
      skill,
    },
    source: {
      url: 'https://example.com/alpha',
      title: 'Alpha card',
      accessed_at: '2026-10-20T00:00:00Z',
    },
    assessment: {
      kind: 'qualitative',
      trial_fit: 'supports',
      summary: 'Supports engineering tasks.',
    },
    estimates: {
      kind: 'unobserved_estimate',
      cost_usd: 0.01,
      wall_seconds: 20,
      basis: 'Fixture.',
    },
  });

  const activeRunFile = path.join(workspace, 'active.json');
  const created = (await commands.integrated_create.run(
    {
      run_file: activeRunFile,
      request: {
        brief: {
          ...sampleBrief('simulation'),
          cache_policy: { continuity_mode: 'strict-single-model' },
          planning_limits: { unproven_routes: 'sourced-trial', max_trial_assignments: 2 },
        },
        inventory,
        external_evidence: [
          mkEv('scoping', 'routine', 'scoping'),
          mkEv('implementation', 'standard', 'implementation'),
        ],
        public_trials: { enabled: true, max_assignments: 2, require_research_for_all: false },
      },
    },
    { base: workspace },
  )) as { created: boolean; revision: number };
  assert.equal(created.created, true);

  // Reserve packet 1 on ctx-alpha -> initializes frozen L0+L1 prefix.
  const firstReserve = (await commands.integrated_reserve.run(
    {
      run_file: activeRunFile,
      request: {
        packet_id: 'work_step_one',
        expected_revision: 0,
        actor_context: 'lead',
        owner_context: 'ctx-alpha',
        reviewer_context: 'lead',
        contributor_contexts: [],
        project_memory: { state_dir: stateDir, scope: 'repo-main' },
      },
    },
    { base: workspace },
  )) as {
    revision: number;
    launch: {
      project_memory: { status: string; snapshot_sha256: string; deferred_disk_updates: boolean };
      contract: {
        prefix_cache_contract: {
          mode: string;
          prefix_unchanged: boolean;
          frozen_prefix_sha256: string;
          layers: { l1_project_memory: string | null } | null;
        };
      };
    };
  };
  assert.equal(firstReserve.launch.contract.prefix_cache_contract.mode, 'initialize-frozen-prefix');
  assert.equal(firstReserve.launch.contract.prefix_cache_contract.prefix_unchanged, false);
  assert.match(
    firstReserve.launch.contract.prefix_cache_contract.layers?.l1_project_memory ?? '',
    /Run npm test and npm run typecheck/,
  );
  const firstPrefixHash = firstReserve.launch.contract.prefix_cache_contract.frozen_prefix_sha256;

  // Complete packet 1, then register a brand-new memory entry on disk mid-run!
  await commands.event.run(
    {
      run_file: activeRunFile,
      events: [
        {
          id: 'sub-1',
          expected_revision: firstReserve.revision,
          packet_id: 'work_step_one',
          attempt: 1,
          type: 'submit',
          actor_context: 'ctx-alpha',
          outputs: [{ id: 'plan_out', reference: 'docs/plan/s.md', summary: 'Plan.' }],
          evidence: [{ reference: 'logs/1.txt', summary: 'OK.' }],
          usage: { input_tokens: 2000, cached_input_tokens: 200, output_tokens: 150 },
        },
        {
          id: 'rev-1',
          packet_id: 'work_step_one',
          attempt: 1,
          type: 'review',
          actor_context: 'lead',
          decision: 'accepted',
          checks: [{ index: 0, result: 'pass', evidence_reference: 'logs/1.txt', note: 'OK.' }],
        },
      ],
    },
    { base: workspace },
  );
  await commands.project_memory_register.run(
    {
      run_file: activeRunFile,
      request: {
        packet_id: 'work_step_one',
        attempt: 1,
        scope: 'repo-main',
        state_dir: stateDir,
        actor_context: 'lead',
        evidence_reference: 'logs/1.txt',
        entry: {
          entry_id: 'mid-run-fact',
          category: 'conventions',
          title: 'New mid-run note',
          content: 'Deferred until next fresh context so active KV cache stays intact.',
        },
      },
    },
    { base: workspace },
  );

  // Reserve packet 2 (handover) on the SAME ctx-alpha -> keeps frozen prefix hash & emits append-turn-delta-only!
  const nextSnap = (await commands.next.run({ run_file: activeRunFile }, { base: workspace })) as {
    revision: number;
  };
  const secondReserve = (await commands.integrated_reserve.run(
    {
      run_file: activeRunFile,
      request: {
        packet_id: 'handover',
        expected_revision: nextSnap.revision,
        actor_context: 'lead',
        owner_context: 'ctx-alpha',
        reviewer_context: 'lead',
        contributor_contexts: [],
        fit_reason: 'Continue warm single-model context.',
        project_memory: { state_dir: stateDir, scope: 'repo-main' },
      },
    },
    { base: workspace },
  )) as typeof firstReserve;
  assert.equal(secondReserve.launch.project_memory.status, 'frozen-reused');
  assert.equal(secondReserve.launch.project_memory.deferred_disk_updates, true);
  assert.equal(secondReserve.launch.contract.prefix_cache_contract.mode, 'append-turn-delta-only');
  assert.equal(secondReserve.launch.contract.prefix_cache_contract.prefix_unchanged, true);
  assert.equal(secondReserve.launch.contract.prefix_cache_contract.layers, null);
  assert.equal(
    secondReserve.launch.contract.prefix_cache_contract.frozen_prefix_sha256,
    firstPrefixHash,
  );
});
