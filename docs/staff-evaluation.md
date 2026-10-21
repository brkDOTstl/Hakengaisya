# Local staff evaluation

## Intended behavior

Evaluate the experience of building technical products locally. The staff coordinator receives peer comments and periodically asks task participants about other models. It organizes their opinions, computes a transparent weighted estimate, and passes contextual capability advice to the task lead.

The coordinator does not supply an invented independent opinion. The first adapter asks peers for structured ratings directly. A future free-text normalizer must preserve the original comment and make its interpretation explicit.

## Imported reference

The original chart and its rubric/schema are private local inputs. They are excluded from the public repository, together with their paths, hashes, raw comments, historical registry and generated dashboard. Public examples for the independent evaluator use de-identified summaries in packages/evaluator/fixtures.

The importer reads data constants without executing the page's JavaScript. It preserves local provenance without modifying the source. A fresh public checkout starts with no historical staff registry; the legacy build command uses neutral defaults until an owner supplies local records.

The six-dimension foundation is retained. D5 emphasizes effective delivery speed within a task class. D6 includes reliability and coordination. Historical scores describe the original chart's dimensions and are retained with their original dimension definitions.

Historical source labels are not assertions about available models, official model names, actual server-side identities, or current pricing. The two Sonnet route variants remain separate history rows but map to one model seed. Public benchmark text is not imported. Historical observation counts are kept as claims and do not establish new confidence.

## Weighting policy

The versioned policy is `staff/policy.json`. Its numerical choices are an initial heuristic to test, not externally validated constants.

For each scored dimension, take the reviewer's previously recorded evidence precision, review ability, and the relevant dimension. Prefer a supported capability snapshot matching project, role, task class, and difficulty. If that is absent, use the imported historical seed with a discount. If neither exists, use a neutral startup weight.

The initial base credibility is the square of the available ability mean divided by ten, with a minimum of 0.1. Historical credibility is blended halfway toward the neutral 0.25 startup weight. Direct collaboration, artifact review, and indirect impressions have multipliers of 1, 0.8, and 0.35 respectively.

Each task/input pair gets a weighted mean of its peer ratings. Distinct task/input estimates have equal weight when combined. Strong reviewers therefore have more voice within a task, while a frequently discussed task does not overwhelm the full work history.

The registry is frozen for an aggregation round. Current comments cannot increase their own authors' weights. Supported snapshots can be supplied in a later registry epoch; automatic registry promotion is not implemented yet. Opinions do not become proof of review accuracy merely because their authors agree.

## Context, experience, and uncertainty

Profiles are partitioned by model, project, template, role, task class, difficulty, and subject effort. The caller must assign difficulty from a task contract before feedback collection; the coordinator should not relabel a failed task as complex to excuse its result.

Routes are attributes, not separately ranked employees. Route, environment, specification, and unknown-attribution feedback is retained in an operational section and excluded from capability averages. Praise for correctly identifying a specification defect can still be recorded as a positive model contribution with an explanatory comment.

Self-rating is rejected. The host must supply canonical model identities; alternate aliases must not be used to circumvent this rule. The latest comment from a given reviewer model on the same task/input replaces earlier comments even when a different employee instance submitted it. Earlier files remain preserved.

Every dimension tracks its own task sample count and peer count. Missing dimensions remain null. A gap of four or more points on the same task is shown as disputed rather than hidden by averaging. Supported peer feedback requires at least two task/input samples, two peer models, and no excessive concentration or unresolved large disagreement. These labels describe opinion support, not independently proven model ability.

Working experience can include correction rounds, clarification rounds, handoff rework, elapsed work time, environment waits, specification changes, and notes. Unknown metrics must not be filled with zero. Reviewer prose, raw scores, weights, weight basis, and evidence references remain available in the projection.

Role-fit estimates include dimension coverage. Sparse or disputed profiles do not qualify for dispatch advice. Assignment remains a task lead decision; staff feedback cannot override a task's actual acceptance criteria.

## Storage and commands

- `staff/imported/legacy-staff-chart.json`: immutable imported source snapshot.
- `staff/registry.json`: frozen startup credibility registry.
- `staff/feedback/<feedback_id>.json`: immutable peer comments.
- `staff/surveys/`: unsent survey request plans.
- `staff/projections/profiles.json`: rebuildable weighted projection.
- `wiki/index.html`: generated dashboard, with no external fonts, chart scripts, or network calls.

Records are idempotent when their content matches. A conflicting record with an existing identifier is rejected. Evidence paths and hashes are references; this prototype does not automatically read or independently verify those referenced files.

```powershell
node scripts/staff.ts import-legacy path-to-private-chart.html
node scripts/staff.ts record feedback.json
node scripts/staff.ts survey context.json participants.json
node scripts/staff.ts build
```

A feedback record has `schema_version`, `feedback_id`, `created_at`, `reviewer`, `subject`, `context`, `relationship`, `attribution`, `summary`, `ratings`, and `evidence`; `request_id` and `experience` are optional. Survey plans include a structured response template. `validateFeedback` is the executable input contract.

## Connection boundary

Both active templates declare a `staff_feedback` hook and a staff coordinator responsibility slot. The observation hooks cover peer comments, completed/rejected stages, blocked work, and periodic surveys. They are side-channel records and do not add a gate to software or product delivery.

`buildSurvey(context, participants)` constructs requests to other model identities on the same task. `collectSurvey(plan, askPeer)` invokes a supplied host adapter, validates sender, target, and task identity, and keeps route failures separate. `surveyDue` checks the periodic scheduling contract. The initial interval is 1800 seconds with at least three new completed tasks; those are editable defaults.

No agent host, model provider, persistent timer, or automatic transcript collector is connected. An actual launch record and real task comments must come from that host when it is selected. The tests use clearly labeled synthetic peers and establish algorithm behavior only; they do not contribute to the staff chart.
