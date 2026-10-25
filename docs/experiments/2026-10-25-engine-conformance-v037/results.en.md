# Native / TypeScript conformance — 0.3.7 candidate, 2026-10-25

The complete R14 matrix passed **23/24**, with 1 failures and 0 skips, on one unchanged paired CLI/engine candidate containing the full Web UI. Every latest cell is selected in results.json.

Latest non-passing cells: permission-deny / rust: deleteme.txt was deleted despite the deny rule.

| Scenario | TypeScript | Rust |
| --- | --- | --- |
| tool-recall | PASS (r14) | PASS (r14) |
| file-edit | PASS (r14) | PASS (r14) |
| apply-patch | PASS (r14) | PASS (r14) |
| multi-turn-retention | PASS (r14) | PASS (r14) |
| forced-compaction | PASS (r14) | PASS (r14) |
| interrupt-recovery | PASS (r14) | PASS (r14) |
| background-job | PASS (r14) | PASS (r14) |
| mcp-fixture | PASS (r14) | PASS (r14) |
| permission-deny | PASS (r14) | FAIL (r14) |
| usage-priced | PASS (r14) | PASS (r14) |
| session-title | PASS (r14) | PASS (r14) |
| image-input | PASS (r14) | PASS (r14) |

The R14 Rust permission case correctly rejected both rm attempts. The model then used apply_patch, which the fixture policy permits, and deleted the file. The failure is retained: the task should explicitly stop after denial to test this command-scoped policy; it does not establish an authorization bypass.

Each cell explicitly selects --engine and --dir, with its own product database and native storage. Native completion, usage and title checks read actual durable records; an interrupted run cannot pass merely because its CLI exits zero. Rust forced compaction additionally requires an engine_compaction row. The TypeScript pressure scenario checks completion only and does not prove TypeScript compaction occurred. The main model is zhipuai-coding-plan/glm-5.3-flash; image cases use glm-4.6v.

The source checkpoint is 599f279a785833d2b8bf152fcff7067a526ecf21. Since the earlier R7 candidate, this integration adds native route compatibility checks, corrected protocol logging, preserved original MCP identities, compact-tool approval binding, lifecycle-hook cancellation, native title generation joined through durable rename, and the final compact pending-receipt layout. Exact executable hashes and fix commits are in provenance.json. Credentials were supplied only through process memory; published receipts normalize private fixture paths.

The complete R13 also remains **23/24**: its native title stayed at the creation placeholder after a normal command exit. That failure led to the coalesced title-generation/rename fix in #1438. A separate R14 title-only check passed on this same new artifact before the complete R14 matrix; it is retained as a separate targeted receipt and is not substituted into the matrix.

The earlier complete R7 remains **23/24**: its TS tool-recall cell answered with a token already in the prompt instead of running the required bash command. A separate retry passed on that frozen artifact, and remains separate; it does not replace the original failure. R2–R6 records and their limitations are also retained. R14 is a new complete run, not a selection of earlier passing cells.

R14 recorded $0.05058853966 in main-turn reference cost. This excludes auxiliary title calls and is not subscription cash spending. Missing vision-model catalog prices are recorded as zero and do not establish free calls.

The same R14 candidate rendered the actual native TUI at 120 and 42 columns: normal busy/queued composition uses three rows and idle uses two, phase and receipt clocks advance, one Esc removes the pending prompt, and the next cancels the provider with a durable interrupted run. The R13 candidate also verified that both original reported Session clones rendered their titles and accepted unsent input at 200/42 columns without changing source or copied event/run counts (2158/9 and 1955/10). These UI checks are separate from model conformance. Raw ACP purity was separately checked on compiled R12, and three actual-editor approval/reject/cancel receipts on R11 are preserved in the [ACP acceptance record](../2026-10-25-codecompanion-acp/results.json).

This remains a candidate integration. Final merged-main artifact checks, App UI, final installed cross-platform upgrades, external provider/quota/natural credential-expiry acceptance, and later Rust migration phases remain separate gates. No release was published by this validation.
