| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 39/45 | 258 (5.73/run) | 550,712 | 2,182,656 | 79.9% | 14,204 | $1.46173 | 18.8 s | 60.6 s |
| Rust | 45/45 | 282 (6.27/run) | 300,947 | 803,584 | 72.8% | 18,028 | $0.86253 | 18.5 s | 42.7 s |

Rust/TypeScript cost ratio: **0.59**; break-even output/input rate ratio: **83.35** (output rate currently 5.0× input).

| Class | TS cost | Rust cost | Rust/TS |
| --- | --- | --- | --- |
| create-module | $0.05402 | $0.05331 | 0.987 |
| docs-sync | $0.12586 | $0.11853 | 0.942 |
| large-file | $0.10521 | $0.09583 | 0.911 |
| long-session | $0.20073 | $0.10493 | 0.523 |
| multi-file | $0.11838 | $0.06389 | 0.54 |
| multi-line-edit | $0.10180 | $0.03577 | 0.351 |
| multi-read | $0.06842 | $0.02546 | 0.372 |
| permission-denial | $0.04568 | $0.02811 | 0.615 |
| read-only | $0.10156 | $0.03696 | 0.364 |
| rename-symbol | $0.12523 | $0.06747 | 0.539 |
| small-edit | $0.11240 | $0.05874 | 0.523 |
| stream-interruption | $0.02200 | $0.03281 | 1.491 |
| test-repair | $0.09942 | $0.05828 | 0.586 |
| tool-error | $0.05617 | $0.02516 | 0.448 |
| typed-repair | $0.12484 | $0.05728 | 0.459 |

Excluding `long-session`: TS $1.26100, Rust $0.75761, ratio 0.601.
