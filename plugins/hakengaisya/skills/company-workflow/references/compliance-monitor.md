# Requirement & decision compliance monitor

Use `compliance_monitor` when a long-running task risks context-compaction amnesia or gradual drift from settled owner decisions and governing documents.

## Role boundary

- **Zero production work:** `monitor_context` must differ from `lead_context` and is rejected from `reporting_lines`, worker slots, replan context keys and all packet assignments (`owner_context`, `reviewer_context`, `contributor_contexts`).
- **Non-mergeable:** in organization composition (`compliance-monitor` module), `compliance_monitor` (`non_producing: true`, `escalates_to: "project_owner"`) cannot merge with any other role.
- **No silent rule erasure:** `lead_context` or `monitor_context` may add newly settled owner decisions or governing documents (`compliance_record_rule`), but only `monitor_context` may supersede an active rule, and only with an explicit `owner_change_reference`.

## Operating loop

1. Enable `brief.compliance_monitor` with `monitor_context`, initial `decisions` (`must_not_reask: true` by default) and `documents`.
2. Wake `monitor_context` with `hakengaisya_compliance_inspect` (read-only compact ledger + watched packet metadata, never raw execution transcripts).
3. Whenever `lead_context` or a watched executor forgets a settled decision, deviates from a governing document, substitutes an unapproved approach or tries to re-ask a `must_not_reask` decision, call `hakengaisya_compliance_cite`:
   - Returns a direct `correction_notice` quoting the exact settled decisions/sources (`do_not_reask_owner: true` when applicable).
   - Blocking citations against `lead_context` halt starting further packets until `monitor_context` verifies the correction and calls `hakengaisya_compliance_resolve`.
   - Blocking citations against an executor halt unrelated work and, with `reopen_packet: true`, immediately reopen the tainted packet (allowing strictly the corrective rework attempt `attempt > cited.attempt`).
   - Targets cannot self-clear their own citations.
4. Before terminal `handover` acceptance, `monitor_context` verifies the latest submission against all active decisions and governing documents and records `hakengaisya_compliance_checkpoint` (`status: "clear"`).
5. `monitor_context` may persist settled owner decisions across runs via `project_memory_register` (`category: "decisions"`), ranked at the top of the L1 frozen prefix.

## Automatic waking without relying on lead memory

- **Controller hard brakes:** set `audit_every_n_submissions`, `audit_on_replan` (default `true`), or `max_minutes_between_audits` in `brief.compliance_monitor`. When tripped, dispatch and review acceptance hard-block until `monitor_context` records a fresh `clear` checkpoint.
- **Host lifecycle hooks (`compliance-wake-check` / `hakengaisya_compliance_wake_check`):** wire `node HELPER compliance-wake-check RUN.json --force --reason post-compact --exit-nonzero-on-wake` (or without `--force` on `Stop` hooks). Exit `2` indicates a required wake and prints the compact `audit_packet`.
- **Opt-in local watchdog (`scripts/compliance-watchdog.ts`):** run outside the lead session with `--run <abs-run.json> --state-dir <abs-dir>` and optional `--wake-cmd <cli> --wake-arg ...`. Enforces single-instance lock, fingerprint dedup, cooldown, hard `max_wakes` cap, 3-file wake retention and clean exit on run completion; never auto-starts.
