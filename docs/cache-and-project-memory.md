# Single-model continuity, prompt-cache review and project engineering memory

Repeatedly dispatching different models or rewriting top-of-prompt instructions across subtasks destroys provider KV-cache prefixes and forces every worker to re-read the repository from scratch. Hakengaisya aligns planning, dispatch, review and long-term engineering memory around prefix-cache preservation while keeping supervisor independence intact.

## 1. Continuity scheduling (`continuity_policy` / `cache_policy`)

`planning_limits.continuity_policy` (or `cache_policy.continuity_mode`) controls how `planWork` and `prepareIntegratedReplan` assign models across a task graph:

- `sticky` (default): preserves parallel overlap when concurrent slots finish earlier, and prefers reusing an already-warm `context_key` first and an already-active `model_id` second within `parallel_cost_premium`.
- `prefer-single-model`: searches for a single execution `model_id` capable of completing every non-audit work item within `budget_usd` and `deadline_seconds`, falling back to multi-model routing (`fallback_reason: "no-single-model-satisfied-all-work-and-bounds"`) only when no single model qualifies for the full graph.
- `strict-single-model`: requires a single execution `model_id` across all non-audit work items in planning, runtime `assign` events and replanning (`single-model-continuity-unmet` when impossible). Independent `audit_sources` packets remain exempt so producer-versus-verifier separation holds. Conflicts with multi-model `dei` rosters are rejected at validation time.
- `none`: legacy cost/time tie-breaking without context stickiness.

`planning_limits.warm_context_cost_discount` (`0..0.95`) optionally discounts the per-item work cost when a candidate reuses an already-warm `context_key`. Replanning (`prepareIntegratedReplan`) automatically seeds `warm_context_keys` and `incumbent_model_ids` from accepted packets so healthy active workers are not replaced because of minor score or price fluctuations.

## 2. Observed `cached_input_tokens` across workflow and evaluator

- Packet `submit` events accept optional `usage`: `{ input_tokens, cached_input_tokens, output_tokens, cost_usd, wall_seconds, evidence_reference }`.
- `packages/evaluator` (`Usage` in `contract.ts`, `sdk/client.ts`, `recorder.ts`, `profiles.ts`, `benchmark.ts`), `lib/feedback.ts`, `lib/cost-observations.ts` and `lib/evaluator-bridge.ts` accept optional `cached_input_tokens` (`0 <= cached_input_tokens <= input_tokens`). Existing v1 payloads that omit `cached_input_tokens` remain signature-compatible; omitted values stay unknown (`null`) rather than `0`.
- Aggregate cache hit rates (`observed_cache_hit_rate` on evaluator profiles, `cache_hit_rate` on benchmark candidates, and `usage.observed_cache_hit_rate` in `agentReview`) are token-weighted: `sum(cached_input_tokens) / sum(input_tokens)` over observations with positive `input_tokens` and non-null `cached_input_tokens`.

## 3. Management review penalty and configurable hard gate

`agentReview(run)` and `prepareReview(run, packetId)` report `cache_and_continuity`:

- Counts `execution_models`, `execution_contexts`, `context_reuses`, `model_switches` and `unjustified_model_switches` (model switches on non-audit work without a prior rejected attempt or candidate exclusion).
- Computes management `score` (`1..10`) and policy `tags` (`unjustified-model-switch`, `execution-model-limit-exceeded`, `cache-below-target`, `cache-below-minimum`, `cache-usage-unmeasured`).
- By default (`cache_policy.enforce_cache_gate: false`), shortfalls lower the management review score and surface tags in `prepareReview` without blocking technical acceptance when a provider evicts cache entries.
- When `cache_policy.enforce_cache_gate: true` (requires `minimum_cache_hit_rate`), terminal `handover` acceptance requires measured `cached_input_tokens` and a cumulative token-weighted `observed_cache_hit_rate >= minimum_cache_hit_rate`.

## 4. Project engineering memory and frozen L0+L1 prefix dispatch

Task-slot experience (`lib/experience.ts`) hashes ten task/model attributes and is scoped to narrow Harness2 probes. Project engineering memory (`lib/project-memory.ts`) instead indexes by `(scope, evidence_kind, domain)` so stable repository knowledge (architecture, build/test commands, conventions, pitfalls, constraints) is shared across task types, difficulties, skills and models while keeping `simulation` and `local_work` strictly separate.

To prevent long-term memory updates from invalidating KV-cache prefixes mid-run:

1. **Curated post-acceptance registration (`project_memory_register` / `project-memory-register`)**: only the independent direct supervisor of an accepted packet may register an immutable entry (or supersede an older entry via `supersedes_entry_id`).
2. **Deterministic L1 rendering (`project_memory_lookup` / `project-memory-lookup`)**: active entries are ordered canonically by `(category, entry_id)` and bounded by `max_bytes`, producing a byte-deterministic `rendered_prefix` and `snapshot_sha256`.
3. **Per-context prefix freeze (`integrated_reserve` + `prepareDispatch`)**:
   - First turn on an `owner_context` freezes `bound_memory_snapshots[owner_context]` on the run and emits `prefix_cache_contract.mode = "initialize-frozen-prefix"` (`layers: { l0_role_contract, l1_task_header, l1_project_memory }` + `turn_delta`).
   - Continuation turns on the same `owner_context` emit `prefix_cache_contract.mode = "append-turn-delta-only"` (`prefix_unchanged: true`, `layers: null`, identical `frozen_prefix_sha256` + `turn_delta`). Any project memory registered on disk mid-run is flagged as `deferred_disk_updates: true` and deferred until a fresh context or run, preserving the active context's prefix cache.

## Evidence boundary

These controls are verified by deterministic unit, integration and evaluator service/benchmark tests. They do not authenticate provider token telemetry or prove live KV-cache savings until exercised on real host/provider runs in 0.9.
