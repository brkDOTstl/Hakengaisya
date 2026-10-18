# Task-first planning and run forms

Resolve the packaged helper at `../../../runtime/scripts/workflow.mjs` relative to this directory. Use absolute input/output/helper paths and the actual task workspace. The host AI writes internal English forms.

Start new intake with [the lightweight triage role](intake-triage.md). It routes bounded work directly or returns planning/uncertainty to the existing host. Attach a resolved intake_triage record when keeping its decision in a persisted run; no extra triage work packet is created.

Version0.7 also requires [superior-subordinate authority](supervision.md) for new task-graph runs. Work defaults to the root supervisor; optional reporting_lines and per-item supervisor_context express additional scoped levels. reviewer_context binds the direct supervisor. The controller checks reporting authority in addition to independent evidence review.

```text
node HELPER select BRIEF.json
node HELPER plan BRIEF.json WORKERS.json
node HELPER create RUN.json BRIEF.json
node HELPER next RUN.json
node HELPER dispatch RUN.json PACKET_ID
node HELPER review RUN.json PACKET_ID
node HELPER event RUN.json EVENT.json
```

## Work graph

```json
{
  "run_id": "timer-01",
  "objective": "Deliver a small usable local timer.",
  "domain": "software-engineering",
  "lead_context": "actual-host-context",
  "acceptance": ["Start, pause, resume and reset behave correctly."],
  "constraints": ["Keep the app small and local."],
  "work_items": [{
    "id": "timer",
    "objective": "Implement the timer and its developer checks.",
    "task_type": "implementation",
    "difficulty": "routine",
    "skills": ["implementation"],
    "depends_on": [],
    "inputs": ["task_brief"],
    "writes": ["app"],
    "outputs": ["timer_app", "developer_evidence"],
    "acceptance": ["Delivered controls match the requested behavior."]
  }]
}
```

This creates one delivery packet with a checker, not six administrative stages. Requirement interpretation, small design and environment inspection belong inside this unit. Parallel modules have separate outputs/writes and an integrated unit depending on required results. One integrated terminal deliverable is required. Input IDs come from prior outputs or external_inputs keys, mapped to local references.

Each unit supplies its own difficulty and skills. Optional required_tools names actual route capabilities. Required dimensions default to D1/D2/D6 and minimum_score to7; select dimensions appropriate to the work. audit_sources names prior units whose producer contexts cannot perform this independent audit.

## Route catalog

WORKERS.json is an array with id, exact model_id, route, effort (default unknown), optional actual context_id, available, tools_verified, tools and profiles. Profiles follow evaluator contextual fields: model_id, route, effort, evaluation_kind, domain, task_type, difficulty, skill, dimensions with score/support, observed_cost_usd and observed_wall_seconds. Only exact matching supported-peer-observations qualify, with known costs/durations for every required skill. Technical-product-design maps to the evaluator's technical-product domain.

The catalog is advice data, not authorization. Verify actual host permissions, provider availability and tools before a call. Aliases sharing context_id share capacity and cannot audit each other. Missing context_id denotes a proposed context slot; actual runtime binding still needs checking.

Optional planning_limits supplies max_parallel, max_workers (default max_parallel), budget_usd, deadline_seconds, parallel_cost_premium (default0.1), overhead_seconds and overhead_cost_usd per unit. context_startup_seconds and context_startup_cost_usd apply once per actual worker context, including aliases. Startup is conservatively included in its first work slot. Do not double count it if observed per-work measurements already include that cost; declare a justified zero only in that case, when measured negligible, or in labelled fixtures. Missing fields yield null complete total estimates; a budget/deadline needing them yields needs-evidence. Historical cost is not a current provider quote.

The planner compares pool caps from one to the permitted maximum (all caps through eight; a bounded geometric sample for larger pools). It prefers fewer adequate contexts unless a larger pool saves more than minimum_parallel_savings_seconds (default0), within the cheapest feasible total's parallel_cost_premium. Feasible deadlines can require a larger pool. staffing_comparison lists the alternatives and estimates_complete flag. Unknown overhead produces provisional comparisons, not a proved saving. The greedy search can miss feasible assignments and does not prove optimality.

The greedy planner reserves cheapest remaining cost, chooses adequate candidates within a bounded cost premium for earlier delivery, and checks estimated budget/deadline. It schedules dependencies, shared contexts, conflicting Windows writes and concurrency. It is not a global optimum proof. Inspect needs-evidence/constraints-unmet before execution. Decomposition warnings flag work smaller than its handoff overhead; consider merging genuinely coupled work.

Use evidence_kind simulation only for labelled synthetic planning. Simulated/public/historical profiles do not qualify live dispatch. Confirmed model failures can be supplied as failures entries with work_id, worker_id, attribution:model and confirmed:true; the failed route is excluded for that work. Environment attribution does not lower ability; unavailable tools/routes must be reflected in the catalog.

## Runtime binding

With workers embedded in BRIEF, create stores the plan and caps runtime concurrency at its useful peak rather than the graph's theoretical width. Assignment requires planned status and matching worker_id/model_id/route/effort declarations. Planned context slots bind consistently to actual owner contexts; preflighted context_id must match. Aliases are grouped as one actual context rather than several employees. This checks the requested binding, not actual provider execution/billing. No catalog means an unpriced host-default run, one attempt by default, and no optimized-cost claim.

next distinguishes dependency-ready work from a dispatchable batch that also fits current assignments, pool capacity, writes, owner identity and retry limits. This is a read-only snapshot, not a reservation. The host records start before launching each selected worker and refreshes state after changes. dispatch emits a scoped contract with only declared accepted inputs/external inputs, writes, expected outputs, checks, attempt and model binding. It excludes the global journal and unrelated context. review emits current submitted evidence and criteria, adding final user acceptance at the terminal boundary. Neither helper launches agents or reads/verifies artifact files; the host performs those checks. Call event with the current revision, not a stale dispatch revision after a start changes state.

Packet IDs are work_ID, except the terminal unit is handover. Assignments preserve exact declared writes and separate owner/reviewer contexts. Rejection requires renewed assignment and fit_reason before another attempt; blind restart of the old binding is blocked.

The original [event forms](run-commands.md#event-envelope-and-assignment) still apply. Preserve actual participant-dispatched attempts. Terminal accepted review supplies task_checks for every user criterion. Related ready checks may share one real reviewer invocation, each grounded in existing artifacts. Independent final acceptance does not need a second management/report department.

## Reference-only rehearsal

Software-delivery/product-design are reference libraries. Only a requested full-template rehearsal sets reference_workflow:true and uses legacy global difficulty/stream fields. Ordinary execution supplies work_items. The host coordinates without a new manager model just to fill a title.
