# Hakengaisya roadmap

Updated: 2026-10-21. Current suite version: **0.8.5**. Current milestone: **complete researched workflow presets, scale variants and same-host agency coordination**.

Hakengaisya should organize real work through an explicit superior-subordinate responsibility chain, finish independent work in useful parallel batches, and select adequate model/tool combinations without wasting cost. The evaluator supplies contextual skill observations; each responsible supervisor retains delivery acceptance.

## Release sequence

| Series | Purpose | Condition for leaving the series |
| --- | --- | --- |
| **0.8.x - current** | Research company practices; complete the main workflow presets, scale variants and their execution contracts | The 0.8 exit checklist below is satisfied across the required preset baseline |
| **0.9.x - later** | Run real tasks through those presets, measure quality/time/cost and optimize observed failures | Real-task evidence, acceptance and operational readiness meet the 0.9 exit checklist |
| **1.0 - after validation** | Release the tested framework for its declared supported scope | Verified workflows, usable setup, clear limitations and reproducible acceptance evidence |

Stay on 0.8.x until preset completion. Patch numbers identify delivered increments, not a deadline for the next milestone. Component versions such as Hakengaisya-evaluator 0.2.1 remain independent of the suite milestone. The repository [development rules](AGENTS.md) carry this release constraint; the checklists are not automated attestations of completion.

## What exists now

| Area | Implemented evidence | Remaining boundary |
| --- | --- | --- |
| Task-first planning | Deliverable graphs, skill/route matching, budget/deadline estimates, startup overhead and pool comparison | Decomposition quality and real cost/latency still need field evidence |
| Hierarchical control | Rooted reporting lines, scoped assignment, direct-supervisor acceptance, upward integration and correction history | Actual host context identity and physical permissions are supplied by the host |
| Intake triage | Bounded native-model contract and optional Jev adapter with fallback | Live Jev triage and reliable automatic host invocation are not established |
| Organization composition | Capability modules, role hats, responsibility merges, phase activation and independent-QA constraints | Outputs are unbound organization proposals, not complete company workflow presets |
| Same-host agency coordination | Subcontract brief compilation, immutable local mailbox, one-claim semantics, receipt validation and buyer-only acceptance | Synthetic control/transport tests only; actual client launch, Desktop wake and per-client capacity adapters remain unconnected |
| Existing examples | Small-tool organization and indie-game organization; older software/product reference templates | No project family yet satisfies the complete preset contract across its scale variants |
| Employee evaluator | Independent recorder/API, signed local HTTP, offline retry, task/skill profiles, ranking and model details | Peer scores are observations, not verified ground truth or proof of AI authorship; hosted operation is separate |
| Model participation and management review | Opt-in DEI roster coverage, evidence-backed submission accounting, automatic manager score/tag and a complete supplied-route candidate audit | Host-declared model identities are not authenticated; no live cross-family client execution or hosted management-review endpoint is claimed |
| Host transport | Shared command table behind the CLI and a stdio MCP server in the workflow plugin; atomic event batches, inspectable lock metadata and journal timestamps | Tool availability in an installed host is not automatic invocation; the server persists state and never launches models or inspects artifacts |
| Public source and checks | MIT suite, both plugins, executable tests and Windows/Linux CI | Passing structural or synthetic tests does not establish real-task completion or measured savings |

The earlier Pomodoro trial was real and exposed excessive coordination overhead. It does not validate the newer hierarchy/composition system as a full real-game or multi-project workflow.

## Current work and immediate order

| ID | Status | Deliverable |
| --- | --- | --- |
| P01 | Done in 0.8.1 | Record the 0.8 / 0.9 / 1.0 sequence, current gaps and completion gates |
| P02 | In progress - specification draft | Establish one complete [preset contract](docs/preset-contract.md); add executable validation next |
| P03 | In progress - research seeds only | Build a source/adaptation record for each required project family; see [research notes](docs/preset-research.md) |
| P04 | Next | Add a preset registry and list/inspect/expand path that produces a draft work graph and reporting plan |
| P05 | Planned | Complete bounded software work and web/service delivery presets, including small and multi-stream variants |
| P06 | Planned | Complete technical-product and indie-game workflows beyond their current role/reference examples |
| P07 | Planned | Complete desktop/client, data/database, AI integration and maintenance/investigation families |
| P08 | Planned | Connect scale overlays, stage activation and handoff/rework rules without silently changing a running hierarchy |
| P09 | Planned | Verify every required family/scale combination structurally, including rejected work, missing evidence and blocked tools |
| P10 | Planned | Complete usage guides, realistic de-identified examples, known limitations and the final 0.8 coverage review |
| D01 | Implemented in 0.8.3 - structural/synthetic checks | [Optional DEI participation and family-neutral route review](docs/model-participation.md); keep ordinary cost/ability planning as the default |
| H02 | Implemented in 0.8.5 - synthetic benchmark and regression tests | Copy-on-write events, single-pass route preparation, unified write-scope normalization, template-declared audits, Biome formatting and lint in CI; controller speed is measured on synthetic graphs only, not on real model runs |
| H01 | Implemented in 0.8.4 - stdio round-trip tests | [MCP workflow tools, atomic event batches and lock metadata](plugins/hakengaisya/skills/company-workflow/references/run-commands.md) to cut per-transition host overhead; invocation in a fresh installed host remains unverified |

The user added same-host multi-client agency coordination to the 0.8 scope. Track it alongside the preset contract and research without dropping the existing required families. Each finished increment updates this table and links its actual artifact/check evidence.

## Same-host multi-client workstream - required in 0.8

| ID | Status | Deliverable |
| --- | --- | --- |
| F01 | Draft contract and structural prototype in 0.8.2 | [Buyer/supplier operating structure](docs/multi-client-coordination.md), client capabilities and independent supplier hierarchies |
| F02 | Local transport/control simulation implemented in 0.8.2 | Bounded immutable inbox/outbox/claim records, attempt-bound receipts and buyer review; separate fixture process is not a real AI client |
| F03 | Pending | Register and connect an actual same-host CLI adapter with model/tool access, capacity and process/status capture |
| F04 | Pending | Register and connect a supported Desktop native-tool or scheduled/UI wake/check adapter |
| F05 | Pending | Complete supported Desktop/Desktop, CLI/CLI and both mixed-direction contracts, recovery and documentation; preserve the direct router path |

The first target is several clients on one computer. Cross-machine coordination is deferred. No scheduler, GUI automation, other conversation or external model is started just by declaring this feature. A router-capable agency can keep ordinary model calls internal and outsource only when the project warrants it.

## Required preset baseline for 0.8

This is the initial baseline within the suite's technical/product scope, not a claim to cover every industry. Record additions, exclusions or inapplicable scale variants explicitly instead of silently reducing coverage to reach 0.9.

| Family | Representative work | Current material | Missing before preset completion |
| --- | --- | --- | --- |
| Bounded technical task | Small tool, script, localized implementation or defect correction | Small-software organization and task-graph controls | Complete compact workflow, correction/acceptance rules and explicit expansion triggers |
| Web application / backend service | Frontend/backend delivery and integrated release | Software-delivery reference and technical runtime | Source-backed project workflows, applicable scale overlays and integration/release evidence contracts |
| Desktop / mobile client tool | Host integration, UI, packaging and target-device behavior | General technical controls only | Company/process research, platform/tool prerequisites, device checks and release/handoff workflow |
| Technical product discovery / design | Problem framing, evidence, prototype and validated requirements | Product-design reference | Runnable preset contract, actual research/validation boundaries and scale-specific ownership |
| Independent game | Prototype, representative slice, content production, stabilization and release | Seven-position organization, five-position merge and phase examples | Work graphs, cross-discipline handoffs, real artifact/playtest gates and explicit human/tool dependencies |
| Data / database work | Data investigation, pipeline, migration, quality checks and delivery | Initial research seeds only | Context-specific workflows, ownership, data-access boundaries, rollback and acceptance contracts |
| AI / model integration | Model/tool adapters, evaluation, retrieval or agent-service integration | Evaluator and Jev component examples | General project preset, capability/readiness checks, reproducible evaluation and release criteria |
| Maintenance / technical investigation | Diagnosis, legacy inspection, bounded reverse engineering and incident correction | Generic retry/block controls | Evidence-first investigation flow, supported scope, correction ownership and restoration/acceptance checks |

Education and standalone artistic production remain deferred. A game preset may name art/audio/human-review requirements, but this does not enable automatic aesthetic scoring in the technical evaluator. Unknown capabilities and unavailable adapters must stay explicit.

## Scale coverage

| Variant | Structural intent | What the preset must explain |
| --- | --- | --- |
| Micro / bounded | Existing supervisor plus a coherent qualified owner; add independent technical checking when needed | Which responsibilities can combine, meaningful acceptance and when to expand |
| Small project | Working lead(s), a few producers and appropriate independent checks | File/artifact boundaries, upward acceptance, limited specialist use and useful parallelism |
| Multi-stream / medium | Several delivery cells with bounded superior scopes and explicit integration ownership | Inter-cell interfaces, shared services, reviewer capacity and phase transitions |
| Large / multi-team | Additional scoped subteams only when independent streams and review load justify them | Hierarchy, integration gates, cross-team contracts and evidence that the design is structurally coherent |

These are work patterns, not fixed headcount promises. Each family needs all applicable variants, or a documented reason why a variant is outside its supported scope. Logical positions, real model contexts and concurrent agent calls remain separate. Large structural simulations are not evidence that a large live organization is ready.

## Definition of a complete 0.8 preset

- [ ] Applicability, exclusions, project inputs and expected deliverables are explicit.
- [ ] Company/practitioner sources are cited with review dates, adoption decisions and transfer limits.
- [ ] The preset produces a usable draft work graph, not only a role chart.
- [ ] Every delivery unit has required inputs/outputs, a responsible superior, acceptance evidence and a correction destination.
- [ ] Parent-level integration requires its own evidence; child acceptance does not automatically accept the parent delivery.
- [ ] Phase gates, scope changes, blocked tools, missing evidence, bounded retries and handover are defined.
- [ ] Applicable scale variants explain role combinations, working leads, independence and expansion/reduction triggers.
- [ ] Model/tool qualification and startup/handoff/review cost assumptions remain explicit; missing data is not zero.
- [ ] Technical, human and external-provider steps are identified without invented observations or implicit external authorization.
- [ ] Structural checks and simulated successful/failing paths pass for the supported variants.
- [ ] A reader can choose and inspect the preset, understand its limits and reproduce its documented example.
- [ ] Applicable same-host supplier handoffs identify the buyer, supplier lead, client capacity, scoped artifacts, wake/delivery method and buyer acceptance; direct single-agency/router use remains available.

These boxes define each preset's contract. They do not state that the whole library is complete.

## Gate from 0.8 to 0.9

- [ ] P02-P10 are complete with linked artifacts and checks.
- [ ] F01-F05 have the declared same-host adapter/coordination contracts and implementation required for the supported client scope; unconnected paths remain explicit blockers.
- [ ] Every required family has a complete preset and applicable scale coverage, or an explicitly recorded scope decision.
- [ ] Preset selection/expansion preserves deliverable dependencies and superior-subordinate authority.
- [ ] Cross-preset structural tests, negative paths, clean-checkout build, documentation and privacy checks pass.
- [ ] The real-task test matrix, baseline comparisons, measurement format and supported host/tool scope are ready.

**Current gate status: not met. Remain on 0.8.x.** Real-task trials can reveal issues earlier, but they do not justify skipping preset completion.

## 0.9 real-task validation and optimization

- [ ] Exercise representative real tasks and applicable scales using the completed presets.
- [ ] Verify actual native model/tool invocation and actual context/reporting bindings in the supported host.
- [ ] Verify actual same-host Desktop/Desktop, CLI/CLI, Desktop-buyer/CLI-supplier and CLI-buyer/Desktop-supplier flows where claimed, including unavailable clients, stale/duplicate replies and uncertain execution.
- [ ] Trace complete task delivery, supervisor rejection/correction, missing capability, interruption/recovery and final acceptance.
- [ ] Compare suitable direct/smaller-team baselines with the same acceptance criteria; record observed cost, latency, startup, waits, handoff and rework. Preserve unknown measurements.
- [ ] Establish de-identified evaluator recording, deduplication, queue/retry and useful contextual feedback without polluting live evidence with simulations.
- [ ] Revise presets and routing from observed outcomes, repeat the affected checks and preserve failed attempts.
- [ ] Document coverage, reproducibility and unresolved limitations; passing a synthetic test is not a completed real-task case.

## Gate from 0.9 to 1.0

- [ ] Representative supported workflows meet real task and user acceptance criteria.
- [ ] Important failure/recovery paths are demonstrated and release-blocking defects are resolved.
- [ ] Efficiency/cost claims are backed by comparable measurements and do not hide quality or rework costs.
- [ ] Installation, first-use setup, examples and error guidance work in the declared supported host/version scope.
- [ ] Model/tool limitations, privacy requirements, evidence semantics and operational controls are clear.
- [ ] Code, presets, documentation and release checks are consistent and reproducible.

No fixed date or patch count advances a milestone. Optional hosted-evaluator operation has a separate deployment track; a public source repository is not a hosted service, and hosting is not silently promised for 1.0.
