# VAL-01 / VAL-02: a same-model, same-task two-arm baseline

Measured 2026-11-01 with `script/engine-benchmark.ts`, model
`opencode-go/deepseek-v4.1-flash`, `--repeat 3`, both arms (`ts` and `rust`),
all seven task families, on this workstation.

Artifacts beside this README: `report.md` (the generated report) and
`results.csv` (one row per aggregate the report prints, so a reader can
recompute every figure).

## Protocol (frozen for this round)

- Tasks: `bugfix`, `feature`, `refactor`, `multifile`, `recovery`
  (interrupt + resume), `long-session`, `impossible` (contradiction whose
  correct outcome is a refusal).
- Each cell: a fresh workspace, the same prompt, `miao run --format json`;
  `rust` cells place the Session on the native engine, `ts` cells use the
  default. Every cell is gated by the task's own check, and a failed gate is
  reported, not dropped.
- Repeats: 3 per cell. `billed-in = input + cacheRead`, because provider cache
  hits make raw input incomparable across arms.
- Cost is the engine-reported per-step cost, which already includes the
  provider's own cache accounting.

## Result

42 of 42 cells passed, with no gate failures.

| arm | runs | passed | attempts | billed-in | cached | output | cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ts | 21 | 21 | 180 | 2 852 278 | 2 563 328 | 29 421 | $0.06869 | 32.2 s | 99.4 s |
| rust | 21 | 21 | 152 | 2 427 860 | 2 230 656 | 28 595 | $0.05343 | 29.3 s | 89.1 s |

The Rust arm cost **22% less** for the same 21 verified results, used **16%
fewer provider attempts** (152 vs 180), and was faster at both percentiles.
Per-task numbers are in `report.md`; the gaps are not uniform — `bugfix` and
`impossible` favour TypeScript, `feature`, `recovery`, and `long-session`
favour Rust — which is why the report keeps every cell rather than an average.

## What this does not cover

- One model, one machine, three repeats. It fixes a baseline, it does not bound
  variance; more repeats tighten the interval.
- Subagent, auxiliary-model, retry, and compaction cost are attributed by the
  engine's `usage_report` but these tasks do not exercise subagents or
  auxiliary roles, and only `long-session` approaches the context limit. The
  cost column is therefore main-model cost.
- Human interventions are not counted, so VAL-02's "time from submit to
  verified completion plus human interventions" is only half measured.
- Windows and other platforms are not covered by this round.
