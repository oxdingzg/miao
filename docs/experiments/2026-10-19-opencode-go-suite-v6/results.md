| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 39/45 | 239 (5.31/run) | 713,610 | 2,861,440 | 80.0% | 28,043 | $0.13245 | 14.9 s | 47.3 s |
| Rust | 41/45 | 329 (7.31/run) | 178,929 | 2,089,472 | 92.1% | 61,220 | $0.06984 | 17.1 s | 71.5 s |

Rust/TypeScript cost ratio: **0.527**; break-even output/input rate ratio: **16.58** (output rate currently 4.0× input).

| Class | TS cost | Rust cost | Rust/TS |
| --- | --- | --- | --- |
| create-module | $0.01180 | $0.00480 | 0.407 |
| docs-sync | $0.00818 | $0.01104 | 1.35 |
| large-file | $0.00845 | $0.00637 | 0.754 |
| long-session | $0.01727 | $0.01698 | 0.983 |
| multi-file | $0.00783 | $0.00507 | 0.648 |
| multi-line-edit | $0.00787 | $0.00255 | 0.324 |
| multi-read | $0.00687 | $0.00062 | 0.09 |
| permission-denial | $0.00761 | $0.00199 | 0.261 |
| read-only | $0.00713 | $0.00114 | 0.16 |
| rename-symbol | $0.00836 | $0.00374 | 0.447 |
| small-edit | $0.00953 | $0.00314 | 0.329 |
| stream-interruption | $0.00633 | $0.00396 | 0.626 |
| test-repair | $0.01027 | $0.00393 | 0.383 |
| tool-error | $0.00626 | $0.00066 | 0.105 |
| typed-repair | $0.00870 | $0.00387 | 0.445 |

Excluding `long-session`: TS $0.11518, Rust $0.05286, ratio 0.459.
