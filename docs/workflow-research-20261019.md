# Workflow research and adaptations

Reviewed on 2026-10-19 for the Hakengaisya 0.6 local prototype. The engineering goal is faster correct delivery at an appropriate model cost. Human organization examples and public agent patterns inform design choices; they do not prove that this implementation saves money or time.

Version0.7 correction: these reference patterns operate inside explicit superior-subordinate relationships. A task router or generic independent reviewer does not define Hakengaisya's authority model. Each direct supervisor owns dispatch and acceptance of its scope and submits its own delivery upward. See [the supervision contract](../plugins/hakengaisya/skills/company-workflow/references/supervision.md). This constraint takes precedence over flattening the organization for cost alone.

## Sources and decisions

| Primary source | Relevant practice | Hakengaisya adaptation and status |
| --- | --- | --- |
| [Team Topologies key concepts](https://teamtopologies.com/key-concepts) and [interaction-mode clarification](https://teamtopologies.com/news-blogs-newsletters/2025/2/21/team-topologies-interaction-modes-breaking-through-common-misconceptions) | Distinguish stable service consumption from temporary close collaboration or focused help. Cognitive load and flow matter more than reporting lines. | The skill offers coherent-owner, parallel-cell and temporary-specialist patterns with explicit output and exit criteria. These are relationships, not mandatory departments. Pattern choice remains host judgment. |
| [Basecamp Shape Up: Decide When to Stop](https://basecamp.com/shapeup/3.5-chapter-14) | A fixed appetite and circuit breaker force scope decisions rather than automatic extensions; unresolved uncertainty differs from remaining execution. | Keep retry/dispatch ceilings and renewed fit after rejection. A blocked unknown returns to planning rather than an unlimited cheap-worker loop. No six-week cadence, extra approval committee or automatic user-scope reduction is copied. Existing controller rules are retained. |
| [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Compose routing, parallel work and orchestrator-worker patterns; additional agent complexity trades cost/latency for quality. The article is an older conceptual reference, not current API configuration guidance. | Intake stays small. Planning compares smaller feasible worker pools and accounts for startup and handoff overhead. More workers need useful schedule gain within a cost premium or a feasible deadline. The search is greedy advice, not optimality proof. Implemented in lib/planning.ts. |
| [LangGraph workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents#orchestrator-worker) | An orchestrator can derive work dynamically and send each worker specific inputs and separate state before synthesizing results. | dispatch and review generate local scoped contracts from accepted dependencies and the current attempt. Unrelated history and the full journal are excluded. next distinguishes backlog from a startable capacity-safe batch. Implemented in lib/dispatch.ts and lib/workflow.ts; native execution stays with the host. |
| [LangGraph supervisor source](https://github.com/langchain-ai/langgraph-supervisor-py) | The README recommends direct tool-based supervision for most cases and documents control over how much worker history is retained. The repository is archived as of this review. | Borrow the context-boundary idea only. Do not add a library dependency or assume more supervisor levels improve work. The helper keeps evidence references and result criteria; the host still inspects actual files and behavior. |
| [Original oh-my-openagent reference](https://github.com/code-yeongyu/oh-my-openagent) | The current repository describes a broader OmO product with graph-based and multi-model work, beyond the earlier prototype reference. | Retain it as an architectural comparison. Do not import its installer, provider configuration, current feature set or unverified performance claims. Hakengaisya remains a small independent native-host workflow. |

## Implemented planning changes

Per-unit review/handoff overhead and one-time context startup are separate inputs. Startup is charged once per actual context, including route aliases, in its first work slot. If existing observed costs already include startup, do not add it again. Missing startup data stays unknown; estimates cannot certify a budget or deadline without the required inputs.

The planner tries all pool caps through eight and samples larger configured pools geometrically. It filters inadequate routes first, compares feasible totals under the configured premium, then favors a smaller adequate pool unless extra capacity saves more than the configured minimum useful time. A deadline can rule out a smaller pool. Larger pools can still be required for different skills or independent review even without simultaneous execution.

The controller uses the selected plan's useful concurrency rather than theoretical graph width. The next snapshot proposes a batch that fits current capacity, owner identity, write boundaries and retry limits. This read-only snapshot is not a lock or reservation; the host records starts and refreshes readiness after changes.

## Verification and remaining evidence

Regression tests cover startup once per context, aliases, small-versus-large staffing choices, deadline/budget tradeoffs, unknown estimates, coherent handoff inputs, capacity-safe dispatch, independent current-result review, retries and relocated packaged CLI use. Synthetic examples explicitly declare synthetic startup assumptions; these values are not provider prices.

The comparison demo under runs/optimization-20261019-01 records constructed planner scenarios. It exercises real local code without calling models. This is algorithm and integration evidence, not a measured production speedup, token saving or billing result. No new agent company is launched to conduct this optimization.

Revisit semantic decomposition quality, measured startup/handoff distributions and re-planning from actual work telemetry after a suitable real task. Automatic plugin invocation, provider billing, live Jev classification and host-enforced filesystem isolation remain separate integration checks.
