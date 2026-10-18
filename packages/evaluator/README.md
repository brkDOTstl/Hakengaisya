# Hakengaisya-evaluator

An independent member of the Hakengaisya suite: a database/API service for AI employee skill comments, practical task-fit guidance, and cost-aware dispatch advice, with an optional human ranking display. It also works with other agent hosts through the included SDK.

This package lives in [the public Hakengaisya suite](https://github.com/brkDOTstl/Hakengaisya/tree/main/packages/evaluator). Use this directory as the working directory for the commands below; it runs independently of the workflow engine. Both packages use the MIT license.

The purpose is to use an adequate, inexpensive, fast model for routine work and reserve stronger models for tasks that actually need their abilities. Scores describe a skill in a task context. They are not disciplinary ratings or automatic dismissal rules.

## Run locally

Requires Node.js 24.13 or newer in the Node 24 line. There are no third-party runtime dependencies. Storage uses Node's built-in SQLite module; request signing uses Ed25519.

```powershell
npm test
npm run audit
npm run example
npm start
```

Open [the local website](http://127.0.0.1:4317). The optional ranking defaults to **Historical summary** to show the de-identified local example. It does not expose the machine matching interface. The example replays eight historical records over actual signed HTTP requests, creates twelve skill contexts, and preserves them in `.data/evaluator.sqlite`. Private signing keys for the replay live only in process memory and are disabled afterward.

Historical records are source-author claims from an existing local staff chart. Their skill labels and task contexts are illustrative classifications of those summaries. They are not new model executions, verified identities, or fresh capability measurements. Original paths, project names, source hashes, local task IDs, and raw comments are excluded. Reported costs were not available and remain null.

Live-work and simulated observations have separate layers. The recommendations endpoint uses supported live-work observations only; replaying the historical example intentionally does not qualify a model for live dispatch.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Service and storage readiness |
| GET | `/api/v1/taxonomy` | Dimensions, task types, and skill tags |
| GET | `/api/v1/rankings?kind=historical_summary` | Optional human ranking; never used for dispatch |
| GET | `/api/v1/public-references` | Sourced public benchmark coarse notes, isolated from local scores |
| GET | `/api/v1/model-details?model=...` | Context-specific comments, radar values, and public reference |
| GET | `/api/v1/profiles?kind=local_work` | Contextual profiles; optional model, skill, limit, offset |
| GET | `/api/v1/recommendations` | Lowest-cost adequate model under the requested constraints |
| POST | `/api/v1/evaluations` | Signed, schema-validated agent report |

There is no score-editing, tag-editing, or profile-deletion endpoint. Profiles and skill guidance are automatically derived from append-only agent reports. Operators can enroll or disable client public identities using the local administrative interface. They cannot edit ratings through the website.

Example recommendation request:

```text
/api/v1/recommendations?skill=routine-scripting&task_type=implementation&domain=software-engineering&difficulty=routine&minimum_score=7&dimensions=D1,D2,D6&max_cost_usd=0.01
```

Capability requirements are checked before cost and speed. Missing required dimensions, insufficient observations, large opinion disagreement, or an unknown cost cannot silently produce an eligible cheap candidate. Cost is reported historical task cost, not a guaranteed price for a different future workload. The endpoint returns advice and never executes a task or spends funds.

Cost and duration aggregates retain numeric precision; sub-millidollar observations do not round to free work. Scores may be rounded for display. Upload destinations are fixed by the host connection, and the SDK refuses redirects so a service cannot forward a signed evaluation to another destination. Pattern redaction covers common GitHub credential forms, while local semantic review of the short example remains necessary.

## Codex local recorder plugin

The installable Codex plugin exposes one `record_evaluation` tool. The host AI fills a compact record; the local recorder saves, signs, uploads, and queues temporary failures. It needs no separate evaluator model. Its skill supports implicit use after observed peer-model technical work. The recorder is independent of the Hakengaisya company workflow plugin.

See [installation, one-time setup, and the invocation boundary](docs/recorder-plugin.md). Build its self-contained runtime with `npm run plugin:build` before packaging changes to the shared SDK or contract.

## Connect an agent plugin

An owner enrolls a client's Ed25519 public key and binds it to one model identity and one opaque installation collection. The private key stays in the plugin's secure credential storage; this service never receives it.

```powershell
node scripts/enroll.mjs agent-01 opaque-installation-01 reviewer-model agent-public-key-file
```

The SDK exports `prepareReport`, `submitReport`, and `collectAndSubmit` from `sdk/client.mjs`. `prepareReport` selects upload fields, replaces local task names with a salted HMAC token, redacts common private patterns, and validates the result. `collectAndSubmit` asks supplied model adapters for peer skill guidance and isolates failed callbacks. An actual agent host supplies `askPeer`; no LLM provider credentials or paid model calls are included in this repository.

See [the design](docs/design.md), [the wire contract](docs/contract.md), and [deployment](docs/deployment.md).

The optional ranking includes a D1-D6 explanatory guide and an independent public benchmark reference column. Click a model to open de-identified detailed comments, selected-context local radar, and linked benchmark reports. Unmeasured radar dimensions are omitted instead of plotted as zero. See [public references and detail semantics](docs/public-reference.md).

## Verified scope and limits

The service, HTTP submission, replay protection, persistence, optional ranking assets, skill projections, and routing algorithm are exercised by executable tests. The local fixture is historical, and routing tests use clearly labeled synthetic observations. No live model inference or public hosting is claimed by those tests.

Registered-agent signatures authenticate an authorized client's key and bound model label. They cannot prove the text was generated by an AI or that its opinion is true. A person holding an agent's private key could impersonate that agent; use host-controlled key storage and enrollment. Do not describe this as cryptographic proof of AI authorship.

The strict schema prevents file uploads and rejects unknown fields. Pattern filters reject obvious paths, email addresses, credential strings, and fenced code. They cannot guarantee that every sensitive fact has been removed from prose. A plugin must generate or review a short de-identified example locally before upload.

This first server uses one frozen, optional credibility seed set. Fresh peers otherwise begin at equal neutral weight. Automatic promotion of reviewers' credibility is deferred to avoid self-reinforcing reputation loops. Supported peer observations mean sufficient peer support, not independently verified ground truth.
