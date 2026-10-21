# Intake triage contract

The front door is intake_triage. It is a bounded classification role, not a new permanent supervisor. The host supplies a short objective, acceptance array and constraints array. Missing arrays default to empty for intake only; execution still needs observable acceptance. Keep these fields stable in the later brief so the input fingerprint remains valid.

The packaged helper is ../../../runtime/scripts/workflow.ts relative to this directory. Use absolute paths and the actual workspace. The host writes English internal forms; the user does not fill them.

```text
node HELPER triage-request INTAKE.json
node HELPER triage INTAKE.json RESPONSE.json
```

triage-request emits the short state, six atomic choice questions and input_fingerprint. Give that request to one permitted lightweight native model without inherited project history or tools. The caller supplies the exact fingerprint; the model returns answers with one choice and confidence for every question. The optional source is {kind:"native",model_id:ACTUAL_REPORTED_LABEL_OR_NULL}; labels describe execution, not authentication. Do not fabricate a reported model. The host can perform this short step itself if native selection is unavailable.

```json
{
  "input_fingerprint": "COPY_FROM_TRIAGE_REQUEST",
  "answers": {
    "domain": {"choice": "software-engineering", "confidence": 0.95},
    "task_type": {"choice": "implementation", "confidence": 0.95},
    "difficulty": {"choice": "routine", "confidence": 0.9},
    "scope": {"choice": "bounded", "confidence": 0.95},
    "risk": {"choice": "low", "confidence": 0.9},
    "primary_skill": {"choice": "implementation", "confidence": 0.95}
  }
}
```

This answer is an illustrative form, not observed model output. The deterministic helper validates all choices, finite confidence and the fingerprint, then emits:

- direct: one coherent routine/standard deliverable with ordinary risk. Return requirements to the responsible supervisor for adequate-employee selection. Local design and developer checks stay in the unit; the supervisor retains acceptance authority.
- plan: complex difficulty, multiple deliverables or elevated risk. The existing host makes a bounded plan and derives useful staffing. No fixed company size is implied.
- escalate: unknown fields or any confidence below 0.75. One host judgment resolves it or identifies a material question. The threshold is a conservative prototype rule, not demonstrated calibration.
- out-of-scope: the existing host handles work beyond the two active technical domains.

Attach the returned record as intake_triage in the work brief when persisting a run. The planner/controller recompute its decision and reject stale, unresolved, mismatched-domain or simulated-for-live input. Older briefs without a triage record remain readable and runnable; the updated skill starts new intake with triage. The primary skill is preliminary; work items refine all actual skills and tools. Triage is not proof of worker competence or authorization.

## Optional Jev

Jev can select fixed choices directly using the same six questions. This uses its typed-decision API rather than treating a retrieval relevance score as a skill score. References: [Choice](https://docs.typesafe.ai/primitives/choice), [API](https://api.typesafe.ai/docs). The existing Memory Shelf MCP searches imported evidence and is not an arbitrary-intake classifier.

```text
node HELPER triage-jev APPROVED_INTAKE.json JEV_OPTIONS.json
```

Options are {"enabled":true,"allow_external_summary":true,"model":"jev-latest","timeout_ms":2000}. Supply TYPESAFE_API_KEY in the caller's environment, never the options file. Select a model permitted by the account. The request goes to https://api.typesafe.ai/v1/systemone and sends only the normalized objective/acceptance/constraints and fixed questions. Other brief fields, work graphs, assets and source files are omitted. The host must first ensure that this exact summary is permitted for that external destination; enabling the option is not a privacy detector. No historical credentials are imported automatically.

The adapter makes at most one request, refuses redirects, bounds the wait to at most five seconds, and redacts error bodies. Success returns {status:"classified",result:TRIAGE_RECORD}. Missing access, failure or uncertain classification returns {status:"native-fallback-required",reason:CODE,request:NATIVE_REQUEST}. That is a handoff for the host, not a background native launch. Run one native classification and finishTriage; do not repeat Jev or chain increasingly expensive classifiers. Model execution remains the native host's responsibility.

The local controller and skill do not install themselves, authenticate providers or prove automatic invocation. The adapter contract can be tested offline; a live call, its actual cost and routing accuracy are separate evidence.
