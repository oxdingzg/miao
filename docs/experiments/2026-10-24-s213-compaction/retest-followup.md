# §2.13 re-test follow-up — 2026-10-24

Re-run of the 1M-window acceptance after #1302 (budget derivation fix), on
current main with a locally built engine (0.2.25 + projection-limit raise +
response dump). Harness: `/tmp/s213-run9.sh` — nine ~520 KB fill chunks
(read-heavy, ~1.2M tokens of accumulated read results across the session),
`zhipuai-coding-plan/glm-5.3-flash`, per-chunk `miao run --continue`.

## What the re-run established

1. **The stale-binary artifact is closed.** The earlier "~46k elision ceiling"
   came from a pinned experiment worktree predating #1294/#1302. On current
   main the derived budget reaches the engine: fresh-run engine args carry
   `--context-limits {"window":1000000,"ratio":0.9,"headroom":62048,"perPass":8}`.
2. **Large context is carried.** Chunk 7's request sent `input: 473,183` with
   `cache.read: 471,616` — the 1M window is real and prefix caching works at
   that scale (the old 46k ceiling is gone).
3. **New blocker found and fixed (#1310):** at ~500k accumulated tokens the
   chain failed with `projection exceeds snapshot/fork limit` — the
   snapshot/fork projection was hard-capped at 2 MB / 1000 messages, below any
   legitimate 1M-token session. Raised to 64 MB / 20k messages (#1310).
4. **Remaining open item (design, not a regression):** with ~1.2M tokens of
   accumulated read results, selection exceeds the 900k trigger and the engine
   refuses the request with `selected history exceeds budget; compact at a
   closed boundary` — but the run path has no "close the boundary → run
   compaction → retry" loop, so the chain fails instead of compacting. Fix
   direction: the product runner catches this ConflictError, closes the turn
   boundary, runs a compaction pass and retries once. Per the earlier finding,
   silently eliding instead (the 0.2.25 behavior) is what produced the
   original mid-content recall failures, so the refusal itself is correct;
   what is missing is the retry loop.

## Verdict

§2.13 remains **not met** for read-heavy 1M fills until the overflow →
compact → retry loop exists; the acceptance as originally written (compaction
triggers and content survives) is otherwise satisfied at smaller budgets
(forced-compaction scenario: engine_compaction rows > 0, 12-scenario
conformance suite PASS). The budget-derivation half of the finding is fixed
(#1302); the projection-cap half is fixed (#1310); the retry loop is the one
open engineering item, with repro scripts at `/tmp/s213-run9.sh` and raw logs
`/tmp/s213-v9-c*.log`.
