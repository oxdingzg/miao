# Engine cost benchmark — pilot (2026-10-21)

Methodology, harness, and first pilot numbers for comparing the TypeScript
and Rust (native) engines over a representative task set. The harness lives
at `script/engine-benchmark.ts`; every figure below is reproducible from it.

## Methodology

- Three tasks (bug fix, feature, refactor), each a fresh workspace of three
  files with a `bun test` verification gate; the refactor gate additionally
  greps that the duplicated computation actually moved.
- Each cell runs the task once through `miao run --format json` with
  `miao-dev` — TypeScript placement by default, Rust via `MIAO_ENGINE_STORAGE`
  — and harvests usage from the streamed `step_finish` events (turns, input /
  output / reasoning / cache-read tokens, cost, wall time).
- Best-of-N repeats per cell (N=1 in this pilot); a passing cell outranks a
  failing one, then the cheaper run wins.
- Cells are gated: `FAILED` marks a session that did not satisfy the task, so
  a cheap-but-wrong run never headlines the table.

```
bun script/engine-benchmark.ts --binary miao-dev --out report.md
```

## Pilot data (single run per cell, configured-default model)

| task | typescript | rust |
|---|---|---|
| bugfix | 5t · 16046in/330out · 15s ✓ | 6t · 69121in/622out · 16s ✓ |
| feature | 5t · 14865in/337out · 17s ✓ | 7t · 82345in/1274out · 20s ✓ |
| refactor | 5t · 15544in/649out · 22s ✓ | 2/3 runs ✓ (9-12t · 110k-156k in) |

## Findings and caveats

1. **Input-token economy differs ~4-7×.** Rust cells consumed 69k-156k input
   tokens where TypeScript consumed ~15-16k. In our runs every Rust cell
   reported `cache.read = 0`, while the TypeScript path behaved like a warm
   provider prompt cache. Leading hypothesis: the Rust route forgoes provider
   prompt-cache prefixes (or reports them differently). Verify with per-turn
   breakdowns before treating this as settled cost truth.
2. **Cost columns were unpriced.** The configured-default model has no price
   table entry in this environment, so every cell billed $0.0000. Cost
   conclusions need a priced model run (`--model provider/id`).
3. **One task-design bug surfaced by the pilot.** The first feature fixture
   asserted `sum-notes` where dropping non-ASCII yields `rsum-notes`; the Rust
   session refused to paper over the contradiction and asked for a decision
   instead of hacking either file. The expectation was corrected — the
   "failure" belonged to the task, not the engine.
4. **Refactor on Rust was 2/3 stable.** The failing run left the duplication
   in place (caught by the grep gate). N=1 per cell in this pilot; use
   `--repeat 3` for stable per-cell evidence.

## Status

This pilot is directional. The harness, task set, and gates are the
deliverable; runs with a priced model, `--repeat 3`, and a widened task set
are the follow-up before any engine-cost claim is quoted.
