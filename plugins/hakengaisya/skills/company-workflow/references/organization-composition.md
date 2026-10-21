# Organization proposal forms

Use the packaged helper ../../../runtime/scripts/workflow.ts and absolute project-file paths. organize PROJECT.json [PHASE] reads the bundled capability catalog and returns an unbound organization proposal. It launches no agents and does not modify a run.

A project supplies id, objective, max_positions, max_active_agents, core_modules and optional_modules. Optional phases have unique id, approved modules and observable exit_criteria. A reference calendar can supply reference_duration_months and phase.months:[FIRST,LAST]; this describes human planning, not model runtime.

Optional merge_positions:[{from:POSITION,into:POSITION}] combines compatible active non-root responsibilities, skills and deliverables. A child can merge into its working lead or into a sibling under the same superior; unrelated branches and root merges are rejected. Work graphs and real contexts must be rebuilt and reviewed before applying any changed authority structure.

position_overrides on the project or phase may replace title, functions, deliverables or skills of approved roles; it cannot change authority or evidence requirements. Optional independent_of position identifiers prohibit collapsing an independent check into its producer. Merges preserve all original evidence_requirements. Actual context bindings must enforce this independence too.

The initial catalog includes core, software, gameplay, game-design, visual-direction, visual-production, quality-release, audio and release-support. New project families can add capability modules as data with requires and positions. Every position supplies id, title, reports_to, functions, deliverables, skills and evidence_mode. Each final position has one parent except the accountable root.

The bundled indie reference uses seven core positions; the small-tool reference uses two. Examples live under examples/organizations in the source repository. Use the known goal and production needs to select modules rather than inferring an entire department chart from the project-type name. The host must refine real scope, work dependencies, acceptance and model/tool fit before starting execution.
