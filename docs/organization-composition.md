# Project-specific organization composition

An organization proposal selects capability modules, combines compatible responsibilities, establishes one accountable reporting root and activates positions for a project phase. The output is separate from the deliverable dependency graph, model catalog and live context bindings. It is not a task execution or a staffing forecast backed by real workload telemetry.

The generic composer is lib/organization.ts. Capability modules are data in config/organization-modules.json. The host selects modules after intake and deliverable analysis; a project-type label alone does not discover the required work. The first examples are a small software tool and a twelve-month indie game reference.

```text
node scripts/workflow.ts organize examples/organizations/small-software.json
node scripts/workflow.ts organize examples/organizations/indie-game.json
node scripts/workflow.ts organize examples/organizations/indie-game.json production
```

The core game proposal has seven positions. A representative production phase has eight including temporary audio support; stabilization has nine including release support. The small software example has two positions, or three when separate technical QA is justified. All are unbound proposals with unknown monetary cost and automatic_execution:false.

## Independent game reference

Assumptions: single-player PC game, established engine, 2D or lightweight 3D visuals, bounded original content, no custom engine, online service or simultaneous console launch. Twelve months is the user's human planning reference. It cannot be converted directly into AI wall time, tokens, cost or a delivery promise.

| Core position | Direct superior | Main working output |
| --- | --- | --- |
| Producer / project lead | Project owner | Scope, priorities, milestone decisions and integrated product readiness |
| Working technical lead | Project lead | Core systems, tools, build pipeline and integration; supervises gameplay implementation |
| Gameplay engineer | Technical lead | Gameplay, interface logic and bounded feature checks |
| Game and level designer | Project lead | Playable levels, encounters, progression and actual playtest findings |
| Working art lead | Project lead | Main visual direction and key assets; supervises asset production |
| Generalist artist / animator | Art lead | Engine-ready content, interface assets and animation |
| QA / release specialist | Project lead | Independent regression findings, target-build checks and release evidence |

Audio and release support report to the project lead as scoped temporary positions. The producer owns market positioning and release preparation from early development; late specialist activation does not mean marketing starts near launch. Real external publication, purchases, hiring and communication still need the appropriate authorization.

The technical/art leads produce work and review only work they did not produce. Their own outputs go to the project lead with independent specialist evidence where necessary. QA findings inform the superior's decision; QA does not acquire peer signoff authority. The project owner supplies product direction and required human acceptance. No arbitrary standalone CEO, CTO, HR or platform department is added to this reference.

## Phases and evidence

| Reference months | Active positions | Gate |
| --- | --- | --- |
| 1-2: prototype | 4 | Real core-loop prototype, intended-player feedback and the largest risk findings |
| 3-4: representative slice | 7 | One representative section combines gameplay, visual/audio targets and observed content-production throughput |
| 5-8: production | 8 | Bounded content becomes playable end to end with accountable integration |
| 9-10: stabilization | 9 | Actual compatibility, performance, regression and player-feedback evidence |
| 11-12: release and contingency | 8 | Accepted release candidate, authorized distribution and a support plan |

The calendar is a proposed allocation, not a fixed waterfall or an observed capacity result. Gameplay, art and QA exchange accepted results continuously. If the slice exposes insufficient throughput or weak product evidence, return a scope/time/budget decision to the owner rather than silently hiring more people or extending the deadline.

Explicitly merging gameplay work into the technical lead and generalist art into the art lead yields a five-position core. This is suitable only if workload and skills fit; the composer cannot prove that they do. More content, networking, simulation, animation or platform obligations require different modules, tooling and evidence. A technical artist is a potential response to an observed art/engine pipeline bottleneck, not a mandatory extra lead.

## Framework boundaries

Module dependencies and reporting lines must be acyclic. Every position needs functions, real deliverables and skills. Position count has its own ceiling. Active delegated agent capacity is separately bounded by the host; seven logical positions do not keep seven agents running for a year. The same model type may fill different qualified positions, but actual contexts still obey the single-superior rule and independent acceptance checks.

Project/phase position_overrides can customize titles and real responsibilities without changing reporting or evidence requirements. Explicit independent_of constraints prevent merging QA into the production role it must independently check. Merged positions retain every original evidence requirement; combining responsibilities does not erase a visual, audio or external acceptance boundary.

The host must next generate real work items, qualify models and tools, bind actual contexts, and account for measured startup/handoff costs. Phase proposals and responsibility merges do not mutate an existing runtime hierarchy or bypass its gates. Running-company reorganization still needs explicit state migration rather than relabeling current agents.

Game art, sound and enjoyment are included as required capability slots. This does not enable artistic numeric scoring in the technical evaluator, provide an asset-production tool adapter, or establish player enjoyment from code tests. Actual rendered/audio artifacts, qualified review and real play sessions remain necessary. The technical-only runtime scope is unchanged by an organizational proposal.

## References and transfer limits

- [ScreenSkills producer profile](https://www.screenskills.com/job-profiles/browse/games/production/games-producer-games/) describes collaboration with design/art/programming and producers handling project management in smaller companies. The seven-position proposal and calendar are our design, not its staffing prescription.
- [ScreenSkills technical artist profile](https://www.screenskills.com/job-profiles/browse/games/technical-art/technical-artist/) describes the bridge between art workflows and programming. It informs the conditional specialist example, not a claim that the current models can perform it.
- [Team Cherry's team page](https://www.teamcherry.com.au/about/) illustrates working creative directors and a coder. Its team size and production history are not a basis for promising this project will take one year.
- [A Short Hike GDC session summary](https://www.gdcvault.com/play/1026613/) ties a deliberately small project to a short development deadline and discusses scope/style choices. Only the public session description was reviewed; it does not validate our schedule or game quality.
