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
