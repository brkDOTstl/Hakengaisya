const check = (ok, message) => { if (!ok) throw new Error(message); };
const context = value => check(typeof value === 'string' && value.trim(), 'Supply an actual supervision context label');

export function createSupervision(root, lines = []) {
  context(root); check(Array.isArray(lines), 'Reporting lines must be an array');
  const parents = new Map();
  for (const line of lines) {
    context(line.supervisor_context); context(line.subordinate_context);
    check(line.subordinate_context !== root && line.subordinate_context !== line.supervisor_context, 'Root and self reporting lines are invalid');
    check(!parents.has(line.subordinate_context), 'Each context needs one direct supervisor');
    parents.set(line.subordinate_context, line.supervisor_context);
  }
  for (const child of parents.keys()) {
    const visited = new Set(); let current = child;
    while (current !== root) {
      check(!visited.has(current), 'Cyclic reporting lines'); visited.add(current);
      check(parents.has(current), 'Reporting lines must reach the root supervisor'); current = parents.get(current);
    }
  }
  return { root_context: root, reporting_lines: [...parents].map(([subordinate_context, supervisor_context]) => ({ subordinate_context, supervisor_context })), acceptance_rule: 'The direct supervisor assigns, accepts or returns the subordinate work. Accepted subordinate artifacts do not accept the supervisor delivery to its own parent.' };
}

export function directSupervisor(supervision, owner) {
  return supervision.reporting_lines.find(line => line.subordinate_context === owner)?.supervisor_context ?? null;
}

export function assertRegisteredSupervisor(supervision, supervisor) {
  check(supervisor === supervision.root_context || directSupervisor(supervision, supervisor) !== null, 'Task supervisor must belong to the rooted reporting hierarchy');
}

export function bindSupervisedAssignment(run, packet, assignment, actor) {
  const supervisor = packet.supervisor_context;
  assertRegisteredSupervisor(run.supervision, supervisor);
  check(actor === supervisor, 'Only the responsible direct supervisor may assign this work');
  check(assignment.supervisor_context === undefined || assignment.supervisor_context === supervisor, 'Assignment cannot change the responsible supervisor');
  check(assignment.reviewer_context === supervisor, 'Acceptance belongs to the direct supervisor; a peer reviewer cannot replace it');
  check(assignment.owner_context !== run.supervision.root_context && assignment.owner_context !== supervisor, 'A supervisor cannot produce and accept its own delegated work');
  const parent = directSupervisor(run.supervision, assignment.owner_context);
  check(parent === null || parent === supervisor, 'Assignment cannot bypass or change an existing reporting line');
  if (parent === null) {
    const lines = [...run.supervision.reporting_lines, { subordinate_context: assignment.owner_context, supervisor_context: supervisor }];
    run.supervision = createSupervision(run.supervision.root_context, lines);
  }
  return supervisor;
}

export function assertSupervisedReview(run, packet) {
  if (!run.supervision) return;
  check(packet.assignment?.supervisor_context === packet.supervisor_context && packet.assignment.reviewer_context === packet.supervisor_context && directSupervisor(run.supervision, packet.assignment.owner_context) === packet.supervisor_context, 'Review must follow the responsible direct supervisor reporting line');
  check(packet.id !== 'handover' || packet.supervisor_context === run.supervision.root_context, 'Final acceptance belongs to the root supervisor');
}

export function canManageWork(run, packet, actor) {
  if (!run.supervision) return actor === run.lead_context;
  let current = packet.supervisor_context;
  while (current) {
    if (current === actor) return true;
    current = directSupervisor(run.supervision, current);
  }
  return false;
}
