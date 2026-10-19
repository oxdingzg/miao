| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 39/45 | 233 (5.18/run) | 605,554 | 2,892,288 | 82.7% | 22,890 | $0.11324 | 7.6 s | 34.9 s |
| Rust | 42/45 | 500 (11.11/run) | 154,295 | 3,345,021 | 95.6% | 92,838 | $0.08888 | 9.0 s | 28.3 s |

Rust/TypeScript cost ratio: **0.785**; break-even output/input rate ratio: **6.32** (output rate currently 4.0× input).

| Class | TS cost | Rust cost | Rust/TS |
| --- | --- | --- | --- |
| create-module | $0.00702 | $0.00428 | 0.61 |
| docs-sync | $0.00953 | $0.00807 | 0.847 |
| large-file | $0.00841 | $0.00398 | 0.473 |
| long-session | $0.01321 | $0.04533 | 3.431 |
| multi-file | $0.00695 | $0.00463 | 0.666 |
| multi-line-edit | $0.00719 | $0.00244 | 0.339 |
| multi-read | $0.00601 | $0.00073 | 0.121 |
| permission-denial | $0.00734 | $0.00254 | 0.346 |
| read-only | $0.00652 | $0.00122 | 0.187 |
| rename-symbol | $0.00721 | $0.00357 | 0.495 |
| small-edit | $0.00707 | $0.00301 | 0.426 |
| stream-interruption | $0.00565 | $0.00031 | 0.055 |
| test-repair | $0.00764 | $0.00352 | 0.461 |
| tool-error | $0.00611 | $0.00077 | 0.126 |
| typed-repair | $0.00739 | $0.00450 | 0.609 |

Excluding `long-session`: TS $0.10003, Rust $0.04356, ratio 0.435.
