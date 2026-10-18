# Reporting and upward acceptance

Hakengaisya uses a dependency graph and a separate rooted reporting tree. A dependency answers when work is ready. A reporting line answers who may assign it, receive it, accept it or return it for correction. Shared technical interests do not grant authority.

New task-graph runs use schema_version:2 and a supervision record. lead_context is the root supervisor. Optional reporting_lines predeclare actual context relationships; every non-root context has one direct parent, and every path reaches the root. Cycles, multiple parents and disconnected supervisors fail validation. The host writes internal forms, never the user.

```json
{
  "lead_context": "host",
  "reporting_lines": [
    {"supervisor_context": "host", "subordinate_context": "team-lead"},
    {"supervisor_context": "team-lead", "subordinate_context": "employee"}
  ]
}
```

A work item defaults supervisor_context to lead_context. To delegate a component within a team, set its supervisor_context to team-lead. Give a later genuine integrated deliverable supervisor_context:host, with a dependency on the accepted component. Bind its owner to team-lead so the lead delivers upward. The terminal deliverable must report to the root. Levels are added for scoped responsibility and integration; no automatic administrative packets are generated.

## Event authority

- assign: the packet's responsible supervisor is the actor, and reviewer_context equals that supervisor. The owner is a different actual context. An owner without a recorded parent is enrolled under this supervisor; an existing parent cannot be bypassed or changed by assignment. Assignment.supervisor_context, if supplied, must match the packet. The root allocates this scope in the brief; a leaf cannot invent authority over another pending work item.
- submit: the actual owner submits evidence upward, with reports_to recorded in the result. Submission does not establish acceptance.
- review: only the direct supervisor accepts or rejects the current submitted attempt. Independent producer checks remain mandatory. A QA specialist may supply findings, but cannot replace the supervisor's signoff. Child acceptance never automatically accepts the lead's own delivery.
- resume/reopen: the responsible supervisor or an ancestor can resolve a blocker or reopen affected work. An unrelated manager cannot. Corrective control does not confer the power to skip a direct acceptance gate.

The root supervisor alone accepts the terminal user criteria. A subordinate failure prevents dependent upward integration; the supervisor returns that unit for correction with its attempt history intact. Meaningful upward deliveries and integration checks define gates, not organizational titles alone. Supervisors need review capability, with model/tool fit and overhead accounted for before claiming an optimized route.

## Planning and handoffs

Known actual worker contexts must match the work's reporting line. A planned context cannot be reused under two direct supervisors simply to reduce cost. Unknown worker slots bind to an actual context at assignment; the reporting checks still apply. A staffing plan does not generate the organization's semantic structure or price every supervisor independently: declared review/handoff overhead must cover that work, or costs remain incomplete.

dispatch and review expose supervisor_context, reports_to, acceptance_authority and root_context. Participants receive their task and reporting destination, without the full company transcript. Direct intake routes to the responsible supervisor for dispatch, not past that supervisor to an arbitrary employee.

Context labels are declared bindings, not authenticated provider identities or OS permissions. The host launches actual native contexts, checks decisions and evidence, then serializes events as the single writer. Schema1 historical runs and reference rehearsals keep their earlier behavior and do not gain these new guarantees retroactively. No reporting-line reorganization or signoff override is added implicitly.
