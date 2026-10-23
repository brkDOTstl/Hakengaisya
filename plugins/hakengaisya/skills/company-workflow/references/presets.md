# Executable bounded-software presets

Use this path for a small software tool, script, localized change or bug fix with routine operational risk. Perform intake and identify coherent deliverables first. The host fills forms from the task; users supply goals and material constraints, not internal JSON.

Use MCP presets_list/preset_inspect/preset_select/preset_expand (with the hakengaisya_ prefix), or node HELPER presets, preset-inspect ID, preset-select REQUEST.json and preset-expand ID REQUEST.json. HELPER is runtime/scripts/workflow.ts inside the plugin. The runtime also includes examples/presets/micro.json and examples/presets/small-parallel.json. preset_validate checks a supplied definition structurally; it cannot certify its source claims or observations.

Request fields:

- run_id, objective, lead_context, observable final acceptance, constraints and components are required.
- Set family:bounded-software, outcome to small-tool/script/localized-change/bug-fix, and the actual risk. Only routine risk is supported by this preset.
- A component has id, objective, task_type, difficulty, skills, exact workspace-relative writes, outputs and observable acceptance; add inputs/required_tools as needed. Do not include dependency, audit or supervisor fields; expansion supplies the authority and work graph.
- One coherent component selects micro. Two components require a parallel_reason and integration with the same component fields. Components need disjoint writes and independent accepted/external inputs. Integration consumes all component outputs and reuses a qualified existing owner.
- Optional fields include workers, planning_limits, tighter limits, external_inputs, existing_assets, current intake_triage, DEI and explicitly enabled improvement. Preserve user limits and actual evidence kinds.

Micro has one execution owner plus the existing supervisor. Small-parallel permits at most two current execution owners; it does not require opening two contexts if one adequate owner is cheaper or the host limits concurrency. Planning, implementation, developer checks and handover can remain one coherent job. Stages are duties, not extra employees. No UI/design department is added unless the requested work actually needs those outputs.

Inspect the returned selection, staffing rationale and dispatch_readiness. no-match means revise the scope/decomposition or use another reviewed workflow; do not force the preset. A draft creates no run or model call. Give only its brief member to create_run. The controller persists preset revision/hash and the actual work/limits. Follow ordinary assignment, dispatch, submission and direct-supervisor review. A separate integration context that exceeds max_workers is rejected.

With route data, respect the planner's qualification and any explicit trial flag. Without it, verify the actual host model and tools; cost stays unproven. Hard budget/deadline work requires route and overhead evidence before assignment. Unknown data cannot prove the limit.

Read exception_paths in the expansion. Missing tools and uncertain execution block work. Resume only the identified existing instance, or reopen after confirming it stopped. Review failure preserves history and reopens affected descendants; renew ability-fit assignment before correction. An unpriced host binding can be replaced inside the current pool; a fixed planned-route change needs a supervisor-reviewed replacement plan/run with prior evidence retained. Structural/acceptance changes require a revised brief; do not silently mutate the current contract. Stop at the retry ceiling.

The root supervisor checks every terminal user criterion; accepted component artifacts do not accept integration. Preserve failed/unverified evidence and distinguish model, environment and specification causes. Optional evaluator records must stay de-identified and honest about simulation. The preset's first validation is structural/simulated, not proof of live host invocation, model quality or cost savings.

When integration evidence identifies a component defect, reject the current integration and explicitly reopen the producing component. Its owner corrects it within its own scope; integration stays dependency-blocked until that correction is accepted. Preserve unaffected accepted components and both review histories.
