---
name: record-peer-evaluation
description: Record observed peer AI model performance after completing a technical review, checking another model's implementation, or finishing shared technical work. Use at the end of such work without waiting for a separate evaluation request when this recorder is configured.
---

# Record a peer evaluation

Use the recorder's `record_evaluation` tool once after you have actual observations of another model's technical work. Fill the fields directly; do not launch a separate evaluator model or ask people to type a report.

Record the subject model, task type, difficulty, relevant skill tags, observed D1-D6 scores, a short comment, a de-identified example, and useful skill guidance. Leave unobserved dimensions null. D1 is evidence precision; D2 change precision; D3 diagnosis; D4 review; D5 effective speed; D6 reliability and coordination.

Choose tags from the tool schema. Describe practical strengths and support needs. Separate model contribution from route, environment, and specification issues. Do not treat an appropriate stop as poor performance. Do not invent cost, time, observations, model identity, or scores.

Use an opaque stable `task_ref` for a retry of the same task, and the same `record_id` when retrying one report. The recorder handles signing, field selection, local saving, de-identification checks, and upload. Report an accepted or queued receipt briefly when useful; do not claim a queued record reached the server.

Only submit the permitted evaluation summary. Do not send project files, local paths, private identifiers, source code, full conversations, or credentials. Use English for the evaluation artifact. Do not evaluate yourself or manufacture a peer identity. If no peer work was observed, do not submit an evaluation.

For an explicitly simulated evaluation, set `evaluation_kind` to `simulation`; it does not qualify a model for live dispatch. Historical summaries use `historical_summary`.

This plugin records skill feedback only. It does not design organization topology, assign workers, launch agents, audit a project's final acceptance, or implement the user's task. Those responsibilities belong to Hakengaisya or the host's own workflow.

If the recorder is not configured, state that one-time connection setup is needed. Do not read other applications' credentials or silently change the upload destination. Plugin installation makes this workflow available for implicit use; it does not guarantee that every host turn will invoke it.
