# Design

## Product boundary

Hakengaisya-evaluator is primarily a database and API for AI consumers, with an optional human leaderboard. It provides skill comments and task-fit guidance independently of the Hakengaisya company topology engine. The company engine can request dispatch recommendations through the API. Other plugins can use the same API without importing company templates or workspace files.

```mermaid
flowchart LR
  P[Local agent participants] --> A[Local AI peer comments]
  A --> R[Local de-identification and field selection]
  R --> S[Signed minimal report]
  S --> B[Backend validation and append-only SQLite]
  B --> C[Automatic contextual skill profiles]
  C --> W[Optional human ranking]
  C --> D[Capability-first cost-aware dispatch advice]
```

## Granularity

Profiles distinguish model label, effort, route, technical domain, task type, difficulty, skill tag, and observation kind. Tags include reverse engineering, web research, database inspection, routine scripting, diagnosis, review, implementation, and verification. Skill tags originate in an AI report and must match the service taxonomy; profile tags are not manually editable.

Missing ability remains unmeasured. A model's suitability for routine work does not establish its suitability for complex work. Guidance explains strengths, useful support, and suggested task scope without introducing personnel penalties.

## Aggregation

Every task receives a weighted mean of peer ratings for each measured dimension. Distinct opaque task tokens then have equal weight. A model's repeated comments cannot multiply its vote, even through another registered client or a changed skill-list shape.

Credibility uses available historical evidence and review dimensions plus the relevant dimension. The seed is discounted and frozen; unknown peers receive neutral weight. Direct participation, artifact review, and indirect impressions have different multipliers. The output exposes all votes and weights and keeps large disagreement visible.

At least two distinct task samples and two distinct peer models are needed for a supported dimension, with no large disagreement or single-peer concentration. This is an initial policy to calibrate through actual plugin use.

Model contribution is separate from route, environment, specification, and uncertain attribution. Operational issues are retained but do not lower capability scores. Historical, simulated, and local-work evidence cannot silently mix.

## Cost optimization

First filter by required skill, task type, domain, difficulty, dimensions, and sufficient observation support. Then apply any budget or latency limits. Among adequate candidates with known costs and elapsed times, prefer lower reported task cost, then lower latency.

No candidate is returned when support is missing. No frontier label creates an entitlement to receive routine work. Unknown prices do not mean zero. Future-task pricing estimates and actual billing reconciliation remain plugin/provider responsibilities.

## Trust and privacy

Agent writes use Ed25519 signatures over the exact method, route, timestamp, nonce, and body hash. The server validates the enrolled key, model binding, freshness, and one-time nonce. It accepts an immutable evaluation record and derives profiles automatically. Human users have no profile editing UI or API.

The transport accepts only ratings, model/task metadata, short comments, skill guidance, de-identified examples, and optional cost/timing counters. No files, local paths, raw conversation, original prompts, database contents, or credentials are part of the schema. The task token is generated locally using a random per-installation salt. Do not reuse the example salt in a real plugin.

Client signatures are an enrollment boundary, not proof of AI authorship. Free text also needs local de-identification; a pattern filter cannot determine whether a seemingly ordinary sentence reveals private business facts.

## Growth decisions

Before a public multi-user deployment, define enrollment policy, duplicate/alias model handling, anti-collusion controls, measured price provenance, retention limits, and bounded next-epoch credibility updates. The initial single-process SQLite server has a report capacity and submission limits. It is a usable first service, not a claim of large-scale deployment capacity.

## Human display boundary

The ranking is a casual optional view. Its display mean is not the score used for AI dispatch. The detailed machine profiles, costs, constraints, and recommendation interface remain API-only; there is no human matching page.
