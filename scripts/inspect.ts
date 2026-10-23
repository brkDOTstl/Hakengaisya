import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPresets } from '../lib/commands.ts';

const templateDirectory = fileURLToPath(new URL('../templates/', import.meta.url));
const INTERACTION_TYPES = ['collaboration', 'service', 'facilitation', 'review'] as const;
type InteractionType = (typeof INTERACTION_TYPES)[number];
const ROLE_KINDS = ['lead', 'specialist', 'team'] as const;
type RoleKind = (typeof ROLE_KINDS)[number];

interface ProjectConfig {
  active_templates: string[];
}

interface InspectRole {
  id: string;
  name: string;
  purpose: string;
  kind: RoleKind;
  optional: boolean;
  model_binding: null;
  decisions: string[];
  deliverables: string[];
}

interface InspectEdge {
  from: string;
  to: string;
}

interface InspectInteraction extends InspectEdge {
  type: InteractionType;
  contract: string;
}

interface InspectStage {
  id: string;
  owner: string;
  contributors: string[];
  depends_on: string[];
  inputs: string[];
  outputs: string[];
  audits?: string[];
  gate: { reviewer: string; checks: string[]; rework_to: string };
}

interface InspectTemplate {
  schema_version: number;
  id: string;
  status: string;
  name: string;
  purpose: string;
  reference_ids: string[];
  root: string;
  roles: InspectRole[];
  authority: InspectEdge[];
  interactions: InspectInteraction[];
  workflow: { external_inputs: string[]; on_rejection: string; stages: InspectStage[] };
  staff_feedback?: {
    coordinator_role: string;
    observer_roles: string[];
    policy: string;
    events: string[];
    effect: string;
  };
}

const project: ProjectConfig = JSON.parse(
  await readFile(new URL('../config/project.json', import.meta.url), 'utf8'),
);
const identifierPattern = /^[a-z][a-z0-9_-]*$/;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireText(value: unknown, name: string): void {
  requireCondition(
    typeof value === 'string' && value.trim().length > 0,
    `${name} must be nonempty text`,
  );
}

function uniqueStrings(values: unknown, name: string): Set<string> {
  requireCondition(Array.isArray(values), `${name} must be an array`);
  for (const value of values) requireText(value, name);
  requireCondition(new Set(values).size === values.length, `${name} contains duplicates`);
  return new Set(values);
}

function indexed<T extends { id: string }>(items: T[] | undefined, name: string): Map<string, T> {
  requireCondition(Array.isArray(items) && items.length > 0, `${name} must be a nonempty array`);
  const result = new Map<string, T>();
  for (const item of items) {
    requireCondition(
      item && identifierPattern.test(item.id),
      `${name} contains an invalid identifier`,
    );
    requireCondition(!result.has(item.id), `${name} contains duplicate identifier ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

function topologicalOrder(ids: string[], edges: readonly InspectEdge[], name: string): string[] {
  const incoming = new Map<string, number>(ids.map((id): [string, number] => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id): [string, string[]] => [id, []]));
  const seenEdges = new Set<string>();
  for (const { from, to } of edges) {
    requireCondition(incoming.has(from) && incoming.has(to), `${name} references an unknown node`);
    requireCondition(from !== to, `${name} contains a self edge`);
    const key = `${from}:${to}`;
    requireCondition(!seenEdges.has(key), `${name} contains a duplicate edge`);
    seenEdges.add(key);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    outgoing.get(from)?.push(to);
  }
  const ready = ids.filter((id) => incoming.get(id) === 0);
  const result: string[] = [];
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor];
    result.push(id);
    for (const child of outgoing.get(id) ?? []) {
      incoming.set(child, (incoming.get(child) ?? 0) - 1);
      if (incoming.get(child) === 0) ready.push(child);
    }
  }
  requireCondition(result.length === ids.length, `${name} contains a cycle`);
  return result;
}

interface ValidateResult {
  roles: Map<string, InspectRole>;
  stages: Map<string, InspectStage>;
  order: string[];
}

function validate(template: InspectTemplate): ValidateResult {
  requireCondition(template.schema_version === 1, 'Unsupported schema version');
  requireCondition(identifierPattern.test(template.id), 'Invalid template identifier');
  requireCondition(template.status === 'draft', 'This inspector supports draft templates only');
  requireText(template.name, 'Template name');
  requireText(template.purpose, 'Template purpose');
  requireCondition(
    uniqueStrings(template.reference_ids, 'Reference identifiers').size > 0,
    'References are required',
  );

  const roles = indexed(template.roles, 'Roles');
  requireCondition(roles.has(template.root), 'Root references an unknown role');
  requireCondition(roles.get(template.root)?.kind === 'lead', 'Root must be a lead');
  for (const role of roles.values()) {
    requireText(role.name, `${role.id} name`);
    requireText(role.purpose, `${role.id} purpose`);
    requireCondition(ROLE_KINDS.includes(role.kind), `${role.id} has an invalid kind`);
    requireCondition(typeof role.optional === 'boolean', `${role.id} must specify optional status`);
    requireCondition(
      role.model_binding === null,
      `${role.id} must remain unbound in this design prototype`,
    );
    requireCondition(
      uniqueStrings(role.decisions, `${role.id} decisions`).size > 0,
      `${role.id} needs decision rights`,
    );
    requireCondition(
      uniqueStrings(role.deliverables, `${role.id} deliverables`).size > 0,
      `${role.id} needs deliverables`,
    );
  }

  requireCondition(Array.isArray(template.authority), 'Authority must be an array');
  topologicalOrder([...roles.keys()], template.authority, 'Authority graph');
  const managers = new Map<string, number>(
    [...roles.keys()].map((id): [string, number] => [id, 0]),
  );
  for (const edge of template.authority) {
    requireCondition(
      roles.get(edge.from)?.kind === 'lead',
      `${edge.from} cannot delegate as a manager`,
    );
    managers.set(edge.to, (managers.get(edge.to) ?? 0) + 1);
  }
  for (const [id, count] of managers) {
    requireCondition(
      count === (id === template.root ? 0 : 1),
      `${id} has an invalid manager count`,
    );
  }

  requireCondition(Array.isArray(template.interactions), 'Interactions must be an array');
  const interactions = new Set<string>();
  for (const edge of template.interactions) {
    requireCondition(
      roles.has(edge.from) && roles.has(edge.to),
      'Interaction references an unknown role',
    );
    requireCondition(edge.from !== edge.to, 'Interaction contains a self edge');
    requireCondition(INTERACTION_TYPES.includes(edge.type), 'Unknown interaction type');
    requireText(edge.contract, 'Interaction contract');
    const key = `${edge.from}:${edge.to}:${edge.type}`;
    requireCondition(!interactions.has(key), 'Duplicate interaction');
    interactions.add(key);
  }

  const stages = indexed(template.workflow?.stages, 'Workflow stages');
  const externalInputs = uniqueStrings(template.workflow.external_inputs, 'External inputs');
  requireText(template.workflow.on_rejection, 'Rejection policy');
  const dependencyEdges: InspectEdge[] = [];
  const producers = new Map<string, string>();
  const usedRoles = new Set<string>();
  if (template.staff_feedback) {
    requireCondition(
      roles.has(template.staff_feedback.coordinator_role),
      'Staff feedback references an unknown coordinator',
    );
    requireCondition(
      template.staff_feedback.policy === 'staff/policy.json',
      'Unknown staff policy',
    );
    requireCondition(
      template.staff_feedback.effect === 'advisory',
      'Staff feedback must remain advisory',
    );
    uniqueStrings(template.staff_feedback.events, 'Staff feedback events');
    for (const observer of uniqueStrings(
      template.staff_feedback.observer_roles,
      'Staff feedback observers',
    )) {
      requireCondition(roles.has(observer), 'Staff feedback references an unknown observer');
      requireCondition(
        observer !== template.staff_feedback.coordinator_role,
        'Coordinator cannot be its own peer observer',
      );
      usedRoles.add(observer);
    }
    usedRoles.add(template.staff_feedback.coordinator_role);
  }
  for (const stage of stages.values()) {
    requireCondition(roles.has(stage.owner), `${stage.id} references an unknown owner`);
    usedRoles.add(stage.owner);
    const contributors = uniqueStrings(stage.contributors, `${stage.id} contributors`);
    requireCondition(
      !contributors.has(stage.owner),
      `${stage.id} repeats its owner as a contributor`,
    );
    for (const contributor of contributors) {
      requireCondition(roles.has(contributor), `${stage.id} references an unknown contributor`);
      usedRoles.add(contributor);
    }
    for (const dependency of uniqueStrings(stage.depends_on, `${stage.id} dependencies`)) {
      dependencyEdges.push({ from: dependency, to: stage.id });
    }
    uniqueStrings(stage.inputs, `${stage.id} inputs`);
    const outputs = uniqueStrings(stage.outputs, `${stage.id} outputs`);
    requireCondition(outputs.size > 0, `${stage.id} needs an output`);
    for (const output of outputs) {
      requireCondition(
        !producers.has(output) && !externalInputs.has(output),
        `Duplicate artifact ${output}`,
      );
      producers.set(output, stage.id);
    }
    const gate = stage.gate;
    requireCondition(gate && roles.has(gate.reviewer), `${stage.id} needs a known reviewer`);
    requireCondition(
      gate.reviewer !== stage.owner && !contributors.has(gate.reviewer),
      `${stage.id} permits producer self-review`,
    );
    usedRoles.add(gate.reviewer);
    requireCondition(
      uniqueStrings(gate.checks, `${stage.id} gate checks`).size > 0,
      `${stage.id} needs acceptance checks`,
    );
    requireCondition(stages.has(gate.rework_to), `${stage.id} references an unknown rework stage`);
  }

  const order = topologicalOrder([...stages.keys()], dependencyEdges, 'Workflow graph');
  const ancestors = new Map<string, Set<string>>();
  for (const id of order) {
    const stage = stages.get(id);
    requireCondition(stage, `${id} is missing from the workflow order`);
    const priorStages = new Set<string>(stage.depends_on);
    for (const dependency of stage.depends_on) {
      for (const ancestor of ancestors.get(dependency) ?? []) priorStages.add(ancestor);
    }
    ancestors.set(id, priorStages);
    for (const input of stage.inputs) {
      requireCondition(
        externalInputs.has(input) || priorStages.has(producers.get(input) ?? ''),
        `${id} consumes unavailable artifact ${input}`,
      );
    }
    requireCondition(
      stage.gate.rework_to === id || priorStages.has(stage.gate.rework_to),
      `${id} reworks an unrelated or later stage`,
    );
    for (const audited of uniqueStrings(stage.audits ?? [], `${id} audits`)) {
      requireCondition(priorStages.has(audited), `${id} audits a stage it does not depend on`);
    }
  }
  const dependedOn = new Set<string>(dependencyEdges.map((edge) => edge.from));
  const terminalStages = [...stages.keys()].filter((id) => !dependedOn.has(id));
  requireCondition(
    terminalStages.length === 1 && terminalStages[0] === 'handover',
    'Workflow must end with one handover',
  );
  for (const role of roles.values()) {
    requireCondition(role.optional || usedRoles.has(role.id), `${role.id} is mandatory but unused`);
  }
  return { roles, stages, order };
}

function mermaid(template: InspectTemplate): string {
  const escapeLabel = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replace(/[\r\n]/g, ' ');
  const lines: string[] = ['flowchart TB'];
  for (const role of template.roles) lines.push(`  ${role.id}["${escapeLabel(role.name)}"]`);
  for (const edge of template.authority) lines.push(`  ${edge.from} --> ${edge.to}`);
  for (const edge of template.interactions)
    lines.push(`  ${edge.from} -. ${edge.type} .-> ${edge.to}`);
  return lines.join('\n');
}

const args = process.argv.slice(2);
const showMermaid = args.includes('--mermaid');
const selectors = args.filter((arg) => arg !== '--mermaid');
requireCondition(selectors.length <= 1, 'Usage: node scripts/inspect.ts [template-id] [--mermaid]');
if (selectors.length)
  requireCondition(identifierPattern.test(selectors[0]), 'Invalid template selector');
requireCondition(!showMermaid || selectors.length === 1, 'Select one template for Mermaid output');

const files = selectors.length
  ? [`${selectors[0]}.json`]
  : project.active_templates.map((id) => `${id}.json`).sort();
requireCondition(files.length > 0, 'No templates found');
for (const file of files) {
  try {
    const template: InspectTemplate = JSON.parse(
      await readFile(path.join(templateDirectory, file), 'utf8'),
    );
    requireCondition(file === `${template.id}.json`, 'Filename and template identifier disagree');
    const result = validate(template);
    if (showMermaid) {
      console.log(mermaid(template));
    } else {
      console.log(
        `PASS ${template.id}: ${result.roles.size} roles, ${result.stages.size} stages, ${template.interactions.length} interactions`,
      );
      console.log(`  One valid dependency order: ${result.order.join(', ')}`);
      console.log('  Independent stages may overlap.');
      console.log('  Structural validation only; no agents or model calls executed.');
    }
  } catch (error) {
    console.error(`FAIL ${file}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
if (!selectors.length && !showMermaid) {
  try {
    for (const preset of await loadPresets())
      console.log(
        `PASS preset ${preset.id}@${preset.revision}: ${preset.variants.length} declared variants, ${preset.exceptions.length} correction paths; structural contract only.`,
      );
  } catch (error) {
    console.error(`FAIL presets: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
