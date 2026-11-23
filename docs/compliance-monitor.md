# Requirement & decision compliance monitor

Long-running agent sessions undergo repeated context compactions. When one primary lead or main executor carries both execution noise and governance memory, it gradually forgets settled owner decisions, drifts from governing documents, silently substitutes wrong implementations, or re-asks the owner questions that were already decided.

Hakengaisya adds a dedicated, zero-production **Requirement & Decision Compliance Monitor** (`compliance_monitor`) at both the organization-composition layer and the runtime workflow controller.

## 1. Organization module (`compliance-monitor`)

`config/organization-modules.json` provides the `compliance-monitor` capability module (`requires: ["core"]`) with one standalone position: `compliance_monitor` (`non_producing: true`, `escalates_to: "project_owner"`).

- **Zero production work:** performs no implementation, design, asset creation, or delivery-signoff work.
- **Non-mergeable:** `lib/organization.ts` refuses to merge any `non_producing` position into another role or merge any production role into it.
- **Direct escalation:** `compliance_monitor` is declared independent of `project_lead` and every production/QA role, and its findings escalate directly to `project_owner` so `project_lead` cannot silence them.

## 2. Runtime isolation and ledger (`lib/compliance-monitor.ts`)

Enable the monitor on a task-first brief via `compliance_monitor`:

```json
{
  "compliance_monitor": {
    "enabled": true,
    "monitor_context": "compliance-monitor",
    "watched_contexts": ["ctx-alpha"],
    "decisions": [
      {
        "id": "dec-storage-sqlite",
        "summary": "Persist sessions in local SQLite; do not use Redis.",
        "source": "docs/DECISIONS.md#D-01",
        "must_not_reask": true
      }
    ],
    "documents": [
      {
        "id": "doc-api-contract",
        "reference": "docs/api.md",
        "requirement": "Return deterministic JSON envelopes with revision numbers."
      }
    ]
  }
}
```

### Hard invariants enforced by the controller

1. **Strict context isolation:** `monitor_context` must differ from `lead_context` and is rejected from `reporting_lines`, `work_items[].supervisor_context`, `workers[].context_id`, `planning_limits.warm_context_keys`, replan context bindings, and all packet `assign` slots (`owner_context`, `reviewer_context`, `contributor_contexts`). Because it never runs production turns, its context stays small and uncompacted.
2. **Immutable settled-decision ledger:** `lead_context` or `monitor_context` may record newly settled owner decisions or governing documents via `compliance_record_rule`. Only `monitor_context` may supersede an active decision or document, and only with an explicit `owner_change_reference` — `lead_context` cannot unilaterally erase or overwrite settled decisions.
3. **Zero-reask citation & correction loop (`compliance_cite` / `compliance_resolve`):**
   - Only `monitor_context` may issue citations against `lead_context` or any watched/assigned executor (`forgotten-decision`, `violated-decision`, `reasked-settled-decision`, `doc-drift`, `unapproved-deviation`).
   - Every citation must reference at least one active `decision_id` or `document_id` and concrete `evidence_reference`, and returns an explicit `correction_notice` addressed to the drifting actor (flagging `do_not_reask_owner: true` whenever any cited decision has `must_not_reask: true`).
   - **Real execution teeth:**
     - An open blocking citation on `lead_context` halts starting any pending work until `monitor_context` verifies the correction and resolves it.
     - An open blocking citation on an executor halts unrelated work for that executor while allowing strictly the reopened corrective rework attempt (`attempt > cited.attempt`) when `reopen_packet: true` was set.
     - Cited packets cannot be accepted in `review` until `monitor_context` resolves the citation. Neither `lead_context` nor the cited executor can self-clear a citation.
4. **Pre-handover clearance checkpoint (`compliance_checkpoint`):** When `require_checkpoint_before_handover` is enabled (default `true`), terminal `handover` acceptance is blocked until `monitor_context` records a `clear` checkpoint at or after the latest packet submission / rule update covering every active decision and governing document, with zero open blocking citations.
5. **Prefix-cache-safe dispatch reminders:** `prepareDispatch` delivers applicable settled decisions, governing documents and open correction directives inside `turn_delta` (`compliance_directives`), keeping each worker's frozen `[L0 + L1]` prefix byte-identical.
6. **Cross-run `project_memory` bridge:** `lib/project-memory.ts` places the `decisions` category first (`rank 0`) in canonical L1 memory, and allows an active `monitor_context` to register cross-run settled owner decisions (`category: "decisions"`) while keeping non-decision categories restricted to accepted packets' independent direct supervisors.

## 3. CLI and MCP commands

| Command (CLI) | MCP tool | Writes | Purpose |
| --- | --- | --- | --- |
| `compliance-inspect <run.json> [request.json]` | `hakengaisya_compliance_inspect` | No | Return compact, read-only oversight brief for `monitor_context` without raw transcripts |
| `compliance-record-rule <run.json> <request.json>` | `hakengaisya_compliance_record_rule` | Yes | Record a new settled decision/document or (monitor-only) supersede one with `owner_change_reference` |
| `compliance-cite <run.json> <request.json>` | `hakengaisya_compliance_cite` | Yes | Issue a citation against `lead_context` or an executor; optionally reopen tainted packets |
| `compliance-resolve <run.json> <request.json>` | `hakengaisya_compliance_resolve` | Yes | Resolve an open citation (monitor-only) with verification evidence |
| `compliance-checkpoint <run.json> <request.json>` | `hakengaisya_compliance_checkpoint` | Yes | Record a compliance audit checkpoint (`clear` or `violations-found`) for handover clearance |

## Evidence boundary

These controls are structurally and synthetically verified by unit, workflow, organization and CLI/MCP tests. The native host still launches `monitor_context`, supplies real observed artifacts/messages to audit, and delivers `correction_notice` directives to the cited lead or executor.
