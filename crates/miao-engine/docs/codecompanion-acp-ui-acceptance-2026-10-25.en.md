# CodeCompanion ACP UI acceptance — 2026-10-25

The second actual editor has passing candidate receipts: Neovim 0.12.6 with CodeCompanion 20.0.1 connected to the product `miao acp` entry point, backed by the Rust engine. Three ordered UI interactions passed on one unchanged 0.3.7 integration artifact. The test used CodeCompanion's real approval UI and normal-mode keys; it did not substitute an ACP SDK test client or inject permission replies.

| Interaction | Actual UI action | Structural result | ACP / durable result |
| --- | --- | --- | --- |
| Allow once | `g2` Accept after Approval Required appeared | `allowed.txt` was absent before approval, then contained exactly `approved` | selected `once`; `end_turn`; native run `completed` |
| Reject | `g3` Reject after Approval Required appeared | `denied.txt` remained absent | selected `reject`; `end_turn`; native run `completed` |
| Cancel | `q` while an open-ended response was streaming | The upstream stream received cancellation | actual `session/cancel`; `cancelled`; native run `interrupted` |

Each chat was opened through CodeCompanion's chat API and driven using its actual UI key mappings. The model was a controlled loopback fixture that requested one workspace command or kept its response open. No real provider credential was used. Neovim ran with isolated HOME/XDG directories, product database, native storage and workspace.

After `:qa!`, every test-owned editor, product agent and engine process had exited. No native run remained running. The fixture provider was then stopped after its PID and working directory were verified. Other sessions and processes were left alone.

[Machine-readable results and hashes](../../../docs/experiments/2026-10-25-codecompanion-acp/results.json), [UI captures](../../../docs/experiments/2026-10-25-codecompanion-acp/ui/allow-before.txt), [wire receipts](../../../docs/experiments/2026-10-25-codecompanion-acp/raw/allow.agent.jsonl), and [teardown](../../../docs/experiments/2026-10-25-codecompanion-acp/teardown.json) retain the observations with fixture paths normalized. The source checkpoint was `95fc78a62a`; CodeCompanion commit `142eadffdaa8dd06060646b6f8ef74e99c42ab06` and plenary commit `74b06c6c75e4eeb3108ec01852001636d85a932b` are recorded.

Earlier attempts are retained separately. One fixture mixed V1 permissions with V2 providers and failed model selection; it was corrected to pure V2. Another approval expired at the existing 60-second policy deadline before the action was taken, so the command did not execute. Neither attempt is counted as a pass. The selected three-case run verified prompt accept, reject and cancellation actions.

This is automated interaction with a real editor on a candidate integration build. It does not replace final merged-artifact verification, real-provider/quota/credential-expiry acceptance, or the remaining Rust migration phases. It does not claim another human click-through or publish a release.

The earlier R10 artifact completed the three UI actions but failed strict protocol validation: background title diagnostics appeared on ACP stdout. Those raw bytes are retained as `.stdout.txt`, not valid JSONL. The selected R11 artifact includes the logging-boundary fix from PR #1431; all 25 agent frames across the three reruns are valid JSON-RPC, and teardown again found no owned processes or running native tasks.
