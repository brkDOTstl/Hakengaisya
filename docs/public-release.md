# Public suite boundary

The public repository contains the Hakengaisya workflow plugin and the independently usable evaluator under packages/evaluator. The root Codex marketplace offers each plugin separately. Publishing source does not install either plugin or deploy an online evaluator service.

Both packages are MIT licensed. The evaluator was exported from the standalone project source, including its local recorder, with release fixes for small-cost precision, upload redirect refusal and broader credential pattern redaction. Its existing private repository and Git history are not copied into this suite.

The public package excludes original local chart imports, staff registry, raw feedback, run transcripts, generated private wiki, SQLite databases, recorder credentials and salts. Those files remain local. The evaluator's included historical fixture consists of de-identified summaries and is explicitly separated from live-work eligibility. New installations use neutral reviewer credibility unless an operator explicitly selects the historical seed.

The root npm test command runs workflow and evaluator tests. npm run plugin:build stages both self-contained plugin runtimes. npm run audit examines the intended Git publication set for prohibited runtime files and obvious credentials or personal home paths. Pattern checks do not establish semantic anonymity; short evaluation examples still need local review before upload.

Verified publication checks include local tests, a clean checkout rebuild, privacy audits, structural template inspection and source/runtime consistency. GitHub Actions runs the same suite on Windows and Linux. Only completed remote checks establish those runner results. Installed-plugin automatic invocation, actual model identity attestation, real-project cost savings and hosted service operation remain separate evidence.
