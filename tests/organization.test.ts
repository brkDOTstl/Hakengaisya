import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  OrganizationCatalog,
  OrganizationProposal,
  ProjectDescription,
  ProjectPhase,
} from '../lib/organization.ts';
import { composeOrganization } from '../lib/organization.ts';

const catalog: OrganizationCatalog = JSON.parse(
  await readFile(new URL('../config/organization-modules.json', import.meta.url), 'utf8'),
);
const game: ProjectDescription & { phases: ProjectPhase[] } = JSON.parse(
  await readFile(new URL('../examples/organizations/indie-game.json', import.meta.url), 'utf8'),
);
const small: ProjectDescription = JSON.parse(
  await readFile(new URL('../examples/organizations/small-software.json', import.meta.url), 'utf8'),
);

test('the indie studio composes seven working core positions with upward acceptance', () => {
  const proposal = composeOrganization(catalog, game);
  assert.equal(proposal.position_count, 7);
  assert.equal(proposal.reporting_lines.length, 6);
  assert.equal(
    proposal.positions.find((role) => role.id === 'gameplay_engineer')?.reports_to,
    'technical_lead',
  );
  assert.equal(
    proposal.positions.find((role) => role.id === 'generalist_artist')?.reports_to,
    'visual_lead',
  );
  assert.equal(
    proposal.acceptance.find((role) => role.position === 'technical_lead')
      ?.own_production_signoff_by,
    'project_lead',
  );
  assert.equal(
    proposal.acceptance.find((role) => role.position === 'qa_release')?.direct_signoff_by,
    'project_lead',
  );
  assert.ok(proposal.positions.every((role) => role.model_id === null && role.deliverables.length));
  assert.equal(proposal.automatic_execution, false);
  assert.equal(proposal.cost_estimate_usd, null);
});

test('phase composition changes active positions without confusing them with actual agent capacity', () => {
  const counts = game.phases.map(
    (phase) => composeOrganization(catalog, game, phase.id).position_count,
  );
  assert.deepEqual(counts, [4, 7, 8, 9, 8]);
  const proposal = composeOrganization(catalog, game, 'stabilization');
  assert.equal(proposal.max_active_agents, 3);
  assert.deepEqual(proposal.reference_months, [9, 10]);
  assert.equal(proposal.kind, 'organization-proposal');
  assert.ok(proposal.exit_criteria.length > 0);
});

test('the same composer gives a small technical tool two positions and no game art departments', () => {
  assert.deepEqual(
    composeOrganization(catalog, small).positions.map((role) => role.id),
    ['project_lead', 'technical_lead'],
  );
  assert.equal(composeOrganization(catalog, small, 'independent-check').position_count, 3);
});

test('explicit responsibility merges produce a five-position studio without self-signoff', () => {
  const profile = {
    ...game,
    max_positions: 5,
    merge_positions: [
      { from: 'gameplay_engineer', into: 'technical_lead' },
      { from: 'generalist_artist', into: 'visual_lead' },
    ],
  };
  const proposal = composeOrganization(catalog, profile);
  assert.equal(proposal.position_count, 5);
  assert.ok(
    proposal.positions
      .find((role) => role.id === 'technical_lead')
      ?.covers.includes('gameplay_engineer'),
  );
  assert.ok(proposal.acceptance.every((role) => role.position !== role.direct_signoff_by));
  assert.equal(game.merge_positions, undefined);
});

test('the composer refuses silent root merges, cross-branch merges and overstaffing', () => {
  assert.throws(
    () =>
      composeOrganization(catalog, {
        ...game,
        merge_positions: [{ from: 'technical_lead', into: 'project_lead' }],
      }),
    /non-root/,
  );
  assert.throws(
    () =>
      composeOrganization(catalog, {
        ...game,
        merge_positions: [{ from: 'generalist_artist', into: 'technical_lead' }],
      }),
    /reporting branches/,
  );
  assert.throws(
    () => composeOrganization(catalog, { ...game, max_positions: 6 }),
    /position ceiling/,
  );
  assert.throws(
    () =>
      composeOrganization(catalog, {
        ...game,
        merge_positions: [{ from: 'qa_release', into: 'technical_lead' }],
      }),
    /Independent checking/,
  );
  const merged = composeOrganization(catalog, {
    ...game,
    merge_positions: [{ from: 'generalist_artist', into: 'visual_lead' }],
  });
  assert.equal(
    merged.positions.find((role) => role.id === 'visual_lead')?.evidence_requirements.length,
    2,
  );
});

test('project role hats customize real work while leaving hierarchy and evidence constraints intact', () => {
  const proposal = composeOrganization(catalog, game);
  assert.equal(proposal.positions[0].title, 'Producer / game direction');
  assert.equal(composeOrganization(catalog, small).positions[1].title, 'Software engineer');
  assert.throws(
    () =>
      composeOrganization(catalog, {
        ...game,
        position_overrides: { gameplay_engineer: { reports_to: 'project_lead' } },
      } as never),
    /authority or evidence/,
  );
});

test('module dependencies and reporting hierarchy must remain complete and acyclic', () => {
  const cyclic = structuredClone(catalog);
  cyclic.modules[0].requires = ['software'];
  assert.throws(() => composeOrganization(cyclic, game), /Cyclic module/);
  const broken = structuredClone(catalog);
  const gameplay = broken.modules.find((module) => module.id === 'gameplay');
  if (gameplay) gameplay.requires = ['core'];
  assert.throws(
    () =>
      composeOrganization(broken, {
        ...small,
        core_modules: ['core', 'gameplay'],
        optional_modules: [],
        phases: [],
        position_overrides: {},
      }),
    /superior is inactive/,
  );
  const loop = structuredClone(catalog);
  const software = loop.modules.find((module) => module.id === 'software');
  if (software) software.positions[0].reports_to = 'gameplay_engineer';
  assert.throws(() => composeOrganization(loop, game), /Cyclic reporting/);
});

test('phase calendars, modules and milestone exit criteria cannot be invented or omitted', () => {
  assert.throws(() => composeOrganization(catalog, game, 'unknown'), /Unknown organization phase/);
  const profile = structuredClone(game);
  profile.phases[0].modules.push('unknown');
  assert.throws(() => composeOrganization(catalog, profile), /unapproved module/);
  profile.phases[0].modules.pop();
  profile.phases[0].months = [1, 13];
  assert.throws(() => composeOrganization(catalog, profile), /calendar/);
  profile.phases[0].months = [1, 2];
  profile.phases[0].exit_criteria = [];
  assert.throws(() => composeOrganization(catalog, profile), /exit criteria/);
});

test('packaged organization composition runs from an unrelated directory', () => {
  const helper = fileURLToPath(
    new URL('../plugins/hakengaisya/runtime/scripts/workflow.ts', import.meta.url),
  );
  const input = fileURLToPath(
    new URL('../examples/organizations/indie-game.json', import.meta.url),
  );
  const proposal: OrganizationProposal = JSON.parse(
    execFileSync(process.execPath, [helper, 'organize', input, 'production'], {
      cwd: tmpdir(),
      encoding: 'utf8',
    }),
  );
  assert.equal(proposal.position_count, 8);
  assert.equal(proposal.phase, 'production');
});
