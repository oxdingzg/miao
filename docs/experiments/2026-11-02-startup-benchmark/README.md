# Startup benchmark — 2026-11-02

QA-05's remaining gap asked for start-path evidence that the cost benchmark does
not carry: cold and warm start separated from engine turns, and full process
resources (CPU, RSS, FDs) instead of tokens. This round records the harness and
its first full run; it is a measurement record, not a completion claim.

## Harness

`script/startup-benchmark.ts` drives the single binary through `/usr/bin/time -l`
so wall, user/system CPU, and peak RSS come from the kernel's rusage rather than
from anything the binary prints; the wall figure uses the host clock because
`time` rounds to centiseconds. Cold runs point `MIAO_DATA_HOME`,
`MIAO_ENGINE_STORAGE`, `XDG_CONFIG_HOME`, and `HOME` at a fresh empty directory
per sample, so every first-touch cost (schema migration, credential probe,
ledger creation) is paid; warm runs use the machine's real home. The serve cell
runs against the same isolated home with its own ledger beside — never inside —
the workspace, and a placeholder API key, because `serve` refuses a start
without a credential source; the window sends no prompt, so nothing beyond the
resident baseline is measured. Every raw sample lands in
[evidence.json](./evidence.json); every figure below is reproducible from the
harness.

## Environment

- Artifact: `cargo build --release` of `crates/miao-cli` at `main` (single
  binary, `--version` reports `miao 0.0.1` from the crate manifest — the
  release pipeline stamps product versions separately)
- Host: macOS 15 (Darwin 25.5.0), Apple M4, 2026-11-02
- Samples: 10 per startup cell, one 5 s serve window, 500 ms sampling

## Results (medians)

| cell | wall ms | peak RSS KB | failures |
|---|---|---|---|
| `--version` (cold) | 11 | 8384 | 0 |
| `--version` (warm) | 6 | 8592 | 0 |
| `db path` (cold) | 6 | 8544 | 0 |
| `db path` (warm) | 6 | 8752 | 0 |
| `session list` (cold) | 11 | 12896 | 0 |
| `session list` (warm) | 7 | 12400 | 0 |
| `models` (cold/warm) | 5 | 8352 | 10 / 10 |
| `serve` (5 s window) | — | 16144 flat | 0 |

Serve window detail: RSS min 16096 · median 16144 · max 16144 KB; open file
descriptors 20 flat across the window; one process in the tree (the linked-in
TUI keeps the single-binary promise: no children spawn).

## Failure distribution

`models` fails all 20 samples on this host by design: the isolated host has no
model routes or stored credentials, and the command reports that instead of an
empty success. The startup cells and the serve window fail none. A host with
configured routes will move this row; the raw per-sample exit codes are in the
evidence file.

## Reading

- Start paths cost single-digit-to-low-teens milliseconds; opening the ledger
  (`session list`) roughly doubles the peak RSS against pure argument parsing.
- The flat serve RSS/FD trace over the window is a baseline, not a leak
  finding — long-run drift needs a window measured in hours, which this
  harness supports by raising `--serve-seconds`.
- A single faster or cheaper run never counts as completion while quality is
  unproven; quality evidence lives with the engine cost benchmark
  (`docs/experiments/engine-cost-benchmark.md`).
