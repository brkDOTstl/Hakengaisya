---
name: company-workflow
description: Organize technical work with explicit superior-subordinate reporting, delegated scope and upward acceptance; match ability and cost within that hierarchy. Use for software or technical product work benefiting from governed delegation, or when the user requests Hakengaisya. Scale the hierarchy to the actual work.
---

# Hakengaisya task-first workflow

Optimize time to a correct result and total execution cost. Start with a short intake triage, using the requested result, acceptance and constraints. Derive work and dependencies before assigning people or choosing an organization. Company templates are reference examples, not stages that every task must traverse.

## Reporting and acceptance are structural

Each subordinate reports to one direct supervisor. That supervisor owns the assigned scope, dispatch, acceptance and return for correction. The work dependency graph controls readiness; the reporting tree controls authority. Define both. Cost and speed optimizations preserve these authority constraints. A small task can use the existing host as supervisor and one or two employees; larger tasks can need team leads that deliver integrated results to their own parent.

Read [the supervision contract](references/supervision.md) when binding a run. Each work item names its responsible supervisor; ordinary defaults use the root host. Subordinates submit upward. The direct supervisor checks evidence and accepts or rejects their work; another peer or a higher-level manager does not silently replace this signoff. A lead then submits its own real deliverable to its parent. Accepted child work alone never accepts the parent delivery. The root supervisor signs final user acceptance.

A separate QA agent or specialist can supply technical findings as evidence. It does not gain signoff authority over peers. Supervisors must be competent for the review, and any producer contribution prevents that context from independently accepting its own work. Escalation gives ancestors visibility and corrective control without silently changing reporting lines or bypassing required gates. The host remains the single state writer; recorded actors identify the actual participant whose decision is being applied.

Read [task planning and forms](references/task-first.md) to create a persisted work graph or route plan. The host fills internal forms; users provide goals and constraints. The evaluator is optional and independently usable.

## Compose a project-sized organization

For a new project, select capability modules from actual deliverables and constraints, then use organize PROJECT.json [PHASE] to validate a role proposal. Read [composition forms](references/organization-composition.md) when doing so. Combine compatible production responsibilities where ability and workload permit; preserve the root and upward acceptance. Working leads produce real outputs, and their own production is checked by their parent with independent technical findings where needed.

Keep logical positions, actual employee/model bindings and concurrently running agents separate. Activate specialist positions by phase or bottleneck; do not keep them running to fill an organization chart. Phase proposals do not change a running hierarchy. Unknown cost, skill/tool availability and workload remain unknown. Game-art/audio slots need actual artifact tools and qualified review; they do not extend the technical evaluator into automatic aesthetic scoring or prove player enjoyment.

## Coordinate registered client agencies

For explicitly configured same-host outsourcing, one buyer lead contracts with supplier leads, each of which controls its own local hierarchy and model/tool pool. Use federation-plan and the bounded handoff/receipt helpers; read [the client-agency contract](references/multi-client.md). Supplier completion produces a submission for buyer review, not buyer acceptance. Scope and interface changes go through the buyer. Preserve global and local client limits, immutable attempts, current artifact evidence and uncertain-execution stops.

Choose connections from actual capabilities: native task tool, supported CLI adapter, inbox pull or an approved Desktop wake/UI adapter. A surface label does not prove an invocation API exists or is absent. The 0.8.2 mailbox is a local contract/control prototype; it does not connect real clients, start schedulers or grant permission to message another conversation. When one router-capable agency can perform the work adequately, use its direct permitted model routes without adding a supplier agency. Keep all subcontract contents separate from evaluator uploads.

## Triage before dispatch

The intake_triage role classifies domain, work type, difficulty, scope, risk and primary skill. It returns bounded work to its responsible supervisor for one adequate employee, larger work to host planning, or uncertainty to one host judgment. Classification does not confer dispatch or signoff authority. It performs no implementation, detailed decomposition, staff evaluation or acceptance review and adds no management layer.

Use one short call to the smallest/fastest permitted adequate host-native model, with just the intake and fixed questions. Choose from actual available native models; do not assume a price, invent an identity or change the user's global model. If the host cannot select or launch a lightweight model, make the same brief judgment in the existing host. Do not start an external LLM or another Codex CLI. Reuse a valid triage for unchanged input; reassess when the goal, acceptance or constraints change.

An explicitly configured Jev route can answer the fixed choices in one bounded request. Missing access, timeout, invalid output or uncertainty falls back once to native triage. If native triage is still uncertain, return to the existing host without another classifier loop; ask the user only for material missing facts. Jev relevance/confidence never becomes employee ability evidence. Keep private project material local and send only an approved short task summary to the configured external service.

Read [intake contract and commands](references/intake-triage.md) when recording triage or using Jev. Pass the requirements to the existing adequate-route planner. Direct intake still needs a verified capable worker and meaningful result checks. Complex work can need one specialist; multiple deliverables need dependency planning, not automatic departments. The triage role never selects a large organization or overrides tool/cost/ability checks.

## Decompose work before staffing

- Keep requirement interpretation, local design, environment checks and code together when they are one person's bounded continuous work. Do not create managers or independent documents for those labels.
- Split at actual deliverables with clear inputs, outputs, acceptance and file ownership. Parallel work needs independent accepted inputs and disjoint writes. A chain of tightly coupled tasks gains no parallelism from more titles.
- Include real integration work when separate outputs must become one product. The responsible supervisor may batch related ready checks in one bounded call; each acceptance still belongs to that supervisor and the correct delivery boundary.
- Derive workers and any coordinator from actual parallelism and dependencies. The existing host normally coordinates. Add a management context only when it resolves a named bottleneck with a credible net benefit.
- A small timer may be one delivery unit and one checker. Task difficulty determines required ability; it does not by itself create management layers.

Use [small staffing patterns](references/staffing-patterns.md) when deciding between a coherent owner, parallel delivery cells or a temporary specialist. Treat these as work relationships, not mandatory titles. Name the helper's concrete output and exit condition before adding it.

Product exploration may deliver a hypothesis/evidence-gap inventory without observed user findings. If the requested outcome needs validated needs or actual user testing, missing real evidence stays a blocker. Software and technical product work remain the initial scope.

## Match ability, route, cost and time

For each unit, name its technical type, difficulty, skills and actual required tools. Use permitted routes with relevant supported local profiles. Routine success does not qualify complex work; public benchmarks and simulations do not qualify live dispatch. Check actual tool access per context, including browser access, instead of assuming inheritance.

Use the planner's adequate-route shortlist. Prefer lower observed work cost, permit a configured small premium for useful parallelism, and consider a faster adequate route when an estimated deadline requires it and the budget permits it. Confirmed ability failures need reassessment. An appropriate environment stop is not poor model skill.

Compare the planner's staffing alternatives before opening more contexts. Include per-unit handoff/review overhead and one-time context startup separately, without double counting historical observations. Keep the smaller adequate pool unless extra capacity gives useful time savings within the whole-task cost premium or is needed for a feasible deadline. Missing startup estimates stay unknown. Do not claim optimized savings from an incomplete estimate.

Unknown ability, cost, duration, or review/handoff overhead stays unknown. The planner reports missing evidence or unmet constraints. Without route data, a bounded host-default trial may proceed, but do not call it optimized or assume a native subagent is cheap. Respect host model-selection permissions and availability; never invent model identity or silently override defaults.

## Consider all permitted model families

Supply the user's permitted route inventory without silently narrowing it to the current model's family. The planner is family-neutral; inspect routing_audit for selected, adequate-but-unselected and excluded candidates. Separate missing host/provider connectivity from a scheduler's selection. An optional declared model_family is metadata, not an ability score or a ranking preference.

An explicitly enabled DEI policy requires every selected model to contribute actual contracted work. Read [the participation contract](references/model-participation.md). It is off by default and grants no extra permission, budget, provider access or concurrency. Do not add ceremonial tasks or count planned assignments as execution. Completed omissions automatically give the root manager one DEI point and dei-non-compliant in the local Agent Review; keep this separate from technical skill dimensions and evaluator uploads.

## Execute with bounded control

1. Use next's dispatchable batch, then the dispatch helper for each selected packet. It provides current task inputs, outputs, checks, writes, dispatched attempt and binding. Pass only needed material; do not forward the global journal or unrelated history. The snapshot reserves capacity only in its proposed batch; the host records start before launch and replans readiness after state changes.
2. Prefer authorized native subagents within one host. Genuine cross-client outsourcing uses an explicitly registered recipient and verified host adapter; do not launch another CLI/provider merely to imitate a native worker or bypass host/account permissions. Respect global and supplier-local pool limits.
3. Run independent ready work in parallel where ownership and capacity permit. Reuse contexts for compatible sequential work. Workers return results; the host alone writes run state.
4. Inspect real artifacts and behavior. A completion message is a submission to the responsible supervisor. Use the review helper for current results and criteria. The supervisor differs from every producer and signs its own subordinate scope. QA findings support that decision. Batch related checks without inventing observations or cross-team signoff authority.
5. Preserve rejected attempts and unaffected valid evidence. Reopen affected work, discard stale results, and renew ability-fit assignment before correction. Unpriced trials default to one attempt. Stop at the configured limit with the concrete unresolved issue.
6. Integrate and check all user criteria at the terminal gate. Generate state logs and summaries with code. Reserve AI output for substantive decisions, findings and useful handoffs.

The graph creates only actual work packets. Supervisory levels exist where their scope requires them; no ceremonial departments are appended. A terminal packet uses the internal handover identifier and the root supervisor checks final user acceptance there. Full-template execution requires explicit reference_workflow:true for a requested rehearsal; it is not the ordinary default.

## Evidence and efficiency

Record actual model binding, calls when exposed, waits, useful work, correction rounds and observed quality/cost. Do not attribute wall-clock gaps to model speed without telemetry. Forecasts use historical task observations; they do not prove a future bill, global-optimal schedule or measured speedup.

The helper checks dependencies, declared write conflicts, contexts/attempts and gates. The host launches permitted models, inspects evidence and enforces filesystem permissions. Model labels do not authenticate execution. Installing the skill does not prove automatic invocation.

After observed peer work, use the independent recorder if configured, sending only its permitted de-identified summary. Never upload work graphs, code or raw transcripts. Evaluator availability is not a product delivery gate.
