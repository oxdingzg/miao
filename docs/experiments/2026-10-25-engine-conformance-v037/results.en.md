# Native / TypeScript conformance — 0.3.7 candidate, 2026-10-25

All 24 cells have a passing receipt: the complete R2 run passed 22/24, then each failing cell passed against its compiled fix in R3 and R4. This is a full run plus targeted fix verification, not a single unchanged binary passing all 24 cells.

Each cell used an explicit engine, its own `--dir` workspace, its own product database and native storage. The host and engine both reported 0.3.7. The existing provider credential was passed only in the test process environment; it was not copied into the evidence. The harness checks native durable completion, actual native usage/title storage, and the requested Session's compaction rows. A failed or interrupted native run cannot pass merely because the CLI exits zero.

| Scenario | TypeScript | Rust |
| --- | --- | --- |
| tool-recall | PASS (r2) | PASS (r2) |
| file-edit | PASS (r2) | PASS (r2) |
| apply-patch | PASS (r2) | PASS (r2) |
| multi-turn-retention | PASS (r2) | PASS (r2) |
| forced-compaction | PASS (r2) | PASS (r3) |
| interrupt-recovery | PASS (r2) | PASS (r2) |
| background-job | PASS (r2) | PASS (r2) |
| mcp-fixture | PASS (r2) | PASS (r2) |
| permission-deny | PASS (r2) | PASS (r2) |
| usage-priced | PASS (r2) | PASS (r2) |
| session-title | PASS (r4) | PASS (r2) |
| image-input | PASS (r2) | PASS (r2) |

R2 used `zhipuai-coding-plan/glm-5.3-flash`; the image pair used `glm-4.6v`. R2's two failures remain in `runs/r2`: generated routes replaced explicit native context limits, and the short TS process exited before its title settled. PR #1422 preserves explicit limits; R3 records one durable compaction row. PR #1423 lets explicit Session waiters finish that Session's pending title within a 30-second best-effort bound; R4 records the persisted title before the command exits. The TS compaction cell checks completion only; it does not prove a TypeScript compaction occurred.

`results.json` selects the latest passing receipt per cell and identifies its evidence run. Each run retains redacted JSONL, stderr and per-cell assertions; `provenance.json` records source checkpoints and available executable hashes. Absolute fixture paths are normalized. The original failed assertions are preserved rather than overwritten. Total recorded main-turn reference cost across R2–R4 was $0.05819; this excludes auxiliary title calls and is not a subscription cash charge. The vision model's missing catalog prices are recorded as zero, not a measured free call.

This acceptance covers the compiled CLI and native engine, not the embedded Web UI or final release installation. Release pairing and final combined artifact verification remain separate gates. It also does not close external multi-editor, naturally expired credential, or quota-limited provider acceptance, and does not implement later Rust migration phases. R3's executable hash was not captured before replacement; its source checkpoint is retained.
