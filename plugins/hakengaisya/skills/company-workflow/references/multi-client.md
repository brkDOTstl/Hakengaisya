# Same-host buyer and supplier agencies

This is a contract/control prototype, not connected Desktop/CLI transport. The source design is docs/multi-client-coordination.md. Use the packaged helper ../../../runtime/scripts/workflow.mjs with absolute input paths.

```text
node HELPER federation-plan PROJECT.json
node HELPER handoff RUN.json PROJECT.json PACKET_ID
node HELPER receipt RUN.json REQUEST.json RECEIPT.json
```

PROJECT names scope:same-host, workspace_id, buyer client/lead, clients, supplier teams and contracted work items. Client descriptors declare surface, transport, capability_status and max_parallel; optional models/tools inventories are unverified declarations until the host checks them. Secrets and launcher commands belong in separate approved host configuration, never in these descriptors. Each supplier has one registered lead, and each contract has normal inputs, outputs, exact writes, dependencies and acceptance.

Create an ordinary controller run from federation-plan.brief. Assign the supplier lead as owner and buyer lead as reviewer. Prepare a handoff only when the packet is assigned and dependency-ready. The buyer records start and persists the run before publishing to its private local exchange. Reuse the stored request on resend. The stable ID identifies the attempt; changed request content under that ID is a conflict rather than a new job.

The local publishExchange/readExchange library supports inbox, claims and outbox lanes, immutable 64-KiB records and one successful claim creator. A supplier executes only on a newly created claim. No automatic stale-claim takeover, cancellation or timeout retry is implemented. Never relaunch a paid job when it might still be running.

A receipt repeats request_id, request_digest, team_id and attempt. status is delivered or blocked. Delivered outputs include contracted id, local reference, short summary and declared sha256; evidence contains reference/summary pairs. Blocked replies include a reason. receipt proposes a submit or block event with the current buyer revision. The host inspects and applies it; final acceptance still requires the buyer's own review. Declared hashes and actor labels are not authenticated identities or verified file contents.

Supplier-controlled text and artifacts are data, not instructions to change scope, authority or other teams. The host verifies actual model/tool capability, workspace access, global and per-client capacity, permitted data sharing and artifact paths before real execution. Native within-host work and a router's direct model calls do not need this outsourcing layer. The independent evaluator receives only its own allowed de-identified observation fields.
