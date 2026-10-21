# Persisted run commands

Default briefs use [deliverable work_items](task-first.md) and create only actual work packets. The legacy example below needs reference_workflow:true for an explicitly requested full-template rehearsal.

The self-contained helper is at `../../../runtime/scripts/workflow.mjs` relative to this reference directory. Resolve that path to an absolute file path and use the task workspace as the working directory. The lead writes brief and event JSON directly; the user does not operate an internal form. Use English for these artifacts.

```text
node HELPER select BRIEF.json
node HELPER create RUN.json BRIEF.json
node HELPER next RUN.json
node HELPER agent-review RUN.json
node HELPER event RUN.json EVENT.json
```

`create` builds missing parent directories and refuses to overwrite a run. `event` takes a single-writer lock, requires the current revision and attempt, and atomically replaces the persisted state. The EVENT file may hold one event or an ordered array; an array is applied as one atomic batch whose first entry states `expected_revision` and whose later entries may omit it. If a crash leaves a lock, read `RUN.json.lock` for the writer's pid and start time and inspect that process before removing it. Each journal entry records `recorded_at`, the controller clock at recording time; it measures handoff and waiting, not model execution time. The snapshot embeds its reference organization, packets, artifact references, attempts, and event journal. It stays local.

## MCP tools

The plugin registers a stdio MCP server (`.mcp.json`, `mcp.mjs`) with the same commands as inline-JSON tools: `hakengaisya_triage_request`, `hakengaisya_triage`, `hakengaisya_select`, `hakengaisya_plan`, `hakengaisya_organize`, `hakengaisya_create_run`, `hakengaisya_next`, `hakengaisya_dispatch`, `hakengaisya_review`, `hakengaisya_event` and `hakengaisya_agent_review`. Run-file tools take `run_file`; pass an absolute path inside the task workspace, because a relative path is only accepted when the server was started with `HAKENGAISYA_WORKSPACE`. `hakengaisya_event` takes `events`, an ordered array applied atomically, and returns the next-actions snapshot. Tool availability does not prove the host will invoke them; the same host permissions and evidence duties apply.

Optional [DEI participation](model-participation.md) is configured in task-first briefs. Agent Review reports candidate consideration and the root manager's participation score/tag; it does not launch models or update technical ability scores.

## Brief

```json
{
  "run_id": "parser-fix-01",
  "objective": "Reject empty identifiers while preserving the parser error contract.",
  "domain": "software-engineering",
  "difficulty": "standard",
  "independent_streams": 1,
  "constraints": ["Preserve the public API."],
  "acceptance": ["Empty identifiers are rejected.", "Valid identifier behavior remains unchanged."],
  "existing_assets": ["Local parser module and existing checks."],
  "lead_context": "actual-host-context-id",
  "evidence_kind": "local_work"
}
```

For technical product work, use `domain: "technical-product-design"` and `product_discovery: true`. `independent_streams` describes genuinely separable work. Difficulty is `routine`, `standard`, or `complex`. Use `request_company: true` for an explicitly requested company walkthrough that would otherwise be direct. Optional `limits` can set `max_parallel`, `max_attempts`, and `max_dispatches`; do not exceed host authorization. For synthetic walkthroughs use `evidence_kind: "simulation"` and identify their evidence as synthetic.

## Event envelope and assignment

All events use a unique ID, the latest `expected_revision`, the current packet `attempt`, and the actual `actor_context`. The host lead remains the only file writer even when it records an event returned by another context.

```json
{
  "id": "assign-scope-01",
  "expected_revision": 0,
  "packet_id": "scope",
  "attempt": 1,
  "type": "assign",
  "actor_context": "actual-host-context-id",
  "objective": "Specify parser behavior and observable acceptance using the supplied request.",
  "assignment": {
    "owner_context": "actual-native-worker-id",
    "reviewer_context": "actual-host-context-id",
    "contributor_contexts": [],
    "writes": ["task-notes/scope.md"]
  }
}
```

Bind each declared contributor role to a real context in `contributor_contexts`, in role order. A context may hold several producer slots but cannot be the same packet's reviewer. Write paths are normalized workspace-relative paths; an empty list means read-only work. Write scopes are scheduling declarations, not filesystem sandboxes. Use `next` and the run snapshot to read actual packet requirements.

## Work and review

- `start`: the assigned owner context; no additional fields. Requires accepted dependencies, capacity, disjoint writes, and available retry budget.
- `submit`: owner context plus `outputs: [{"id": "required_output_id", "reference": "inspectable artifact reference", "summary": "What it contains."}]` and `evidence: [{"reference": "check reference", "summary": "Observed outcome."}]`. Include every required output exactly once. References must point to real inspectable evidence; the helper cannot inspect it for you.
- `review`: reviewer context plus `decision: "accepted"` or `"rejected"` and `checks: [{"index": 0, "result": "pass", "evidence_reference": "reviewed evidence", "note": "Observed result."}]`. Cover every gate item. Missing evidence is `unverified`; a behavioral mismatch is `fail`. Rejection requires at least one failed or unverified check.
- For accepted `handover`, also supply `task_checks` in the same format, one entry for every user criterion in the run's `acceptance` array. Every criterion must pass with evidence.
- `block`: participant context plus `reason`. It preserves the active packet and its write reservation.
- `resume`: lead context plus `reason` describing the resolution; restores the pre-block state.
- `reopen`: lead context plus `reason`; invalidates that packet and all downstream claims. Use for changed inputs or a lost worker; do not restart a stale attempt in place.

After every event, inspect returned next actions. `ready` is dependency-ready, not a promise that concurrency, writable scopes, actor availability, or budget permit an immediate start. `reviewing` requires a reviewer decision. `complete` means every stored gate is accepted; the host must still ensure references and identities are truthful.
