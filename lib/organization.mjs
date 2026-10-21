import { createSupervision } from './supervision.mjs';

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const text = (value) =>
  check(typeof value === 'string' && value.trim(), 'Organization fields need nonempty text');
const names = (values, name) => {
  check(
    Array.isArray(values) && new Set(values).size === values.length,
    `${name} must be a unique array`,
  );
  values.forEach(text);
  return values;
};

export function composeOrganization(catalog, project, phaseId) {
  text(project.id);
  text(project.objective);
  check(
    Number.isInteger(project.max_positions) && project.max_positions > 0,
    'Supply a positive position ceiling',
  );
  check(
    Number.isInteger(project.max_active_agents) && project.max_active_agents > 0,
    'Supply a separate active-agent ceiling',
  );
  const modules = new Map();
  for (const module of catalog.modules) {
    text(module.id);
    check(!modules.has(module.id), 'Duplicate capability module');
    modules.set(module.id, module);
    names(module.requires, 'Module dependencies');
    check(Array.isArray(module.positions), 'Module positions must be an array');
  }
  const core = names(project.core_modules, 'Core modules');
  const optional = names(project.optional_modules ?? [], 'Optional modules');
  check(!optional.some((id) => core.includes(id)), 'Core and optional modules must be distinct');
  const allowed = new Set([...core, ...optional]);
  for (const id of allowed) check(modules.has(id), `Unknown capability module: ${id}`);
  const phases = project.phases ?? [];
  names(
    phases.map((phase) => phase.id),
    'Phase identifiers',
  );
  for (const phase of phases) {
    names(phase.modules, 'Phase modules');
    check(
      phase.modules.every((id) => allowed.has(id)),
      'Phase selects an unapproved module',
    );
    names(phase.exit_criteria, 'Phase exit criteria');
    check(phase.exit_criteria.length > 0, 'A phase needs observable exit criteria');
    if (phase.months)
      check(
        Array.isArray(phase.months) &&
          phase.months.length === 2 &&
          phase.months.every(Number.isInteger) &&
          phase.months[0] >= 1 &&
          phase.months[1] >= phase.months[0] &&
          phase.months[1] <= project.reference_duration_months,
        'Invalid reference phase calendar',
      );
  }
  const phase = phaseId === undefined ? null : phases.find((item) => item.id === phaseId);
  check(phaseId === undefined || phase, 'Unknown organization phase');
  const selected = new Set();
  const visiting = new Set();
  function add(id) {
    check(allowed.has(id) && modules.has(id), `Module dependency is not approved: ${id}`);
    if (selected.has(id)) return;
    check(!visiting.has(id), 'Cyclic module dependencies');
    visiting.add(id);
    modules.get(id).requires.forEach(add);
    visiting.delete(id);
    selected.add(id);
  }
  (phase?.modules ?? core).forEach(add);
  const positions = new Map();
  for (const id of selected)
    for (const original of modules.get(id).positions) {
      text(original.id);
      text(original.title);
      check(!positions.has(original.id), 'Duplicate position identifier');
      text(original.evidence_mode);
      names(original.independent_of ?? [], 'Independent role requirements');
      for (const key of ['functions', 'deliverables', 'skills']) {
        names(original[key], `Position ${key}`);
        check(original[key].length > 0, 'Positions need real work, outputs and skills');
      }
      check(
        original.reports_to === null || typeof original.reports_to === 'string',
        'Declare the direct superior',
      );
      positions.set(original.id, {
        ...structuredClone(original),
        independent_of: [...(original.independent_of ?? [])],
        evidence_requirements: [original.evidence_mode],
        module: id,
        covers: [original.id],
        model_id: null,
        binding_status: 'unbound',
      });
    }
  const allowedPositions = new Set(
    [...allowed].flatMap((id) => modules.get(id).positions.map((position) => position.id)),
  );
  for (const overrides of [project.position_overrides ?? {}, phase?.position_overrides ?? {}])
    for (const [id, fields] of Object.entries(overrides)) {
      check(allowedPositions.has(id), 'Override references an unknown or unapproved position');
      check(
        Object.keys(fields).every((key) =>
          ['title', 'functions', 'deliverables', 'skills'].includes(key),
        ),
        'Position overrides cannot change authority or evidence requirements',
      );
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'title') text(value);
        else {
          names(value, `Override ${key}`);
          check(value.length > 0, 'Overrides must preserve real responsibilities');
        }
      }
      if (positions.has(id)) Object.assign(positions.get(id), structuredClone(fields));
    }
  for (const merge of phase?.merge_positions ?? project.merge_positions ?? []) {
    const from = positions.get(merge.from);
    const into = positions.get(merge.into);
    check(
      from && into && from !== into && from.reports_to !== null && into.reports_to !== null,
      'Merges need two active non-root positions',
    );
    check(
      from.reports_to === into.id || from.reports_to === into.reports_to,
      'Merging across reporting branches needs an explicit redesign',
    );
    for (const key of [
      'functions',
      'deliverables',
      'skills',
      'covers',
      'independent_of',
      'evidence_requirements',
    ])
      into[key] = [...new Set([...into[key], ...from[key]])];
    check(
      !into.independent_of.some((id) => into.covers.includes(id)),
      'Independent checking cannot merge into its production position',
    );
    for (const position of positions.values())
      if (position.reports_to === from.id) position.reports_to = into.id;
    into.evidence_mode =
      'Review every covered responsibility; preserve any human or external evidence requirement.';
    positions.delete(from.id);
  }
  const roles = [...positions.values()];
  const roots = roles.filter((position) => position.reports_to === null);
  check(roots.length === 1, 'Compose exactly one accountable project root');
  check(
    roles.every((position) => position.reports_to === null || positions.has(position.reports_to)),
    'A required superior is inactive',
  );
  check(
    roles.length <= project.max_positions,
    'Organization exceeds the declared position ceiling',
  );
  const hierarchy = createSupervision(
    roots[0].id,
    roles
      .filter((position) => position.reports_to !== null)
      .map((position) => ({
        subordinate_context: position.id,
        supervisor_context: position.reports_to,
      })),
  );
  return {
    schema_version: 1,
    kind: 'organization-proposal',
    project_id: project.id,
    objective: project.objective,
    phase: phase?.id ?? 'core',
    selected_modules: [...selected],
    position_count: roles.length,
    max_active_agents: project.max_active_agents,
    positions: roles,
    reporting_lines: hierarchy.reporting_lines.map((line) => ({
      subordinate_position: line.subordinate_context,
      supervisor_position: line.supervisor_context,
    })),
    acceptance: roles.map((position) => ({
      position: position.id,
      direct_signoff_by: position.reports_to,
      own_production_signoff_by: position.reports_to,
      root_acceptance:
        position.reports_to === null
          ? 'Project owner and real outcome evidence; no self-certified production.'
          : null,
    })),
    exit_criteria: phase?.exit_criteria ?? [],
    reference_months: phase?.months ?? null,
    calendar_basis: 'Human project planning reference, not an AI runtime or delivery prediction.',
    binding_boundary:
      'Position identifiers are abstract roles, not actual agent contexts. Build deliverable work and bind qualified models, tools and independent superiors before execution. Phase or merge proposals never reorganize a running company.',
    cost_estimate_usd: null,
    automatic_execution: false,
  };
}
