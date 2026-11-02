# Custom workload benchmarks

The evaluator has two complementary evidence sources: reviews of real work and controlled comparisons on a user's own tasks. Both inform model/task fit, quality, cost and time. A benchmark is part of this evaluator package; the company workflow consumes its advice and retains dispatch and supervisor acceptance.

## Direction and delivered slice

The intended path is work context and examples, versioned tasks and grading criteria, comparable candidate execution, objective and calibrated subjective grading, category-level quality/cost/time evidence, and scoped staffing advice. Real-work reviews continue to test whether those expectations transfer to actual delivery.

The unreleased first slice implements a local structured-output benchmark with manually curated tasks. It freezes the specification, prepares answer-free host handoffs, claims independent execution contexts, records immutable results, grades JSON values against fixed criteria and reports per-task/category/candidate outcomes. It works through the standalone evaluator CLI and the existing company MCP/CLI command table. No company run or peer-evaluation service is needed for the evaluator CLI.

Automatic task generation/import, executable code/artifact graders, blinded rubric and pairwise judging, human calibration, held-out evaluation, statistical uncertainty, benchmark preparation/judging costs, and profile qualification remain planned. A report never silently promotes benchmark scores into D1-D6 or `local_work`.

## Try the local fixture

From `packages/evaluator`:

```powershell
npm run example:benchmark
```

This creates a new private `.local/benchmark-demo-<id>/` containing `benchmark.sqlite` and `report.json`. The two fixture candidates complete two tasks using deterministic replies. One candidate deliberately fails a required extraction check. Costs and times are fixture values, not measured model behavior. The peer database, its identity configuration and its reports are unused.

## Host workflow

Use an absolute local `.sqlite` path. A separate database holds raw task inputs and outputs locally; the peer-report database is rejected. A run ID selects one immutable specification in this database. The same run/spec retry is idempotent; changed tasks, rubric, candidates, configuration, evidence kind or limits require a new run ID.

```powershell
npm run benchmark -- create C:\Task\.local\benchmark.sqlite trial-01 spec.json
npm run benchmark -- next C:\Task\.local\benchmark.sqlite trial-01
npm run benchmark -- claim C:\Task\.local\benchmark.sqlite trial-01 claim.json
npm run benchmark -- complete C:\Task\.local\benchmark.sqlite trial-01 result.json
npm run benchmark -- report C:\Task\.local\benchmark.sqlite trial-01
```

The shared workflow CLI uses `benchmark-create`, `benchmark-next`, `benchmark-claim`, `benchmark-complete` and `benchmark-report` with the same arguments. MCP exposes `hakengaisya_benchmark_create`, `next`, `claim`, `complete` and `report` with `database_file`, `run_id` and, for writes, `request`. Their implementation lives in the evaluator. Rebuild/reload the workflow plugin to expose changed tools in a host.

1. Curate a representative specification using [the synthetic example](../fixtures/benchmark-smoke.json) as its schema example. `revision` identifies the dataset version; `environment` and `configuration_ref` pin the common environment and each candidate. Use `host-observed` only for actually executed host attempts, and `simulation` for fixture/control exercises. Synthetic task content can also be executed by real models; retain its source as `synthetic`.
2. `next` selects an unclaimed task/candidate/repeat cell. Its handoff includes the task prompt/input, candidate, environment and limits. Expected answers and grading criteria are withheld. A SHA-256 fingerprint binds the full specification; it is a consistency check, not a signature.
3. Preflight the actual route, model, effort, configuration, environment and an independent conversation. Submit a claim with `run_id`, `attempt_id`, `benchmark_hash`, and `binding: {model, route, effort, configuration_ref, environment_id, context_id, identity_evidence}`. Use the exact IDs and pinned references from the handoff. Only a new claim returns `dispatch_allowed: true`; an identical retry returns false. Within a run each attempt needs a distinct actual context ID, including repeated trials. Host declarations are not provider authentication or proof of context isolation.
4. When a claim permits it, the host performs the authorized model call under the common limits. This tool does not launch or spend on a provider. Task inputs, grading answers and outputs stay out of the peer-report upload path. The executing context should receive only the handoff and should not have access to the grading store.
5. Record the actual result using the same claim fields and `claim_hash`, plus the result fields below. Repeating identical content is idempotent. Altered results, different bindings, unclaimed completions and a changed benchmark fingerprint are rejected. Interrupted/uncertain calls remain claimed and are never automatically launched again. Record an observed interruption or failure; do not invent completion evidence. Use a new frozen run for a later replacement trial.
6. Inspect `report`, including pending cells, each criterion, observed failures, category coverage and cost basis. Do not infer capability from a partial run or transfer a benchmark score to unrelated tasks. A changed code/environment/configuration should have a new pinned reference and run.

Result fields, in addition to the original claim:

```json
{
  "claim_hash": "the hash returned by claim",
  "status": "completed",
  "output": { "total_cents": 2200 },
  "usage": {
    "input_tokens": 100,
    "output_tokens": 10,
    "cost_usd": null,
    "wall_seconds": 1.2
  },
  "cost_basis": "unknown",
  "cost_reference": null,
  "evidence_reference": "Local execution receipt, identity and usage evidence reference",
  "failure_reason": null
}
```

Use `failed` or `interrupted` with a nonempty `failure_reason` and `output: null` for non-completed attempts. Usage can still retain their observed cost and duration. Known costs require `cost_reference` and one of `actual-billed` or `api-equivalent-estimate` in host-observed runs. Estimates retain their pricing source and assumptions in that reference. Fixture costs are only accepted in simulated runs. Missing usage stays null.

## Grading and comparison semantics

Each criterion tests exact JSON equality at a JSON Pointer (`""` selects the whole output). Missing values differ from null, false differs from zero, and objects compare independently of key order. Weights are positive. A failed required criterion forces the attempt score to zero; optional checks contribute their weighted fraction after required checks pass. Failed/interrupted attempts and observed time/token overruns score zero. The host must enforce limits during execution; the report can only flag overruns supplied in telemetry.

Reports show expected/recorded counts, observed mean score, terminal failures, success rate, cost and elapsed time, by candidate and category. Unfinished runs have no final success rate. A numeric mean over recorded attempts remains provisional while coverage is incomplete. Full coverage plus known output-token/time evidence, required checks and the declared quality floor are necessary for `meets_observed_floor`; it is an empirical result on these tasks, not qualification for real work.

`observed_frontier` contains candidates meeting that floor that are not dominated on observed score, cost and time by another comparable candidate. Every comparison uses the same cost basis. Unknown costs/durations, a mix of estimates and bills within one candidate, or incomplete coverage cannot prove a frontier advantage. Estimated costs do not become account billing. Execution costs include failed attempts; this slice does not measure setup, grading, human calibration or downstream correction costs. It claims no statistical confidence or savings guarantee.

Database transactions permit only one claim per cell even across host processes. Fingerprints detect inconsistent stored specs/claims/results; they do not protect against a malicious database owner rewriting a whole history. Local raw task data is not exposed through the existing public HTTP leaderboard. Existing peer-report authentication, privacy validation and recommendation rules remain applicable to that separate evidence stream.

## Next increments

| Stage | Output | Acceptance evidence |
| --- | --- | --- |
| B01: delivered foundation | Versioned curated JSON tasks, candidate/repeat matrix, host claims, objective grading, private results and CLI/MCP comparison | Fixture execution, persistence, concurrent host claims, provenance/unknown metrics and packaged tools tests |
| B02: task building | Draft tasks from approved examples/traces with editable categories and frozen development/holdout sets | Source mapping, missing-case checks, human review and leakage tests |
| B03: broader judging | Objective artifact checks, blind rubric/pairwise grading and human calibration | Independent judge configurations, order-bias/disagreement checks, held-out results and full evaluation costs |
| B04: evidence guidance | Scoped benchmark evidence alongside real-work reviews, with sufficient sample support and freshness | Explicit qualification policy, uncertainty, no synthetic-to-live relabeling and downstream planner tests |
| B05: useful operating loop | Controlled refreshing, visual comparison and follow-up real-work evidence | Actual host/model runs, observed economics, regression handling and human acceptance |

The current package stays on its unreleased development path. This increment neither finishes the suite's 0.8 exit criteria nor proves commercial or real-task readiness.
