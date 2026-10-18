# Sources and design boundaries

Reviewed on 2026-10-10. These sources support the reference practices below. The role definitions, reporting lines, artifact names, gates, and rework rules in Hakengaisya are original proposals for an agent workflow.

## Software delivery

- [Team Topologies interaction modeling](https://teamtopologies.com/key-concepts-content/team-interaction-modeling-with-team-topologies) distinguishes stream-aligned, platform, enabling, and complicated-subsystem teams and describes their interactions.
- [Capra Consulting's organization case](https://teamtopologies.com/industry-examples/capra-consulting-applying-team-topologies) describes a real consultancy moving toward specialized, networked teams. Its account includes positive outcomes and difficulties with unclear responsibilities, communication, and leadership continuity.

Borrowed principles: explicit team purposes, service boundaries, accountable coordination, and support capabilities around delivery work.

Adaptation: our delivery lead and independent assurance function are proposed coordination and evidence boundaries. Capra's case does not prescribe this exact reporting tree. Platform and enablement are optional capabilities; a specialized subsystem can be added when an actual task requires one.

Evidence type: practitioner framework plus a company-authored case. This is not a controlled comparison proving one universally best company structure.

## Product design

- [IDEO](https://www.ideo.com) describes multidisciplinary work through inspiration, ideation, and implementation, with prototyping and iteration.
- [SVPG: Product, Design and AI](https://www.svpg.com/product-design-and-ai/) describes product, design, and engineering responsibilities and their participation in discovery and delivery.

Borrowed principles: investigate people and context, explore solutions with design and engineering together, and test a prototype before treating a concept as ready.

Adaptation: an explicit research role, independent evaluation role, and artifact gates make evidence ownership visible for agents. This is a proposed task structure, not an asserted IDEO organization chart. Research requires supplied or separately authorized real evidence; invented interviews cannot pass its gate.

Evidence type: operating practices published by a design company and product practitioners. No quantitative performance advantage is asserted here.

## Education production

- [Allen Interactions: SAM process](https://www.alleninteractions.com/sam-process) describes preparation, iterative design, and iterative development, including early prototypes and repeated review.
- [ATD: All About ADDIE](https://www.td.org/content/newsletter/all-about-addie) describes instructional design stages and evaluation throughout the process.

Borrowed principles: define the performance need, prototype a learning experience early, and use evaluation to drive revision. ADDIE is a secondary reference for coverage, not a requirement for a rigid waterfall.

Adaptation: separate subject correctness from learner performance. A subject expert checks accuracy; a learning evaluator checks objective, instruction, practice, and assessment alignment and actual learner evidence. The exact six-role structure is ours. Missing learner evidence leaves effectiveness unverified.

Evidence type: a training company's published process and professional association guidance. Provider testimonials are not treated as independent proof of superiority.

## Upstream calling logic

Reference repository: [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent).

Observed default branch: `dev`. Reference tree commit: `762839e5551317d04086bb7b4e49b25ad175bd92`.

The reviewed [DAG type contract](https://github.com/code-yeongyu/oh-my-openagent/blob/762839e5551317d04086bb7b4e49b25ad175bd92/packages/senpi-task/src/dag/types.ts) distinguishes category and agent routes, carries task dependencies separately, and represents task and run states. Its [README](https://github.com/code-yeongyu/oh-my-openagent) describes multi-model orchestration and graph-based work.

Relevant concepts for a later adapter:

- Keep a task's responsibility target separate from the provider/model selected to execute it.
- Schedule task dependencies independently of reporting relationships.
- Preserve attempts, state transitions, and result evidence across interruptions.

Only the first two concepts have direct static support from the inspected route and node declarations; the third is a design requirement to investigate in runtime and persistence code before reuse. No upstream runtime has been installed or exercised in this workspace, and no upstream implementation or prompt text has been copied into these templates.

Upstream code reuse and an actual fork remain implementation decisions. The repository's [license](https://github.com/code-yeongyu/oh-my-openagent/blob/762839e5551317d04086bb7b4e49b25ad175bd92/LICENSE.md) should be reviewed against the intended distribution before incorporating source code.

## Common template semantics

- `roles` defines responsibility slots. `model_binding: null` means execution is not configured.
- `authority` defines permitted internal delegation relationships. Every non-root role has one manager; the authority graph has no cycle.
- `interactions` defines directed capability or review relationships. Reciprocal collaboration does not imply a workflow dependency.
- `workflow.external_inputs` names task-supplied artifacts.
- `workflow.stages` defines an illustrative artifact dependency graph. A stage's owner is accountable; contributors help produce its result.
- A gate reviewer is separate from the stage owner and contributors. Passing requires checking the named evidence, not merely receiving a confident answer.
- `rework_to` identifies the earlier or current stage responsible for correcting a rejection. It is not a dependency edge. A future runtime must version attempts and invalidate downstream evidence after a revision.
- The only terminal stage is the final handover. Optional roles are available capabilities, not workers that must be started for every task.

The version 0.3 controller persists runs, checks dependency and acceptance transitions, rejects declared context self-review, detects overlapping declared writes, and invalidates affected downstream artifacts. It does not inspect evidence contents, prove context identities, sandbox workers, enforce external permissions, or route model calls. Those responsibilities remain with the host. No upstream runtime or source code has been incorporated into the controller.
