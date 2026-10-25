# Native / TypeScript conformance — 0.3.7 candidate, 2026-10-25

The latest complete run, R7, passed **23/24** on one unchanged paired CLI/engine artifact containing the full Web UI. The failing TypeScript tool-recall cell returned the token already supplied in its prompt without executing the required bash command. Its command exited normally; the missing tool execution remains a failure. This is not a 24/24 result.

| Scenario             | TypeScript | Rust      |
| -------------------- | ---------- | --------- |
| tool-recall          | FAIL (r7)  | PASS (r7) |
| file-edit            | PASS (r7)  | PASS (r7) |
| apply-patch          | PASS (r7)  | PASS (r7) |
| multi-turn-retention | PASS (r7)  | PASS (r7) |
| forced-compaction    | PASS (r7)  | PASS (r7) |
| interrupt-recovery   | PASS (r7)  | PASS (r7) |
| background-job       | PASS (r7)  | PASS (r7) |
| mcp-fixture          | PASS (r7)  | PASS (r7) |
| permission-deny      | PASS (r7)  | PASS (r7) |
| usage-priced         | PASS (r7)  | PASS (r7) |
| session-title        | PASS (r7)  | PASS (r7) |
| image-input          | PASS (r7)  | PASS (r7) |

Both engines passed file editing, patch application, multi-turn retention, interruption recovery, background jobs, MCP, permission denial, priced usage, title persistence and image input. Rust forced compaction recorded one durable engine_compaction row. The TypeScript compaction cell checks completion only and does not prove a TypeScript compaction occurred. No process stall or crash was observed in this matrix.

Each cell used an explicit engine and --dir, an isolated product database and native storage. The host and engine both reported 0.3.7. Credentials were supplied only in process memory. The harness checks native durable completion and actual usage/title storage; interrupted runs cannot pass merely because the CLI exits zero. Main cells used zhipuai-coding-plan/glm-5.3-flash; image cells used glm-4.6v. The source checkpoint and executable hashes are in provenance.json.

R2 previously passed 22/24. Its two product defects—explicit native context limits being overwritten and headless TypeScript title work ending too early—were fixed in #1422 and #1423 and passed targeted R3–R5 verification. Both now pass in the full R7 run. R2–R5 and the earlier selected passing receipts remain under runs; results.json now selects every latest R7 result, including the failure. This avoids hiding a later failure behind an earlier passing receipt.

R7 recorded $0.05362252294 in main-turn reference cost. R2–R5 recorded $0.05987445618. These exclude auxiliary title calls and are not subscription cash charges. Missing vision-model catalog prices are zero, which does not establish a free call. R6 was aborted after a harness setup mistake pinned the raw zero-rate catalog and bypassed the normal pricing overlay; its abort record is retained and it is not counted as complete acceptance.

The R7 binary includes the paired-engine build change #1425 and concurrent native-create fix #1426. The full Web UI built and the compiled TUI prompt rendered at 120 and 42 columns. Model conformance does not replace App UI checks, final main integration, final installed-artifact validation, or cross-platform upgrade acceptance. The separately discovered route-schema capability decoding issue also remains outside this frozen R7 artifact. No release was published. External editor/provider/credential acceptance and later Rust migration phases are not completed by this matrix.
