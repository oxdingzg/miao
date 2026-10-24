# 2026-10-24 §2.13 real compaction on a 1M window (acceptance: NOT met — compaction never fired; it was elision)

Owner-authorized §2.13 measurement: model `zhipuai-coding-plan/glm-5.3-flash` (catalog context = 1,000,000), run path (`MIAO_ENGINE_STORAGE` native placement). Six ~600KB (≈150k token) user prompts were injected into one session via a `--continue` chain to cross the real compaction trigger; magic markers were placed at the midpoints of segments 1/3/5/6 with a no-tools post-compaction recall assertion.

## Result: acceptance NOT met — and a more valuable fact surfaced

1. **Real compaction never fired**: after filling to ~450k tokens (chunk3's request input = 160,573), the `engine_compaction` table had **0 rows** — under the default budget the engine's behavior is **elision** (the effective window is truncated to ~160k tokens), not summary-compaction. The verify turn's input (159,712) matches that window.
2. **The 1M window is fiction on the run path**: the catalog says 1M but the engine's effective window is ≈160k — the budget derives neither from the model limit nor from the compaction settings (`compaction.threshold=300000` under `MIAO_CONFIG_DIR` decodes correctly via `compactionSettings`). Root cause is the same as the $0 pricing: **the run path does not compose the NativeEngine layer** (issue #1285).
3. **Elision boundary**: post-compaction no-tools recall of the two mid-segment magics failed — elided prompt content cannot be recovered (the restore note points at files; these facts were buried in prompts, with no file to re-read). The session itself continued stably (no crash, no duplicate messages).
4. Fill-method finding: read-tool volume **cannot** trigger compaction — the engine elides read results proactively (3.7MB of reads kept the input peak at 46k, first round); only user-prompt volume pushes the context up.

## Evidence

- `input-curve.csv`: per-request input tokens for the four chunks + verify (chunk3: 160,573; verify: 159,712).
- `engine_compaction.rows0.txt`: the engine DB's `engine_compaction` row count after the run = 0.
- `codes2.txt`/`codes3.txt`: every magic value for both rounds; the v6 verify reply contains none of them (the recall failure, recorded positively).

## Re-test conditions (after the fix)

Once #1285 lands (the run path composes the NativeEngine layer), re-run this acceptance and expect: the compaction settings (threshold) and the model limit (1M) to reach the engine; real rows in `engine_compaction`; the #1280 restore note injected; and cross-compaction memory verified per the summary/re-read policy.

## Post-#1302 final acceptance (2026-10-24)

Re-run in this directory after #1302 (worktree at ebaf9efffa; an engine-process probe confirmed `--context-limits {"window":1000000,"ratio":0.9,"headroom":62048,"perPass":8}`, so the budget-derivation fix did reach the engine). Verdict: **BLOCKED — compaction still never fired (`engine_compaction` 0 rows), and this round surfaced a blocker more fundamental than the gateway: the engine store's 2 MiB snapshot/fork projection cap makes the 1M-window compaction trigger architecturally unreachable.**

### Execution log

Fill chain: six ~602,360-byte (≈150k token) user prompts injected into one session (`ses_gfe5e94c8e4baffezme3Vsz0du`, storage `/tmp/s213-storage7`) via the `--continue` chain.

| Request                                 | input tokens    | Outcome                                                                                                                                                                           |
| --------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chunk 1                                 | 161,012         | step_finish, normal reply                                                                                                                                                         |
| chunk 2                                 | (log lost)      | user message durably committed (seq 21, 602,391 bytes); no matching assistant reply in storage                                                                                    |
| chunk 3                                 | 463,664         | one gateway error: `{"reason":"MalformedResponse","name":"ClientError"}`; in-batch retry succeeded, step_finish                                                                   |
| chunk 4 (sweep)                         | —               | user message durably committed (seq 45, 606,791 bytes), then the engine rejected: `ConflictError: projection exceeds snapshot/fork limit`; sweep exit 1, no provider request sent |
| chunk 4 diagnostic probe (`--continue`) | 46,438 / 50,278 | attached to a stale session (see below), unrelated to the chain                                                                                                                   |
| chunk 4 retry (`--session`)             | —               | TS side reported `Session not found` (the SDK swallowed the engine's 4xx on the snapshot read)                                                                                    |
| no-reread recall verify                 | not executed    | the session cannot be resumed, so this turn was unreachable                                                                                                                       |

`engine_compaction` final count: **0 rows** (after all attempts). The no-reread MAGIC-MID-1/2 recall has no verdict because the verify turn could not run.

### Root cause: the 2 MiB snapshot/fork projection cap

- `projected()` in `crates/miao-engine/src/store.rs` hardcodes: once the projected messages exceed 2 MiB (2×1024×1024 bytes) or 1000 messages, it returns `Error::Invalid("projection exceeds snapshot/fork limit")`.
- `snapshot()` (store.rs:1023, "one read transaction captures a replay cursor and its projections") is the engine's read/resume path; `fork` (store.rs:1145) uses the same projection.
- The chain session's 6 messages total **2,419,737 bytes > 2,097,152** (seq 5/15/21/30/39/45 = 601,060 / 2,207 / 602,391 / 605,371 / 1,917 / 606,791). Chunk 4's prompt was first persisted by durable admission and only then projected; the projection crossed the cap and was rejected — from that point the session can never be snapshotted, resumed, or forked.
- Corollary: with this engine, prompt filling tops out at ≈2 MiB of message content (≈460-500k tokens under this model's tokenizer; measured 463,664), while the 1M-window compaction trigger (window=1,000,000, ratio=0.9, headroom=62,048 — on the order of ~840k tokens ≈ 3.4 MB of prompt bytes) is hit first by the snapshot cap. **Compaction can never fire on this path**, orthogonal to #1302's budget fix.

### Operational finding: `--continue` session picking is unreliable

During the post-mortem diagnostics, `--continue` resolved to a stale 2026-10-23 session (`ses_gfe5e9663876dffexbeZZ7uFIM`, placement pointing at the old storage `/tmp/s213-storage3`, input 46,438→50,278) instead of the newest chain session in the directory (`run.ts` takes the first non-child session from `sessions.list({order:"desc",limit:50,directory})`; its sort/merge path was not traced further). Resuming the chain required an explicit `--session` — and that explicit resume is what exposed the 2 MiB blocker above.

### Verdict and re-test conditions

Verdict: **BLOCKED** (not PASS/PARTIAL: compaction never fired, mid-context memory could not be tested, and execution was stopped by an engine-side hard limit — unrelated to gateway or model). Re-test conditions: lift the `projected()` 2 MiB/1000-message projection cap or make it configurable (or segment on the admission side), keep #1302's budget derivation, then re-run the six-block fill and the no-reread recall.
