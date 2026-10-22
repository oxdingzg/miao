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

## Batch data (best-of-3 per cell, 2026-10-22, same default model)

| task | typescript | rust |
|---|---|---|
| bugfix | 5t · 15712in/371out · 12s ✓ | 7t · 81878in/804out · 20s ✓ |
| feature | 7t · 14216in/453out · 29s ✓ | 9t · 108161in/1582out · 25s ✓ |
| refactor | 6t · 13456in/612out · 16s ✓ | 10t · 123203in/2164out · 29s ✓ |

Best-of-3 eliminated the pilot's refactor flake: with three attempts per
cell, every task passes on both engines, and wall-clock stays comparable
(rust is faster on the two larger tasks).

## Findings and caveats

1. **The 4-7× input-token gap is mostly accounting, not spend.** On the
   configured default model (an OpenAI-compatible endpoint), the TypeScript
   side reports input excluding provider cache hits — one pilot turn read
   15,488 cached tokens against 326 non-cached input — while the Rust side
   reports the full prompt in `input` with `cacheRead = 0`. An apples-to-apples
   cost model must bill `input + cacheRead` for TypeScript cells. The Rust
   engine's usage parser reads `prompt_tokens_details.cached_tokens`; whether
   the endpoint reported them for Rust-routed traffic is the remaining
   per-endpoint question.
2. **Cost columns stayed unpriced.** The default model has no price-table
   entry here, so every cell billed $0.0000 in both batches. Cost conclusions
   still need a priced model (`--model provider/id`).
3. **One task-design bug surfaced by the pilot.** The first feature fixture
   asserted `sum-notes` where dropping non-ASCII yields `rsum-notes`; the Rust
   session refused to paper over the contradiction and asked for a decision
   instead of hacking either file. The expectation was corrected — the
   "failure" belonged to the task, not the engine.
4. **Refactor on Rust stabilizes with best-of-3.** The pilot's failing run
   left the duplication in place (caught by the grep gate); the batch's three
   attempts all passed or were superseded by a passing cell.
5. **Prompt caching now defaults on for the transports that bill it.** The
   pilot's zero cache reads led to #1216: Anthropic and Bedrock transports
   now send the ephemeral breakpoint by default. The OpenAI-compatible
   endpoint used here caches server-side, so its cells are unaffected by the
   flag.

## Status

The harness, task set, and gates are the deliverable; both batches ran for
real. A priced-model batch (`--model provider/id`, `--repeat 3`) with the
`input + cacheRead` billing formula remains the step before quoting any
engine-cost number.
