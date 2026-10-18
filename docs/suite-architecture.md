# Hakengaisya suite boundary

Version0.7 preserves explicit superior-subordinate reporting and upward acceptance inside Hakengaisya. Each responsible supervisor owns dispatch and acceptance of its scoped subordinate work; integrated deliveries move upward to the root supervisor. The separate evaluator supplies contextual skill observations and never replaces a supervisor's delivery acceptance. See [the supervision contract](../plugins/hakengaisya/skills/company-workflow/references/supervision.md).

Version0.5 adds [intake triage](../plugins/hakengaisya/skills/company-workflow/references/intake-triage.md) ahead of the task-first planner. Staffing follows deliverable work and dependencies, prioritizing correct delivery time and cost. The optional Jev classifier and native fallback belong to Hakengaisya; employee skill evaluation remains independent.

## Independent evaluator recorder

Hakengaisya-evaluator is the independently installable skill-feedback component. A host AI fills a small record through `record_evaluation`; the local recorder saves, signs, and uploads it, and the backend aggregates scores and task-fit tags. This first version needs no additional grading model, polling agent, or complicated user-operated workflow.

The recorder can be installed in Codex without the company workflow plugin. It can also be adapted to another host. It does not assign implementation workers, control a project, or claim that the final product passed acceptance.

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

## Optional connection

The company workflow can read the evaluator's capability and cost API when making assignments. Participants can record their peer observations through the independent recorder after work. Evaluation transport is advisory and must not become a required delivery gate: an offline evaluation service does not block implementation or invalidate actual test results.

The software and technical-product templates remain the active initial phase. Education remains deferred. Version 0.3 includes the company skill and a persisted local run controller. It validates scheduling and acceptance transitions, while the native host executes agents and inspects evidence. Installation of the evaluator recorder does not install the company plugin or establish company workflow execution. See [the controller boundary](workflow-architecture.md).
