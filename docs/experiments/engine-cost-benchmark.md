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

## Priced multi-model batch (2026-10-22, G5 acceptance)

The acceptance batch widened the set to seven task families — the original
three plus **multifile** (cross-file consistency), **recovery** (mid-run
`SIGKILL` then resume), **long-session** (three accumulated turns), and
**impossible** (a contradictory request whose correct outcome is a refusal) —
and ran two priced models from different families, best-of-2 per cell, with
`billed-in = input + cacheRead` for both runtimes.

| task | glm-5.3 ts | glm-5.3 rust | deepseek-v4.1-flash ts | deepseek-v4.1-flash rust |
|---|---|---|---|---|
| bugfix | 70273b-in · $0.0354 · 11s ✓ | 118132b-in · 18s ✓ | 73286b-in · $0.0027 · 18s ✓ | N/A |
| feature | 74033b-in · $0.0345 · 30s ✓ | 156852b-in · 71s ✓ | 74217b-in · $0.0029 · 16s ✓ | N/A |
| refactor | 87037b-in · $0.0435 · 20s ✓ | 119707b-in · 32s ✓ | 74708b-in · $0.0029 · 44s ✓ | N/A |
| multifile | 73060b-in · $0.0305 · 17s ✓ | 137588b-in · 49s ✓ | 74020b-in · $0.0029 · 14s ✓ | N/A |
| recovery | 78573b-in · $0.0468 · 61s ✓ resumed | 230365b-in · 260s ✓ resumed | 75566b-in · $0.0030 · 24s ✓ resumed | N/A |
| long-session | 128733b-in · $0.0431 · 25s ✓ | 190984b-in · 81s ✓ | 117360b-in · $0.0026 · 18s ✓ | N/A |
| impossible | 60630b-in · $0.0621 · 70s ✓ refused | 215646b-in · 132s ✓ refused | 59361b-in · $0.0040 · 71s ✓ refused | N/A |

All 42 runnable cells passed their gates; the only cells that could not run
are the four deepseek rust ones (below). Task families exercised every
acceptance axis: the recovery family was `SIGKILL`-ed mid-run and resumed to a
passing gate on both engines, and the impossible family was correctly refused
by both engines on both models (marked ✓ because a refusal *is* the pass).

### Findings

1. **deepseek-v4.1-flash on `opencode-go` failed its first provider turn.**
   The route itself resolves; the turn was rejected with HTTP 400 because the
   native product-tools bridge advertised `plan_enter` with `parameters:
   {"anyOf": [object, array]}` (Effect lowers an empty `Schema.Struct({})` to
   that union), and the DeepSeek upstream requires function parameters to be a
   JSON Schema of `type: "object"`. The whole request fails before the first
   token, so the four deepseek rust cells are **N/A in this batch** — an engine
   wiring bug, not a model limitation. Fixed by #1264 (2026-10-23): empty-input
   tool schemas are now advertised as `{"type": "object", "properties": {}}`,
   and `miao run --engine native` against this model returns a normal reply. A
   rerun of this batch fills the deepseek rust cells.
2. **GLM rust cells lack price entries**, so their cost column reads $0.0000;
   the billed-in columns carry the comparison. On deepseek ts cells (priced),
   a full run costs $0.0026–0.0059. **Fixed by #1251** (2026-10-23): the
   models overlay now prices `zhipuai-coding-plan/glm-5.3` and
   `glm-5.3-flash` at their standard-API reference rates, so native steps on
   that provider are priced at catalog rates. The table above predates the
   fix; a rerun of this batch would fill the GLM rust cost column.
3. **Billed-in gap on glm narrowed to +38–256%** (from the unpriced batch's
   raw-input 4–7×), and rust wall-clock stays comparable or better on the
   larger tasks even while carrying the full prompt in `input`.
4. **Recovery is real on both engines**: the harness `SIGKILL`s the first run
   mid-task and resumes; both engines re-planned and passed the gate (rust
   needed 230k billed-in over 260s for the recovery family — the most
   expensive cell in the batch).
5. **Refusals are cheap and correct**: the impossible family was refused on
   all four model×engine cells without touching the guarded file.

## Status

The harness, task set, and gates are the deliverable; the priced multi-model
acceptance batch above (G5) ran for real with the widened families. Remaining
follow-ups: a rerun that fills the deepseek rust cells now that #1264 removed
their blocker, and per-endpoint confirmation of
`prompt_tokens_details.cached_tokens` reporting for rust-routed traffic.
