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
7. **Periodic controller hard brakes (no reliance on lead memory):** Configure `audit_every_n_submissions` (integer `1..1000`), `audit_on_replan` (default `true`), and `max_minutes_between_audits` (`> 0..10080`). Once a threshold trips, `assertStartable` and `applyReview` (`decision: "accepted"`) hard-block further progress until `monitor_context` records a fresh `clear` checkpoint covering all active decisions and governing documents (corrective rework for an explicitly reopened cited packet remains permitted).
8. **Unified wake check (`compliance_wake_check`) and opt-in out-of-band watchdog (`scripts/compliance-watchdog.ts`):**
   - `compliance-wake-check <run.json> [request.json] [--force] [--reason <text>] [--exit-nonzero-on-wake]` evaluates every wake trigger (open blocking citations, submission threshold, replan, elapsed time, pending handover, or forced host lifecycle hook) and returns exit code `2` with the read-only `audit_packet` attached when a wake is required — ready for host `PostCompact`, `Stop`, or pre-question hooks.
   - `scripts/compliance-watchdog.ts` is an opt-in local daemon/one-shot helper run outside the lead session. It never starts automatically, defaults to `--emit-only` (writes wake packets without spawning processes), and when given an explicit `--wake-cmd <executable> --wake-arg ...` runs with `shell: false`, single-instance `watchdog.lock`, fingerprint deduplication, cooldown, hard `max_wakes` ceiling (default 20), and automatic retention of only the latest 3 wake packet files.

## 3. CLI and MCP commands

| Command (CLI) | MCP tool | Writes | Purpose |
| --- | --- | --- | --- |
| `compliance-inspect <run.json> [request.json]` | `hakengaisya_compliance_inspect` | No | Return compact, read-only oversight brief for `monitor_context` without raw transcripts |
| `compliance-wake-check <run.json> [--force] [--reason <text>] [--exit-nonzero-on-wake]` | `hakengaisya_compliance_wake_check` | No | Evaluate all wake triggers and return the read-only audit packet (exit code `2` on wake when flag set) |
| `compliance-record-rule <run.json> <request.json>` | `hakengaisya_compliance_record_rule` | Yes | Record a new settled decision/document or (monitor-only) supersede one with `owner_change_reference` |
| `compliance-cite <run.json> <request.json>` | `hakengaisya_compliance_cite` | Yes | Issue a citation against `lead_context` or an executor; optionally reopen tainted packets |
| `compliance-resolve <run.json> <request.json>` | `hakengaisya_compliance_resolve` | Yes | Resolve an open citation (monitor-only) with verification evidence |
| `compliance-checkpoint <run.json> <request.json>` | `hakengaisya_compliance_checkpoint` | Yes | Record a compliance audit checkpoint (`clear` or `violations-found`) for handover clearance |


## 4. Automatic wake-up recipes (hooks & opt-in watchdog)

### Host lifecycle hook (PostCompact / Stop / PreAskUser)

```text
node scripts/workflow.ts compliance-wake-check /abs/path/to/run.json --force --reason post-compact --exit-nonzero-on-wake
```

Exit `0` means no wake required; exit `2` prints JSON with `audit_packet` and `reasons` for the host hook to feed directly into `monitor_context`.

### Out-of-band local watchdog (opt-in)

Emit wake packets only (no subprocess):

```text
node scripts/compliance-watchdog.ts --run /abs/path/to/run.json --state-dir /abs/path/to/wd-state --emit-only
```

Auto-invoke an explicitly authorized local monitor CLI (e.g. a dedicated persistent `omp` or `agy` monitor session; `shell: false`, expanded `{audit_file}`, `{run_file}`, `{monitor_context}`, `{revision}`, `{reasons}` placeholders plus `HAKENGAISYA_*` env vars):

```text
node scripts/compliance-watchdog.ts \
  --run /abs/path/to/run.json \
  --state-dir /abs/path/to/wd-state \
  --cooldown-seconds 60 \
  --max-wakes 20 \
  --retain 3 \
  --wake-cmd <local-host-cli> --wake-arg ... --wake-arg {audit_file}
```
## Evidence boundary

These controls are structurally and synthetically verified by unit, workflow, organization, CLI/MCP and local subprocess watchdog tests. The controller and MCP server never launch models on their own; automatic subprocess waking occurs only when the user explicitly starts `scripts/compliance-watchdog.ts` with `--wake-cmd` or wires a host lifecycle hook. Live multi-compaction provider runs remain for 0.9 validation.
