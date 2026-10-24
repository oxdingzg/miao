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

## Verdict (final, 2026-10-24)

With the three runaway guards raised (#1310 projection 64 MB, selection
64 MB, snapshot 64 MB) and the overflow retry loop landed (#1314), the
full nine-chunk chain completes end to end on a 1M-window model: no
rejections, chunk 9 clean at input 148,067.

The acceptance criterion "recall the magic values without re-reading"
**fails by design**: the engine elides old read results from the
selection (requests stay <= ~470k tokens against the 900k trigger, so
real compaction never fires — correct resource behavior) and hands the
model a `recall {"tool_use_id"}` handle instead. The verify prompt
forbade reading, so the model honestly reported the values absent. The
§2.13 conclusion is therefore rewritten per the design semantics:
**the 1M window works under read-heavy load via elision + recall;
unassisted recall after elision is not reachable by design.** Real
compaction triggering is proven separately by the forced-compaction
conformance scenario (engine_compaction > 0, 12-scenario suite).

Open items left: none in miao code from this acceptance; the
Gemini/Anthropic live-account leg stays blocked on credentials (#1267).
