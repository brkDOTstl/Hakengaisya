import type {
  Assignment,
  AssignmentInput,
  Packet,
  ReportingLine,
  Run,
  Supervision,
} from './types.ts';
import { check, isText } from './validate.ts';

function requireContext(value: unknown): asserts value is string {
  check(isText(value), 'Supply an actual supervision context label');
}

export function createSupervision(root: unknown, lines: unknown = []): Supervision {
  requireContext(root);
  check(Array.isArray(lines), 'Reporting lines must be an array');
  const parents = new Map<string, string>();
  for (const line of lines as Partial<ReportingLine>[]) {
    requireContext(line.supervisor_context);
    requireContext(line.subordinate_context);
    check(
      line.subordinate_context !== root && line.subordinate_context !== line.supervisor_context,
      'Root and self reporting lines are invalid',
    );
    check(!parents.has(line.subordinate_context), 'Each context needs one direct supervisor');
    parents.set(line.subordinate_context, line.supervisor_context);
  }
  for (const child of parents.keys()) {
    const visited = new Set<string>();
    let current = child;
    while (current !== root) {
      check(!visited.has(current), 'Cyclic reporting lines');
      visited.add(current);
      const parent = parents.get(current);
      check(parent !== undefined, 'Reporting lines must reach the root supervisor');
      current = parent;
    }
  }
  return {
    root_context: root,
    reporting_lines: [...parents].map(([subordinate_context, supervisor_context]) => ({
      subordinate_context,
      supervisor_context,
    })),
    acceptance_rule:
      'The direct supervisor assigns, accepts or returns the subordinate work. Accepted subordinate artifacts do not accept the supervisor delivery to its own parent.',
  };
}

export function directSupervisor(supervision: Supervision, owner: string): string | null {
  return (
    supervision.reporting_lines.find((line) => line.subordinate_context === owner)
      ?.supervisor_context ?? null
  );
}

export function assertRegisteredSupervisor(supervision: Supervision, supervisor: string): void {
  check(
    supervisor === supervision.root_context || directSupervisor(supervision, supervisor) !== null,
    'Task supervisor must belong to the rooted reporting hierarchy',
  );
}

// Binds a task-first assignment to its responsible supervisor and records a new reporting line
// for a first-time subordinate. Mutates run.supervision; callers pass a draft run.
export function bindSupervisedAssignment(
  run: Run,
  packet: Packet,
  assignment: AssignmentInput,
  actor: string,
): string {
  const { supervision } = run;
  check(supervision, 'Supervised assignment needs a reporting hierarchy');
  const supervisor = packet.supervisor_context;
  check(supervisor !== undefined, 'Supervised work needs a responsible supervisor');
  assertRegisteredSupervisor(supervision, supervisor);
  check(actor === supervisor, 'Only the responsible direct supervisor may assign this work');
  check(
    assignment.supervisor_context === undefined || assignment.supervisor_context === supervisor,
    'Assignment cannot change the responsible supervisor',
  );
  check(
    assignment.reviewer_context === supervisor,
    'Acceptance belongs to the direct supervisor; a peer reviewer cannot replace it',
  );
  check(
    assignment.owner_context !== supervision.root_context &&
      assignment.owner_context !== supervisor,
    'A supervisor cannot produce and accept its own delegated work',
  );
  const parent = directSupervisor(supervision, assignment.owner_context);
  check(
    parent === null || parent === supervisor,
    'Assignment cannot bypass or change an existing reporting line',
  );
  if (parent === null) {
    const lines = [
      ...supervision.reporting_lines,
      { subordinate_context: assignment.owner_context, supervisor_context: supervisor },
    ];
    run.supervision = createSupervision(supervision.root_context, lines);
  }
  return supervisor;
}

export function assertSupervisedReview(run: Run, packet: Packet): void {
  if (!run.supervision) return;
  const assignment: Assignment | null = packet.assignment;
  check(
    assignment !== null &&
      assignment.supervisor_context === packet.supervisor_context &&
      assignment.reviewer_context === packet.supervisor_context &&
      directSupervisor(run.supervision, assignment.owner_context) === packet.supervisor_context,
    'Review must follow the responsible direct supervisor reporting line',
  );
  check(
    packet.id !== 'handover' || packet.supervisor_context === run.supervision.root_context,
    'Final acceptance belongs to the root supervisor',
  );
}

export function canManageWork(run: Run, packet: Packet, actor: string): boolean {
  if (!run.supervision) return actor === run.lead_context;
  let current: string | null | undefined = packet.supervisor_context;
  while (current) {
    if (current === actor) return true;
    current = directSupervisor(run.supervision, current);
  }
  return false;
}
