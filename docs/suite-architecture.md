# Hakengaisya suite boundary

Version0.7 preserves explicit superior-subordinate reporting and upward acceptance inside Hakengaisya. Each responsible supervisor owns dispatch and acceptance of its scoped subordinate work; integrated deliveries move upward to the root supervisor. The separate evaluator supplies contextual skill observations and never replaces a supervisor's delivery acceptance. See [the supervision contract](../plugins/hakengaisya/skills/company-workflow/references/supervision.md).

Version0.5 adds [intake triage](../plugins/hakengaisya/skills/company-workflow/references/intake-triage.md) ahead of the task-first planner. Staffing follows deliverable work and dependencies, prioritizing correct delivery time and cost. The optional Jev classifier and native fallback belong to Hakengaisya; employee skill evaluation remains independent.

## Independent evaluator recorder

Hakengaisya-evaluator is the independently installable skill-feedback component. A host AI fills a small record through `record_evaluation`; the local recorder saves, signs, and uploads it, and the backend aggregates scores and task-fit tags. This first version needs no additional grading model, polling agent, or complicated user-operated workflow.

The recorder can be installed in Codex without the company workflow plugin. It can also be adapted to another host. It does not assign implementation workers, control a project, or claim that the final product passed acceptance.

The evaluator is also the home of [custom workload benchmarking](../packages/evaluator/docs/custom-benchmarks.md). Real-work reviews and controlled task comparisons answer the same model-fit question with different evidence. Its first local benchmark slice freezes curated task/rubric/candidate versions, receives host-bound attempts, grades structured outputs and compares quality/cost/time. Raw tasks/results use a separate local benchmark database; they are not uploaded as peer reports. Benchmark creation, subjective judging/calibration, sufficient-sample qualification and integration into staffing remain staged work. The company CLI/MCP delegates benchmark operations to this evaluator module rather than creating another evaluation service.

## Company workflow plugin

Hakengaisya itself is the company-structure workflow component. It adapts the calling concepts explored in oh-my-openagent into explicit responsibility, delegation, dependency, audit, and delivery rules. Its purpose is an organized execution process with accountable handoffs.

The initial workflow is:

1. Capture the goal, constraints and observable acceptance, then run a brief intake_triage judgment.
2. Route a bounded deliverable directly to adequate execution, or have the existing host resolve uncertainty and plan real work. No fixed company chart is selected by the classifier.
3. When decomposition is useful, define deliverable packets, dependencies and checks, then derive the smallest staffing structure. Reference templates are optional patterns.
4. Assign an adequate model using contextual skill evidence and known cost/speed, then execute ready work.
5. Monitor results, blockers, changed assumptions, and budgets; route corrections to the responsible owner.
6. Have an independent reviewer audit required behavior and the supporting evidence.
7. Integrate accepted work, verify the complete result, and deliver it with evidence and explicit limitations.

Delegation follows authority rules. Execution order follows task dependencies. Review rejection reopens the responsible work and invalidates affected downstream claims. A model saying it finished is not sufficient evidence that the packet or the integrated product meets acceptance.

Company topology, task contracts, state transitions, budget decisions, independent review, and final integration are separate from the number of workers launched. The workflow can use one worker for a small task or several teams for a larger task while applying the same ownership and acceptance rules.

## Integrated connection

The integrated entry point joins an explicit host inventory with loopback evaluator profiles, historical references and separately labeled public trial evidence before a run is created. Reviewed outcomes can be retained locally and submitted to a matching configured evaluator identity; API-equivalent cost observations are separate from billing and capability scores. The optional Harness2 driver supplies bounded host requests and only registered, accepted, scope-matched experience can enter a later advisory dispatch. These modules retain their distinct contracts and data. When evaluation is unavailable, the integrated path reports missing research/evidence rather than silently inheriting a model; user-authorized sourced trials remain possible.

The software and technical-product templates remain the active initial phase. Education remains deferred. Version 0.3 includes the company skill and a persisted local run controller. It validates scheduling and acceptance transitions, while the native host executes agents and inspects evidence. Installation of the evaluator recorder does not install the company plugin or establish company workflow execution. See [the controller boundary](workflow-architecture.md).
