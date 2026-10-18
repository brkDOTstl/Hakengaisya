# Task-first execution and model routing

Version0.7 adds a rooted superior-subordinate tree alongside work dependencies. The responsible direct supervisor assigns and accepts each subordinate unit; real team-level deliveries then go upward to that supervisor's parent, with final acceptance at the root. Known and proposed worker contexts cannot cross reporting lines just to reduce cost. [The supervision contract](../plugins/hakengaisya/skills/company-workflow/references/supervision.md) defines the schema2 guarantees and historical-run boundary. The efficiency mechanisms below operate within these authority constraints.

Version0.6 compares bounded staffing alternatives, charges per-context startup once, keeps incomplete estimates explicitly unknown, and generates scoped dispatch/review contracts. Runtime uses the selected useful peak; next actions return a capacity-safe proposed dispatch batch. The host still launches models and verifies actual artifacts. [Research and adaptations](workflow-research-20261019.md) explains the source practices and transfer limits.

Version0.5 adds intake_triage before the Version0.4 deliverable planner. Its small native-model judgment classifies domain, type, difficulty, scope, risk and primary skill. Optional Jev uses the same fixed choices; access failure, timeout or uncertainty returns a native handoff. The classifier routes bounded work to adequate execution, complex/multiple work to the existing host for decomposition, and remaining uncertainty to one host judgment. It adds no management context or administrative packet. See [the intake contract](../plugins/hakengaisya/skills/company-workflow/references/intake-triage.md).

Planning follows goal/acceptance, deliverable graph, adequate routes, useful parallel schedule, then organization. Efficiency and cost of correct delivery are primary outcomes. Reference charts supply optional patterns, not mandatory departments. Classification is preliminary routing guidance, not worker capability evidence.

The Pomodoro trial had four actual contexts and one application producer. Role reuse still produced six administrative stages and repeated reviews. The new default no longer expands a brief into that reference workflow. Old trial artifacts and its frozen controller remain unchanged.

## Implemented behavior

- Units declare objective, type, difficulty, skills, inputs, outputs, acceptance and exact writes. Graph validation checks dependencies, artifact ownership, one integrated deliverable and audit sources.
- A one-unit timer creates one terminal packet and a checker. No separate scope/director/platform/report departments are appended.
- Route planning consumes permitted catalogs and evaluator-style profiles. Exact model/route/effort/task/difficulty/skill and supported required dimensions determine adequacy before cost comparison.
- Schedules respect dependencies, contexts, writes, pool/concurrency, bounded parallel-cost premium, estimated deadline and cheapest-remaining budget reserve.
- Unknown costs/times/overheads remain unknown; budget/deadline estimates cannot assume missing overhead is zero. Confirmed model failures exclude failed routes; environment stops do not imply poor ability.
- Runtime requires the planned binding declaration when provided, and renewed fit justification after rejection. Unpriced trials default to one attempt.
- State records and summaries are mechanical. Related ready checks can share one reviewer invocation without fabricating future observations.

Tests cover simple structure, cheap adequate work, stronger complex work, parallel integration, conflicts, aliases, pool limits, budgets/deadlines, unknown data, retries, independence, overhead and relocated packaged CLI. Numeric model/cost/duration examples are synthetic, not current prices or measured savings.

Runnable fixtures are examples/task-first/small-timer.json, mixed-parallel.json and fixture-workers.json. The small case creates one delivery unit. In the mixed synthetic example, routine and complex branches are assigned to separate adequate cost levels and start together; their integrated review waits for both. Its forecast is114 seconds versus146 seconds serialized, using fabricated durations and explicit overhead. This is algorithm behavior, not a real-project speedup result.

The planner is greedy advice and does not launch models or prove global optimality. Historical observations and declared overhead are estimates. Actual host model switching, provider billing, installed automatic invocation and physical isolation remain separate integration work. The optional Jev adapter sends only an explicitly permitted short intake summary; it imports no credentials or project assets and does not launch the native fallback itself. The host executes native calls. Default-model changes and publication are outside this change.

Read [the forms](../plugins/hakengaisya/skills/company-workflow/references/task-first.md), then use node scripts/workflow.mjs plan BRIEF.json WORKERS.json. Full-template execution now requires reference_workflow:true; ordinary execution requires work_items.
