# G7 fixed-task benchmark — glm-5.3-flash, 2026-11-10

REL-04 gate G7 evidence (specs/rust-retirement-gates.md): the fixed task set run
against the single Rust product, with per-cell raw results.

| item | value |
| --- | --- |
| model | `zhipuai-coding-plan/glm-5.3-flash` (budget authorised by the owner, 2026-11-10) |
| binary | release build of `4f9bd750d7` (the `step_finish` headless event fix, #2822); `miao --version` prints `0.3.59` from the root package.json; sha256 `9e8f6f684e61bde8…` |
| tree | script + fixtures at `c88658a56e` (origin/main incl. #2822) |
| protocol | single arm `product` (the binary's own default placement), repeat 1 first round |
| result | **10/10 cells passed (100%)** — 61 provider attempts, billed-in 794,720 / cached 716,736 / output 10,432 tokens, no gate failures |

## What the money columns mean here

Every attempt's engine-recorded `cost` was `null`: the price table carries no
figure for this route and the gateway reported none. Per the gate's own rule —
unknown billing stays unknown — the `$` columns read `unknown` and
`unknown_cost_steps` is 61, not zero. The token figures are exact.

## First round, and why it failed

An earlier round on the same protocol ran the published 0.3.59 artifact and
recorded 0/10 with "the session produced no provider step" while the engine's
storage showed 16 settled steps per cell. Root cause: the Rust product's headless
NDJSON had lost the `step_finish` event the TypeScript runner used to emit
(#2822 fixes it). This round ran a binary built from that fix; the token columns
above are the harvest of real settled steps.

## Files

- `report.md` — the generated report (per-cell aggregates, totals, failure list)
- `results.csv` — one row per aggregate, so every figure can be recomputed
- `raw/` — one evidence JSON per attempt

## What this does not claim

Repeat 1 is directional, not statistical; the 2026-11-01 baseline used repeat 3.
The wall-clock and token figures bind to this binary (a release build of the fix
commit, not a published release artifact) and to this date's glm-5.3-flash
 behaviour; a published-artifact rerun should rebind and repeat before any
cross-version comparison is drawn from them.
