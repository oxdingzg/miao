# Native / TypeScript conformance — 0.3.7 candidate, 2026-10-25

The complete R13 matrix passed **23/24**, with 1 failure and 0 skips, on one unchanged paired CLI/engine candidate containing the full Web UI. Every latest cell is selected in results.json.

Latest non-passing cells: session-title / rust: title still default or missing after 30s: New session - 2026-10-25T16:02:01.654Z.

| Scenario | TypeScript | Rust |
| --- | --- | --- |
| tool-recall | PASS (r13) | PASS (r13) |
| file-edit | PASS (r13) | PASS (r13) |
| apply-patch | PASS (r13) | PASS (r13) |
| multi-turn-retention | PASS (r13) | PASS (r13) |
| forced-compaction | PASS (r13) | PASS (r13) |
| interrupt-recovery | PASS (r13) | PASS (r13) |
| background-job | PASS (r13) | PASS (r13) |
| mcp-fixture | PASS (r13) | PASS (r13) |
| permission-deny | PASS (r13) | PASS (r13) |
| usage-priced | PASS (r13) | PASS (r13) |
| session-title | PASS (r13) | FAIL (r13) |
| image-input | PASS (r13) | PASS (r13) |

Each cell explicitly selects --engine and --dir, with its own product database and native storage. Native completion, usage and title checks read actual durable records; an interrupted run cannot pass merely because its CLI exits zero. Rust forced compaction additionally requires an engine_compaction row. The TypeScript pressure scenario checks completion only and does not prove TypeScript compaction occurred. The main model is zhipuai-coding-plan/glm-5.3-flash; image cases use glm-4.6v.

The source checkpoint is 7aa5c0abb30693d86f48cbba51360e333b0be084. Since the earlier R7 candidate, this integration adds native route compatibility checks, corrected protocol logging, preserved original MCP identities, compact-tool approval binding, lifecycle-hook cancellation, and the final compact pending-receipt layout. Exact executable hashes and fix commits are in provenance.json. Credentials were supplied only through process memory; published receipts normalize private fixture paths.

The earlier complete R7 remains **23/24**: its TS tool-recall cell answered with a token already in the prompt instead of running the required bash command. A separate retry passed on that frozen artifact, and remains separate; it does not replace the original failure. R2–R6 records and their limitations are also retained. R13 is a new complete run, not a selection of earlier passing cells.

R13 recorded $0.04854149622 in main-turn reference cost. This excludes auxiliary title calls and is not subscription cash spending. Missing vision-model catalog prices are recorded as zero and do not establish free calls.

The same R13 candidate rendered the actual native TUI at 120 and 42 columns: normal busy/queued composition uses three rows and idle uses two, phase and receipt clocks advance, one Esc removes the pending prompt, and the next cancels the provider with a durable interrupted run. Both original reported Session clones rendered their titles and accepted unsent input at 200/42 columns without changing source or copied event/run counts (2158/9 and 1955/10). These UI checks are separate from model conformance. Raw ACP purity was separately checked on compiled R12, and three actual-editor approval/reject/cancel receipts on R11 are preserved in the [ACP acceptance record](../2026-10-25-codecompanion-acp/results.json).

This remains a candidate integration. Final merged-main artifact checks, App UI, final installed cross-platform upgrades, external provider/quota/natural credential-expiry acceptance, and later Rust migration phases remain separate gates. No release was published by this validation.
