# Hakengaisya optimizer

Optional local Harness2 worker and typed workflow adapter. The main workflow and independent evaluator remain usable without Python or the upstream dependency.

The bridge imports Google Research Harness2 0.1.0 at revision 1cfe254e8d25b15f37048c3730134686abe60335. The upstream Apache-2.0 source is installed separately; no upstream implementation or benchmark dataset is bundled here. Hakengaisya supplies the native-host transport, protected contract, call ceiling and direct-supervisor adoption gate. See [the integration contract](../../docs/harness2-integration.md).

This increment prepares immutable task-scoped jobs, runs the real Propose-Probe-Compose core through local request/response files and retains reviewed experience as experiment reference material. It does not promote a default production profile, change live instructions, modify model weights or upload local records. Versioned profile selection, held-out promotion/rollback, start/status/cancel lifecycle tools and real-model execution validation remain tracked in O01-O08.

The shared workflow command table exposes optimizer_job and optimizer_result to MCP and maps them to harness2-job and harness2-result in the CLI. Both handlers are short and read-only; the separate Python worker performs experiment orchestration outside the run-file lock. The worker never launches a model or provider client. Normal event submission and technical acceptance still use the ordinary controller.
