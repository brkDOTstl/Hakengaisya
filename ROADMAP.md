# Hakengaisya roadmap

Updated: 2026-10-24. Current suite version: **0.8.8**. Current milestone: **complete researched workflow presets, scale variants and same-host agency coordination**.

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
| Executable presets | [Bounded software](docs/bounded-software-preset.md) covers micro and small-parallel work with source records, generated graphs, a bounded pool, supervisor acceptance and failure/recovery paths | First declared bounded scope structurally/synthetically validated; broader project families, multi-team workflows and real-task validation remain incomplete |
| Organization/reference examples | Small-tool and indie-game organization proposals; older software/product reference templates | These remain distinct from complete executable project presets |
| Employee evaluator | Independent recorder/API, signed local HTTP, offline retry, task/skill profiles, ranking and model details | Peer scores are observations, not verified ground truth or proof of AI authorship; hosted operation is separate |
| Model participation and management review | Opt-in DEI roster coverage, evidence-backed submission accounting, automatic manager score/tag and a complete supplied-route candidate audit | Host-declared model identities are not authenticated; no live cross-family client execution or hosted management-review endpoint is claimed |
| Host transport | Shared command table behind the CLI and a stdio MCP server in the workflow plugin; atomic event batches, inspectable lock metadata and journal timestamps | Tool availability in an installed host is not automatic invocation; the server persists state and never launches models or inspects artifacts |
| Public source and checks | MIT suite, both plugins, executable tests and Windows/Linux CI | Passing structural or synthetic tests does not establish real-task completion or measured savings |

The earlier Pomodoro trial was real and exposed excessive coordination overhead. It does not validate the newer hierarchy/composition system as a full real-game or multi-project workflow.

## Current work and immediate order

| ID | Status | Deliverable |
| --- | --- | --- |
| P01 | Done in 0.8.1 | Record the 0.8 / 0.9 / 1.0 sequence, current gaps and completion gates |
| P02 | Bounded v1 implemented in 0.8.8; broader schema coverage pending | [Executable contract validator](docs/preset-contract.md) covers source, applicability, scale, acceptance, resources and all six failure/recovery cases for bounded software |
| P03 | Bounded-software source review complete; other families pending | Source-specific adoption and transfer limits are carried by the first preset; continue the [remaining research](docs/preset-research.md) |
| P04 | Implemented for v1 in 0.8.8 | Registry plus list/inspect/validate/select/expand commands through shared MCP/CLI; output is a versioned draft graph with staffing and correction guidance |
| P05 | Bounded software complete for its declared scope in 0.8.8; web/service pending | Micro and two-component small variants pass structural/simulated paths; web/service and multi-stream project workflows still need complete researched presets |
| P06 | Planned | Complete technical-product and indie-game workflows beyond their current role/reference examples |
| P07 | Planned | Complete desktop/client, data/database, AI integration and maintenance/investigation families |
| P08 | Planned | Connect scale overlays, stage activation and handoff/rework rules without silently changing a running hierarchy |
| P09 | Bounded variants checked in 0.8.8; other coverage pending | Positive paths, rejected work, missing capability/budget, interruption, scope change, retry limits, current-pool enforcement and packaged MCP/CLI are covered for the first preset |
| P10 | First preset guide/examples complete; final coverage review pending | Packaged English request examples and [host usage](docs/bounded-software-preset.md) are available; remaining families still block the overall 0.8 gate |
| D01 | Implemented in 0.8.3 - structural/synthetic checks | [Optional DEI participation and family-neutral route review](docs/model-participation.md); keep ordinary cost/ability planning as the default |
| H03 | Implemented in 0.8.6 - strict typecheck, regression and trial tests | Strict TypeScript across the suite and evaluator (browser leaderboard excluded) run directly by Node 24; latent malformed-input crashes fixed; opt-in trial routes for the evidence cold start; journal growth measured (1.3 MB, about 7 ms per locked update at 300 items) and kept intact. Trial routes are synthetic-tested only; no real model run has used them yet |
| H02 | Implemented in 0.8.5 - synthetic benchmark and regression tests | Copy-on-write events, single-pass route preparation, unified write-scope normalization, template-declared audits, Biome formatting and lint in CI; controller speed is measured on synthetic graphs only, not on real model runs |
| H01 | Implemented in 0.8.4 - stdio round-trip tests | [MCP workflow tools, atomic event batches and lock metadata](plugins/hakengaisya/skills/company-workflow/references/run-commands.md) to cut per-transition host overhead; invocation in a fresh installed host remains unverified |
| O01-O08 | Partial O01/O03 foundation in 0.8.7; O02/O04-O08 remain planned | [Harness2 optimization workstream](#harness2-integration-workstream): native MCP integration, optional optimization worker, versioned execution profiles, controlled experiments and evidence-based promotion |

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

## Harness2 integration workstream

**Architecture approved on 2026-10-23; partial foundations implemented in 0.8.7.** Integrate [Google Research Harness²](https://github.com/google-research/harness2) as an optional optimization engine behind the existing Hakengaisya workflow/MCP plugin. Reuse its Propose-Probe-Compose method through a thin adapter, while Hakengaisya retains dispatch, supervision and delivery acceptance. The independent evaluator continues to supply contextual model observations.

The objective is to improve delivery quality and cost efficiency by learning which execution profile works for a particular model and task context. Expensive optimization should produce reusable profiles for later tasks. Capability gains and savings will be measured in the 0.9 real-task comparisons.

### Architecture and integration points

The intended loop is:

```text
Hakengaisya task planning and dispatch
  -> worker execution and direct-supervisor review
  -> local execution evidence and optimization trigger
  -> Harness2 Propose-Probe-Compose in isolated trials
  -> baseline comparison, independent review and validation
  -> versioned profile promotion or retention of the current profile
  -> profile selection for subsequent matching tasks
```

Add `packages/optimizer/` for the adapter, experiment state and local profile/experience store. Keep the upstream Python core as an optional worker, with a pinned upstream revision and preserved license/provenance records. The 0.8.7 core bridge runs natively on Windows with path normalization; the full upstream benchmark runner still targets Linux/WSL2; the existing Node.js workflow remains usable without it. Reuse existing authorized host/model connections for execution and advanced-agent review.

| Integration point | Planned change |
| --- | --- |
| `lib/types.ts` and `lib/workflow.ts` | Associate attempts and journal events with an immutable profile version, execution snapshot and optimization job |
| `lib/dispatch.ts` | Select a compatible promoted profile and include its materialized instructions in the dispatch envelope; pin the profile for that attempt |
| `lib/commands.ts` and the existing MCP plugin | Add short job-start/status/cancel and profile-management commands; keep long experiments outside the run-file lock and MCP request handler |
| `packages/optimizer/` | Implement `HakengaisyaTaskAdapter`, the Python-worker bridge, local evidence capture, isolated trials, promotion policy and rollback |
| `packages/evaluator/` | Preserve the current scoring/recording contract initially; keep model-plus-profile performance in a separate local optimization record |

Initial editable surfaces are execution prompts, skills, memory and tool guidance. Apply them as versioned per-attempt overlays. Keep task acceptance criteria, evaluator weighting, supervisory authority, core controller logic, permissions and credentials outside the optimizer's editable surface. Script, hook and plugin generation can follow after the initial profile path is validated.

### Tracked implementation sequence

O01/O03 have a partial 0.8.7 foundation: immutable scoped jobs, a pinned Python core worker, shared CLI/MCP job/result commands, bounded native-host requests, direct-supervisor adoption and a deterministic local example. See [the integration evidence](docs/harness2-integration.md). Complete source/environment telemetry, promoted profile versions and start/status/cancel lifecycle tools remain pending. The other items below are still planned. The target column expresses sequencing, not a completed release commitment.

| ID | Target | Deliverable and completion evidence |
| --- | --- | --- |
| O01 | 0.8.x foundations | Define execution-evidence, optimization-job and profile schemas. Bind `run_id`, `packet_id`, `attempt`, source/input snapshot, model/route/effort, environment, profile version, usage and review references. Distinguish live delivery, replay/probe and synthetic records; cover incomplete telemetry and stale evidence in contract tests. |
| O02 | 0.8.x foundations | Implement immutable local profile versions, compatibility matching and dispatch integration. Record the effective profile hash per attempt and preserve the base configuration when no compatible promoted profile exists. Test reproducible materialization and version pinning. |
| O03 | 0.8.x scaffold; 0.9 live validation | Build the optional Python-worker bridge and shared CLI/MCP job commands. Pin the upstream revision, record local adaptations, and verify start/status/cancel, restart recovery and optional-worker-unavailable behavior. Real model execution depends on a connected host adapter. |
| O04 | 0.9 real-task integration | Implement `HakengaisyaTaskAdapter` against the upstream task/execution/trajectory interface, starting with one supported Codex execution path. Capture actual artifacts, tool outcomes, test logs and usage. Run baseline/candidate trials from the same source snapshot in separate worktrees with separate build/output state and explicit process, network and credential controls. |
| O05 | 0.9 controlled experiments | Run a bounded Propose-Probe-Compose cycle on real tasks. Compare the original profile with candidate and composed profiles using the same task, worker model/effort, environment and declared execution limits. Reuse a prior baseline only when its snapshot and execution contract match. Record all proposal, execution, composition, selection, reflection and retry costs. |
| O06 | 0.9 promotion and rollback | Add independent advanced-agent comparison, fixed technical checks and held-out similar tasks. Always include the current profile as an eligible outcome. Promote a scoped version only when it meets the declared quality/cost criteria; preserve the incumbent otherwise. Demonstrate regression detection, rollback and unchanged in-flight version bindings. |
| O07 | 0.9 experience and routing | Store evidence-backed lessons, failed approaches and profile performance by model/version, project, task type and difficulty. Retrieve relevant experience and promoted profiles during later dispatch. Keep these results separate from model capability ratings and the evaluator's de-identified upload contract. Verify profile/model changes trigger appropriate revalidation. |
| O08 | After the first validated 0.9 path | Enable bounded automatic triggers and broader host support. Start from repeated attributable failures, an explicit supervisor improvement request or deliberate optimization runs; expose configurable budgets, concurrency, cooldowns and stop conditions. Add OpenCode and further executors after the first path has reproducible live evidence. |

O01-O03 can progress alongside the existing 0.8 preset and same-host work. The P01-P10 and F01-F05 requirements retain their current priority and exit conditions. O04-O08 depend on actual host execution and belong to the 0.9 validation track; recording this plan does not advance the suite version.

### Promotion and measurement contract

A profile moves through candidate, tested and promoted states, with rejection and rollback history retained. Promotion applies to an explicit model/task/project scope. Each task still follows its normal direct-supervisor acceptance contract.

Use the existing advanced-agent review capability in a separate review context. Compare anonymized baseline/candidate artifacts and observed technical evidence against fixed criteria; retain the baseline when evidence is insufficient or the candidate regresses. The initial technical path should exercise compilation, targeted tests and regression checks. Evaluate transfer on similar tasks held out from profile development before making the profile a reusable default. Keep final holdout outcomes outside iterative optimization inputs and refresh that holdout when it becomes development evidence.

Track three primary configurations on the same task set: an ordinary model with the current Hakengaisya workflow and advanced review; the same setup plus Harness2 optimization; and a frontier-model reference. Report acceptance/pass rates, regressions, human rework, wall time, model calls/tokens and total measured cost, including advanced review and all optimization attempts. State the reference workflow and budget explicitly. Account separately for one-time profile development cost and later reuse cost; use repeated matched runs to distinguish improvement from execution variability.

Store source, patches, trajectories and detailed evidence locally. Send the independent evaluator only its existing permitted de-identified fields. Automatic triggers must have a task-level and run-level budget, avoid duplicate optimization of the same evidence, and leave ordinary task delivery usable when optimization is unavailable.

## Required preset baseline for 0.8

This is the initial baseline within the suite's technical/product scope, not a claim to cover every industry. Record additions, exclusions or inapplicable scale variants explicitly instead of silently reducing coverage to reach 0.9.

| Family | Representative work | Current material | Missing before preset completion |
| --- | --- | --- | --- |
| Bounded technical task | Small tool, script, localized implementation or defect correction | bounded-software revision 1.0.0: executable micro/small variants and explicit larger-scale exclusions | Declared bounded scope structurally validated; broader technical subtypes need reviewed extensions and actual model/tool acceptance remains a 0.9 activity |
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
- [ ] Validate the first [Harness2 integration path](#harness2-integration-workstream) on real tasks: execution capture, isolated baseline/candidate trials, advanced-agent review, held-out transfer, scoped profile promotion and rollback (O01-O07).
- [ ] Compare the current and optimized ordinary-model workflows with a declared frontier-model reference; report total optimization/review cost, task quality, rework and latency, separating profile-development cost from reuse.
- [ ] Enable bounded automatic optimization and additional executors only after the first path is validated; record unavailable adapters and the tested support scope (O08).
- [ ] Revise presets and routing from observed outcomes, repeat the affected checks and preserve failed attempts.
- [ ] Document coverage, reproducibility and unresolved limitations; passing a synthetic test is not a completed real-task case.

## Gate from 0.9 to 1.0

- [ ] Representative supported workflows meet real task and user acceptance criteria.
- [ ] Important failure/recovery paths are demonstrated and release-blocking defects are resolved.
- [ ] Efficiency/cost claims are backed by comparable measurements and do not hide quality or rework costs.
- [ ] Installation, first-use setup, examples and error guidance work in the declared supported host/version scope.
- [ ] Model/tool limitations, privacy requirements, evidence semantics and operational controls are clear.
- [ ] Any optimizer/profile features included in the supported release scope have reproducible baseline comparisons, promotion/rollback evidence and a working optimizer-disabled path; experimental integrations remain explicitly labelled.
- [ ] Code, presets, documentation and release checks are consistent and reproducible.

No fixed date or patch count advances a milestone. Optional hosted-evaluator operation has a separate deployment track; a public source repository is not a hosted service, and hosting is not silently promised for 1.0.
