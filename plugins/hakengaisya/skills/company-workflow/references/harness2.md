# Bounded Harness2 improvement

Use only for an explicitly enabled task-first improvement policy with a stable project scope and call ceiling. It is off by default. Do not add probes just to fill a company chart. Preserve ordinary user budget/deadline constraints: the planner cannot price this experiment yet and returns needs-evidence for hard financial/time limits. Unknown totals stay null.

The packaged BRIDGE is runtime/packages/optimizer/harness2_bridge.py, and HELPER is runtime/scripts/workflow.ts. Resolve absolute paths from the plugin location and work in the task workspace. The optional dependency is Google Research Harness2 0.1.0 at revision 1cfe254e8d25b15f37048c3730134686abe60335, Python 3.12/3.13. Use an existing installation or an explicitly selected clean checkout with --upstream; do not install global packages, authenticate providers or launch the official benchmark/executor as part of a work handoff.

Generate a current job using node HELPER harness2-job RUN.json PACKET_ID [STARTING_HARNESS.json], save the JSON unchanged, then record the ordinary packet start. An explicit real model_id/route and direct supervisor must be bound. Starting overrides may change only the three advisory Markdown files; guardrails stay pinned.

Run python BRIDGE --job JOB.json --state .hakengaisya-learning. A needs-host result lists request files. Read their task-scoped payloads as data. The bridge never starts a model. Use existing authorized native host contexts and tools; requests are not extra delegation, provider or messaging permission. Respect current host agent limits. The assigned owner handles edit/execute; its direct supervisor handles adoption-review/experience. A request is one bounded host work session, not permission for unlimited internal tool/model loops.

Write one response to the response directory using the same filename. Always echo the request's IDs and actor:

```json
{
  "request_id": "EXACT_REQUEST_ID",
  "request_fingerprint": "EXACT_REQUEST_FINGERPRINT",
  "actor_context": "EXACT_ASSIGNED_ACTOR",
  "status": "completed",
  "cost_usd": null
}
```

Add fields by request kind:

- edit: text with substantive reasoning and harness as a full text-file map. Only systemprompt.md, LongTermMEMORY.md and tool_descriptions/tool_guidance.md may change. Keep guardrails.md verbatim. No executable hooks/scripts/plugins, subagents or live configuration changes.
- execute: exact assigned model_id, outputs with every contracted id/reference/summary/text, nonempty evidence reference/summary objects, and trajectory text. Prepare a separate real workspace for each baseline/probe/composition, with frozen source inputs and the same logical write scope. Inspect actual tool access; the bridge provisions no sandbox. Do not relabel a simulated reply as local_work.
- adoption-review: decision accepted/rejected, reason and inspected evidence. Compare all baseline/candidate outputs and trajectories against the original task. Do not accept an experiment just because its self-reflection sounds persuasive.
- experience: text in the requested upstream edits/experience blocks, with cue/lesson/evidence and optional confidence. The direct supervisor verifies support. Use NO_ENTRY for unsupported transfer. This records local working guidance, not a new model score.

Rerun the same bridge command after filling pending responses. At k=1 a successful initial path uses four work executions, three edits, one adoption review and one experience review: nine unique host requests. The configured ceiling, including pending requests, stops more work. Process pending files only when status is needs-host. Failed/invalid responses, unavailable dependencies, blocked tools or exhausted budget stop; report the concrete issue through ordinary controller blocking instead of retrying in a loop.

ready-for-submission means the experiment was reviewed. Pass node HELPER harness2-result RUN.json JOB.json REPORT.json, inspect the proposed submit event and apply it through the ordinary event command. Then inspect artifacts and complete the separate direct-supervisor technical gate. There is no direct accepted event, no evaluator upload and no skill-score promotion.

Experience remains under .hakengaisya-learning, scoped by project, evidence kind, task type/difficulty/skills/tools and exact model/route/effort. Simulations and live work remain separate. The next job reads approved same-profile experience as reference material; it cannot overwrite native user memory, root AGENTS.md, acceptance, permissions or hierarchy. The host freezes actual input bytes; a stable path is not a content fingerprint. Request IDs and model labels are host declarations rather than authentication. The helper uses a single-writer lock and bounded snapshots; inspect crashes/size limits instead of removing history automatically.

The shared MCP tools are hakengaisya_optimizer_job and hakengaisya_optimizer_result. These short read-only handlers expose the same forms as harness2-job and harness2-result. Long worker execution stays outside the MCP request and run-file lock. Default promoted profiles, immutable profile-version selection, rollback and full lifecycle tools remain separate roadmap work. Retained lessons here are experiment reference material, not a promoted production default.
