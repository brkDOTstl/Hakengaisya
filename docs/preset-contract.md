# Workflow preset contract - v1

Status: the bounded-software v1 validator, registry, selection and expansion path are implemented in 0.8.8. The first preset covers one coherent delivery and two independent components with integration. Broader project families and organizations still need researched contracts and compiler extensions; existing role proposals and legacy reference templates do not automatically become complete presets.

A preset describes a reusable way to deliver a project family at an applicable scale. It combines researched operating practice, actual deliverables and superior-subordinate acceptance. Role count alone does not constitute a workflow. See [the roadmap](../ROADMAP.md) for coverage and release gates.

## Required content

The executable v1 shape is defined by `WorkflowPreset` and `validatePreset` in `lib/presets.ts`. The registry at `config/workflow-presets.json` contains safe preset IDs, resolved to `presets/<id>.json`. Unknown fields, missing source/review metadata, unsupported topologies, inflated worker counts, missing scales/correction paths and real-task claims are rejected. The validator checks declared structure; it does not certify source truth or the quality of natural-language acceptance criteria.

| Section | Required information |
| --- | --- |
| Identity and evidence | Stable ID/revision, project family, maturity, reviewed sources/dates, adoption decisions and transfer limits |
| Applicability | Supported outcomes, exclusions, project inputs, constraints and reasons for choosing this workflow |
| Deliverables | Observable outputs and acceptance, external inputs, dependencies, integration owner and terminal delivery |
| Organization | Real responsibilities, direct-superior chain, working-lead duties and own-work review boundaries |
| Stages | Entry conditions, work ownership, input/output artifacts, exit evidence and accepted downstream inputs |
| Review and correction | Direct-supervisor signoff, independent technical findings, failure attribution, return destination and affected-result invalidation |
| Scale overlays | Applicable micro/small/multi-stream/large forms, compatible responsibility merges, independence constraints and activation/expansion triggers |
| Model and tool needs | Required skills/difficulty, actual tool access, unavailable/human steps and contextual evidence needed before live assignment |
| Resource assumptions | Pool/concurrency limits, scope/budget constraints, measured or explicitly estimated startup/handoff/review overhead |
| Exception paths | Blocked tools, missing evidence, changed scope, bounded retries, interruption/recovery and final handover |
| Execution topology | Single-agency/native/router path or same-host buyer/supplier agencies; registered leads, declared capabilities, scoped artifacts, handoff/receipt states and buyer acceptance |
| Verification and use | Source-backed rationale, structural/simulation checks, example inputs, selection guidance and declared limitations |

## Execution semantics

1. Interpret the requested outcome and existing evidence before selecting a preset.
2. Choose a family and applicable scale from real deliverables, dependencies, risk, skill gaps and review load.
3. Apply compatible capability modules and responsibility combinations, preserving one accountable root and direct-supervisor authority.
4. Expand a draft work graph with explicit artifact interfaces, gates and correction routes.
5. Qualify actual model/tool routes and bind real contexts before execution. A named position is not a launched employee.
6. Execute through the existing local controller and inspect actual evidence before acceptance.

Stage names do not require separate workers, documents or model calls. A micro workflow may combine compatible planning, local design, implementation and developer checks into one coherent delivery. Its meaningful independent acceptance still belongs to the responsible superior.

Large workflows add a level or specialist only for a named integration, capability or review bottleneck. Scale overlays cannot bypass acceptance, merge QA into its producer or silently change a running context's reporting line. Phase changes and scope changes require a reviewed work graph and explicit state handling.

The implemented expansion path reuses [work-item forms](../plugins/hakengaisya/skills/company-workflow/references/task-first.md) and [supervision](../plugins/hakengaisya/skills/company-workflow/references/supervision.md). See [bounded software usage](bounded-software-preset.md). Organization proposals remain a separate aid for wider projects. The preset layer does not replace the controller, evaluator or host tool permissions.

For cross-client use, also follow [same-host coordination](multi-client-coordination.md). The buyer contracts with each supplier lead; supplier-internal acceptance is separate from buyer acceptance. Desktop/CLI labels do not substitute for capability checks. Router access inside one agency does not require an outsourcing layer. Transport acknowledgment, client completion and accepted project delivery remain separate states.

## Maturity and completion

- Research seed: a useful source or company example has been reviewed; the adaptation is incomplete.
- Organization proposal: roles/reporting can be composed, but no complete delivery workflow is claimed.
- Reference workflow: stages and artifact contracts exist, but project/scale adaptation and complete preset checks are missing.
- Structurally validated preset: the complete contract, applicable scale overlays and simulated positive/negative paths pass. This is the 0.8 target.
- Real-task validated preset: supported real model/tool execution and task acceptance have been observed. This belongs to 0.9 validation.

Record each level honestly. Human company practice informs the design; it does not prove agent quality, model eligibility, a future price or delivery time. Game art/audio, actual user research and player experience need their own real artifact/human evidence. The technical evaluator does not acquire aesthetic ground truth from these presets.
