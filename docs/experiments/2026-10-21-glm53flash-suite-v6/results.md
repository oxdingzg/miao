| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 38/45 | 245 (5.44/run) | 300,761 | 3,254,848 | 91.5% | 23,547 | $0.15453 | 22.3 s | 96.8 s |
| Rust | 42/45 | 265 (5.89/run) | 100,730 | 1,445,120 | 93.5% | 51,915 | $0.08442 | 30.7 s | 207.0 s |

Rust/TypeScript cost ratio: **0.546**; break-even output/input rate ratio: **19.81** (output rate currently 3.33× input).

| Class | TS cost | Rust cost | Rust/TS |
| --- | --- | --- | --- |
| create-module | $0.00926 | $0.00470 | 0.508 |
| docs-sync | $0.01355 | $0.00537 | 0.396 |
| large-file | $0.01356 | $0.00680 | 0.501 |
| long-session | $0.02881 | $0.02819 | 0.978 |
| multi-file | $0.00830 | $0.00482 | 0.581 |
| multi-line-edit | $0.00965 | $0.00344 | 0.356 |
| multi-read | $0.00354 | $0.00123 | 0.347 |
| permission-denial | $0.00625 | $0.00458 | 0.733 |
| read-only | $0.00450 | $0.00226 | 0.502 |
| rename-symbol | $0.01233 | $0.00570 | 0.462 |
| small-edit | $0.00824 | $0.00394 | 0.478 |
| stream-interruption | $0.00315 | $0.00075 | 0.238 |
| test-repair | $0.00984 | $0.00620 | 0.63 |
| tool-error | $0.00807 | $0.00182 | 0.226 |
| typed-repair | $0.01547 | $0.00462 | 0.299 |

Excluding `long-session`: TS $0.12572, Rust $0.05623, ratio 0.447.
