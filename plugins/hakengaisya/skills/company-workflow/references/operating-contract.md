# Operating contract

Version0.4 enters through [task-first planning](task-first.md). Reference roles below are optional operating practices; the six-stage reference process is an explicit rehearsal only.

## Responsibilities and scale

Keep the reference organization stable during the first trials. Activate its capabilities to meet actual work, rather than starting every department. Scope analysis, design, delivery, assurance, and task leadership are responsibility slots. Platform support is needed only for an environment gap; enablement is needed only for a named specialist gap. A ready existing environment can satisfy its packet through recorded inspection without a separate platform worker.

Compact runs reuse responsibility slots across a small set of actual contexts. Company runs can use more specialized contexts, but the default permits at most three concurrent packets; obey any lower host or user cap. Native agent selection and model selection are distinct decisions. Native agents may inherit the same model as the host.

The lead owns prioritization, assignments, conflict resolution, state updates, and the final handover. Workers own their bounded implementation findings. Reviewers own acceptance findings. Model performance comments cannot overturn a failing behavioral check.

## Exploration without user research

For an exploration-only request, the research packet may produce a truthful evidence inventory with no observed user findings. Cite the supplied brief and any actual technical sources, label proposed user needs as hypotheses, list the missing evidence, and define a prototype or future research plan. The research gate may accept that inventory as a basis for hypothesis exploration; it does not establish user value. The final handover remains an unvalidated concept or prototype and must match that limited scope.

If the accepted scope requires validated user needs, usability results, or actual user testing, an empty inventory cannot satisfy it. Keep the relevant packet blocked or its review unverified until actual evidence is available. Do not silently downgrade the user's required outcome to exploration or invent interview results. Merely being able to build the prototype proves neither demand nor usability.

## Work items within a packet

Before delegating a large implementation or prototype packet, write a local work-item contract:

```json
{
  "id": "parser-change",
  "parent_packet": "implementation",
  "objective": "Reject empty identifiers using the existing parser error format.",
  "owner_context": "actual-native-agent-id",
  "inputs": ["accepted scope reference", "parser contract reference"],
  "depends_on": [],
  "writes": ["src/parser.mjs", "tests/parser.test.mjs"],
  "outputs": ["inspectable parser change", "behavioral check evidence"],
  "acceptance": ["Empty identifiers are rejected; valid identifiers retain their behavior."],
  "return_contract": "Report changed files, checks performed, observed outcomes, blockers, and integration notes."
}
```

This is a host-managed decomposition artifact, not an additional state-machine packet in this version. Parallel items must have disjoint write ownership. A dependent item waits for its required result. The parent owner integrates the items and submits all parent outputs. Passing individual checks does not replace verifying integrated behavior.

## Review independence

Record the real native context ID when available. One actual context holding two role titles remains one producer. Changing the label does not create a reviewer. Provide the reviewer the accepted scope, artifact references, check requirements, and evidence; avoid giving only the producer's verdict. Reviewers can inspect implementation evidence but must assess it themselves. Automated state checks are not proof of distinct agent identities; the lead must bind them honestly.

The independent verification packet must be owned by a context outside the implementation packet's owner and contributors. Product evaluation uses a context outside prototype production. A review of the final report also checks all user acceptance criteria, so a polished handover cannot conceal unverified behavior.

## Rework and interruption

A rejection names a failed or unverified gate check and its responsible rework packet. The helper retains old attempts and clears affected downstream outputs. An upstream scope change may invalidate the whole run; a local implementation correction preserves unaffected scope and design evidence. Reopened work gets a new attempt. Any live worker with an invalidated attempt must be interrupted or its result discarded by the host.

After interruption, load the persisted run and inspect ready, running, reviewing, and blocked packets. Reconcile running packets against actual native agent status before continuing. Do not assume a worker still exists just because its old state says running. Reopen a lost attempt with a reason. Do not accept a stale result.

Default limits are three attempts per affected packet and twenty-four starts per run. Reaching a limit stops blind re-dispatch; it does not mean success. Revise the task plan or report the concrete unresolved issue. The helper does not infer USD costs from these counts.

## Information boundaries

Local run state contains local task details and evidence references. Keep it in the task's local workspace. Only de-identified peer score records may pass to the optional evaluator. The evaluator is independent of delivery acceptance, and no API key or external provider call is required by this workflow prototype.
