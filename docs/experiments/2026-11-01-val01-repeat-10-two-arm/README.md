# VAL-01 / VAL-02: repeat-10 two-arm measurement

Measured 2026-11-01 with `script/engine-benchmark.ts` on this workstation: model
`deepseek/deepseek-flash`, `--repeat 10`, both arms (`ts` and `rust`), all ten
task families. The frozen facts (commits, suite and engine hashes, prices) are in
`manifest.json` and `prices.json`; `analyze.py` recomputes every table below from
`raw/<arm>/evidence/`, so no figure here has to be taken on trust.

## Protocol

- **Arms.** `ts` runs the Session on the default TypeScript placement; `rust`
  sets `MIAO_ENGINE_BIN` so execution is placed on the native engine. Both arms
  use the same CLI entry (`packages/miao/src/index.ts`) and the same model.
- **Families.** bugfix, feature, refactor, unfamiliar-repo, multifile, recovery
  (interrupt + resume), long-session (multi-turn), impossible (a contradiction
  whose correct outcome is a refusal), test-repair, tool-failure.
- **Cell.** A fresh workspace per cell, one prompt, `miao run --format json`,
  then the family's own verifier. A failed gate is reported, never dropped, and a
  cell that produced no provider step fails regardless of its verifier.
- **Repeats.** 10 per cell, 100 cells per arm, 200 in total.
- **Budget.** `--budget 0.01` (USD per task) feeds the "tasks within budget"
  column.
- **Chunking.** The four reports (`report-ts-a.md`, `report-ts-b.md`,
  `report-rust-a.md`, `report-rust-b.md`) are two halves per arm, because the
  local tool runner caps a foreground command at 60 minutes. Each half is the
  same suite, model and repeat count; only the task subset differs. `results.md`
  merges them.
- **Money.** Cost is the provider-reported per-step cost. A step that reports no
  cost makes its cell's figure `unknown` rather than zero; `analyze.py` counts
  such samples (none in this run).

## Result

| arm | runs | passed | billed-in p50 | $ p50 | s p50 | total $ | $ per verified success | tasks within budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| typescript | 100 | 91 | 240313 | $0.0014 | 33 | $0.1797 | $0.0016 | 10/10 |
| rust | 100 | 90 | 221630 | $0.0013 | 31 | $0.1687 | $0.0015 | 10/10 |

The per-task table is in `results.md`. Reading it with both arms in mind:

- The two arms are within one sample of each other on nine families (9–10 of 10
  each), so this run does **not** support a claim that either placement is more
  reliable.
- Rust used slightly less billed input on the multi-turn families (`recovery`
  348134 vs 437051, `long-session` 276977 vs 305879) and cost about 6% less
  overall, but the spread between samples is wider than that difference, so the
  honest statement is "no measurable cost difference at this sample size".
- Every failure is listed in `results.md` with its verifier message.

## One contaminated family, and its fix

`unfamiliar-repo` reported 2/10 (ts) and 1/10 (rust). That row is **not** a model
result: the generated `src/ledger.test.ts` contained a real newline inside a
string literal, because the fixture was written with a single `\n` inside a
template literal. The file could not parse — `error: Unterminated string literal`
— so no implementation could pass it. The single recorded pass is explained by
what it left behind: a Bun plugin that re-escaped stray newlines at load time.

Fixed in #2205 (double escape), verified by regenerating the fixture: the failure
signal became the intended `Export named 'total' not found in module
'src/ledger.ts'`. The family was re-measured on both arms with the repaired
fixture; those numbers replace the contaminated row:

| arm | runs | passed | total $ | $ per verified success | tasks within budget |
| --- | --- | --- | --- | --- | --- |
| typescript | 100 | 99/100 (99%) | $0.1544 | $0.0015 | 10/10 |
| rust | 100 | 99/100 (99%) | $0.1475 | $0.0015 | 10/10 |

Re-measured with the same model, repeat count and budget, one run per arm (10
cells each, 10/10 passed on both). The repaired family stops being an outlier —
billed-in p50 213746 (ts) and 219792 (rust), in line with the other short
families — and the two remaining failures in the primary run are genuine model
failures: `ts/refactor#5` (left the discount duplicated) and
`rust/long-session#10`.

`analyze.py` prints both views and writes the corrected one to `results.md`;
`raw/<arm>/rerun/evidence/` keeps the re-measured samples.

## Limitations

- One model, one machine, one day. The numbers describe this pairing, not the
  product at large.
- 10 repeats per cell is enough to see a 20-point difference, not enough to
  resolve a few percent.
- Human intervention is not measured here; that is VAL-03 and needs an operator
  record, not a benchmark.
- The engine used by the `rust` arm was built from `071eed588d` while the CLI
  ran from `808cc110e`. The two commits differ only in script, test and doc
  files — no Rust source differs — and both shas are recorded in `manifest.json`
  so a reader can check that claim.
