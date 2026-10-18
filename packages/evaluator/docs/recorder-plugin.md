# Codex recorder plugin

This is a small local recorder, separate from the Hakengaisya workflow engine. The host AI fills one evaluation form through `record_evaluation`. The recorder signs, saves, and uploads it. The backend performs the weighted aggregation and skill-tag indexing. No extra LLM invocation, polling agent, transcript scraper, or organization planner runs inside the recorder.

## Native Codex prototype

For a prototype inside Codex, the host can delegate observation and form filling to one native subagent after peer work is available. That agent uses the same recorder. It does not start another Codex CLI process or contact a separate model provider. One completed observation produces one record; an idle polling loop is unnecessary.

The recorder itself remains a small data tool. Choosing or launching the native subagent belongs to the host workflow. A direct native-agent submission verifies the recording flow, while installed-plugin discovery in a fresh conversation remains a separate check. Synthetic flow tests use a dedicated fixture identity and the `simulation` evidence layer; their scores never qualify a real model for dispatch.

On 2026-10-10, a native Codex subagent reviewed a synthetic arithmetic implementation, filled one form, and submitted it through the existing Recorder class to the local service. The service returned `accepted`; readback contained both submitted skill tags, the observed D2 score, and null values for unobserved dimensions. The test used a synthetic reviewer label, made no external model invocation, and did not verify automatic discovery of the installed MCP tool.

## Install

Node.js 24 and Codex CLI with plugin support must be available on the host. The package contains a Codex compatibility manifest, one implicitly invocable skill, and one local stdio MCP tool.

```powershell
codex plugin marketplace add brkDOTstl/Hakengaisya
codex plugin add hakengaisya-evaluator@hakengaisya-suite --json
```

The public suite includes both independent plugins. For local authoring of only this package, add its directory as a local marketplace and use hakengaisya-evaluator@hakengaisya instead. Restart the host or start a fresh Codex conversation to load the installed tool and skill. The current conversation's tool inventory is not proof that a new installation was loaded.

## One-time connection

Set up a private recorder data directory and bind it to the actual host model. `scripts/setup-recorder.mjs` creates a signing key and random task salt without printing them. For an owner-operated loopback service, it can enroll the public identity against the existing local evaluator database:

```powershell
node scripts/setup-recorder.mjs --home PRIVATE-RECORDER-DIRECTORY --reviewer-model ACTUAL-HOST-MODEL --enroll-local .data/evaluator.sqlite
```

The default runtime directory is `.hakengaisya-evaluator` under the user's home directory. Alternatively set `HAKENGAISYA_RECORDER_HOME` in the host environment before launching Codex. Set the endpoint once during setup; AI tool arguments cannot redirect uploads. Remote endpoints must use HTTPS. For remote service enrollment, provide only `agent-public.json` to its operator. Private keys and salts stay local.

Keys are stored as files in the private recorder directory, with restrictive requested file modes. Windows installations also rely on the directory's user-profile ACLs; this is not an encrypted credential vault. Never put this directory into a plugin package or a Git repository. Switching the reviewer model requires a newly bound identity, not silently relabeling an existing client.

## Ordinary use

The AI supplies the observed peer model, technical task type, difficulty, skill tags, observed dimension scores, comment, short de-identified example, and useful guidance. Unobserved scores and unknown costs remain null. Optional `task_ref` and `record_id` make retries stable.

The recorder saves only the selected and sanitized report. It never scans project files or reads chat transcripts. A successful upload returns `accepted`. A temporary outage leaves the record `queued`; pending records retry when the recorder is next used. Permanent server rejections are retained separately and reported as `rejected`. Local saving is not a server acceptance claim.

`allow_implicit_invocation: true` and the skill's description make the workflow available for Codex to select after observed peer work. This is model-driven use, not an enforced lifecycle hook or a guarantee that every task will cause an upload. No peer observations means no invented evaluation. The plugin never evaluates its own configured model.

## Suite boundary

- **Hakengaisya-evaluator:** record skill feedback, upload minimal data, aggregate capability and task-fit tags.
- **Hakengaisya:** design the organization topology, structure work, assign responsibilities, control progress, perform independent audits, and produce the implementation and final delivery.

Neither package requires the other to run. The company workflow can consume the evaluator's API, while other AI hosts can install the recorder independently.

## Official host references

- [OpenAI plugin packaging and marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Codex skill invocation policy](https://learn.chatgpt.com/docs/build-skills)

Host-format documentation was checked on 2026-10-10. Installing a discoverable package, loading its tool, observing a model call, and receiving server acceptance are separate checks; report only the checks actually completed.
