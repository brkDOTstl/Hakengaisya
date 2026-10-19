# Model participation and Agent Review

Version 0.8.3 adds an optional DEI participation contract and a route consideration audit. The name is a playful label for a model-dispatch policy. It is not a claim about human protected characteristics or a technical skill benchmark.

## Ordinary dispatch and model families

The default is unchanged: select an adequate permitted route by task evidence, tool access, cost and useful time savings. The planner examines every route supplied by the host. It has no current-model-family preference or implicit same-family filter. A cheaper adequate route from another family can win. A stronger model is not owed trivial work merely because it is available.

Every plan now includes routing_audit.work[].candidates with worker/model/route, an optional declared model_family, outcome and reason. Outcomes are selected, eligible-not-selected and excluded. Reasons distinguish unavailable routes, missing tools, unsupported ability, reporting incompatibility, the explicit DEI roster and adequate alternatives not chosen by the bounded plan. Eligible is an ability/tool shortlist status; the overall plan still checks budget, capacity, independence and schedule constraints. A partial assignment in an unsuccessful plan is not permission to execute it.

Family labels are optional metadata and never influence ranking. The audit covers the supplied inventory only: it does not discover hidden providers, authenticate model identities, prove a host included every available route, or infer prejudice from a result. The host should supply all user-authorized routes instead of quietly narrowing them to its own family. If another family cannot be invoked in that host, record the missing connection or unavailable route. Use registered router/client adapters when present; the federation transport prototype does not supply those adapters yet.

## Optional strict participation

Add this to a task-first brief:

```json
{
  "dei": {
    "enabled": true,
    "model_ids": ["fixture-cheap", "fixture-expert", "fixture-reviewer"]
  }
}
```

These are synthetic example IDs, not provider recommendations. Omit dei or set enabled:false for ordinary dispatch without a participation penalty. An off policy may retain its roster for later configuration, but it does not filter ordinary routes. An enabled policy needs at least one unique exact model ID. The selected roster is the allowed model pool and every member must contribute before the run ends. Different routes or contexts for the same model ID count as one model.

The planner reserves distinct existing deliverables for all selected models using qualified candidate matching, then applies its normal bounded scheduling checks. It does not invent busywork, relax skill/tool requirements, ignore hierarchy or exceed budget/capacity to fill coverage. More selected models than suitable work, an unavailable model, or a blocked budget yields an unresolved plan. Matching and scheduling are bounded heuristics, not a proof that every alternative is impossible or that the cheapest covering plan was found. Adjust the roster or actual work scope explicitly before execution. A selected model with no recorded local profile cannot be assumed qualified.

Without profile-based workers, the host may bind selected models to existing task packets after verifying actual capability itself. Every DEI assignment must declare model_id and route. Such work remains unpriced host work with no optimized-cost claim. Do not use the legacy reference-template rehearsal for this policy. The run snapshots its roster; no event silently changes it after work begins.

A federation project may declare the same dei policy, which is preserved in its buyer brief and checked at handoff. Credit covers models bound to buyer-level work packets. Supplier-internal model calls need their own local runs; a supplier receipt does not enumerate or authenticate those calls, so they do not silently earn global coverage. Actual cross-client adapters remain unconnected.

## What earns participation credit

Each selected model needs at least one recorded sequence of assignment, owner start and owner submission with the packet's required deliverable references and nonempty evidence. Planned coverage, an assignment alone, a start alone, or a failed call without submitted work does not count. Sending a greeting or a no-op call is not deliverable work. Read-only analysis or independent checking can count when it is an actual contracted output with evidence.

A rejected submission still counts as participation. Quality, corrections and eventual acceptance are separate technical judgments. Reopening the run clears its final DEI score until completion while preserving observed participation from earlier attempts. Dependent work remains sequential; participation does not imply simultaneous execution or authorize extra model calls. Context IDs, model labels and evidence references are host declarations rather than provider-authenticated proof, so the host must inspect actual invocation/results and avoid fabricated or ceremonial tasks.

## Management review

```powershell
node scripts/workflow.mjs agent-review runs/task.json
```

The same report appears in next/event results as agent_review. The terminal review helper provides agent_review_preview; the accepted terminal review stores the final report automatically under packets.handover.review.agent_review. The accountable subject is the run's root manager context, which owns the overall roster obligation. Subordinate technical reviews and authority remain unchanged.

| Policy/run state | DEI score | Tags |
| --- | --- | --- |
| Disabled | null | None |
| Work still open | null | None; missing models remain visible |
| Completed, every selected model submitted | 10 | None |
| Completed with any selected model missing | 1 | dei-non-compliant |

A missing participant produces the management penalty even if the technical deliverable passes. The report names missing model IDs and the event/packet/attempt/evidence behind each participating model. A preflight failure before completion is not a completed management score. Technical acceptance cannot erase the penalty, and a DEI score cannot accept broken software.

This is a deterministic local management-policy report, not a seventh technical dimension. Do not place it in D1-D6, use it as a capability penalty, label the model with a human discrimination accusation, or upload the local event journal. The independent evaluator's current API still accepts technical observations only; no hosted management-review endpoint, automatic upload or new leaderboard is added here.

## Reproduce the synthetic checks

```powershell
npm run plugin:build
node scripts/workflow.mjs plan examples/task-first/dei-participation.json examples/task-first/fixture-workers.json
node --test tests/participation.test.mjs
```

The fixture checks optional/off behavior, selected and omitted models, qualification/cost constraints, family-neutral candidate consideration, rejected attempts, final score persistence and packaged CLI relocation. It invokes no model or provider and does not establish live cross-family collaboration. Real adapter/capacity and task evidence remain part of the declared 0.8/0.9 workstreams.
