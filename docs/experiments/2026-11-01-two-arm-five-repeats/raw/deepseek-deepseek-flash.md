# Engine cost benchmark — 2026-11-01

- binary: `/tmp/miao-perf01/miao-run`, models: `deepseek/deepseek-flash`, repeat: 5
- tasks: bugfix, feature, refactor, multifile, recovery, long-session, impossible; engines: ts, rust
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `deepseek/deepseek-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| bugfix (bug fix) | 4t · 118185b-in (59561in/58624cached)/346out · $0.0005 · 10s | 5t · 154224b-in (78064in/76160cached)/501out · $0.0008 · 13s | 30% |
| feature (feature) | 6t · 179349b-in (90773in/88576cached)/931out · $0.0012 · 16s | 6t · 186378b-in (94346in/92032cached)/971out · $0.0012 · 14s | 4% |
| refactor (refactor) | 7t · 214004b-in (107892in/106112cached)/1065out · $0.0012 · 17s | 6t · 187620b-in (95076in/92544cached)/1074out · $0.0013 · 14s | -12% |
| multifile (multi-file consistency) | 5t · 154006b-in (78230in/75776cached)/805out · $0.0011 · 16s | 5t · 158047b-in (80351in/77696cached)/1595out · $0.0016 · 16s | 3% |
| recovery (interrupt + resume) | 6t · 182486b-in (92118in/90368cached)/651out · $0.0009 · 20s · resumed | 6t · 193568b-in (97824in/95744cached)/1880out · $0.0017 · 23s · resumed | 6% |
| long-session (multi-turn long session) | 9t · 270841b-in (136569in/134272cached)/829out · $0.0012 · 28s | 8t · 243893b-in (123061in/120832cached)/800out · $0.0012 · 29s | -10% |
| impossible (contradiction (expected refusal)) | 3t · 88935b-in (45031in/43904cached)/1524out · $0.0012 · 17s | 4t · 121707b-in (61547in/60160cached)/1158out · $0.0011 · 17s | 37% |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | bugfix | ts | 5 | 5 | 170189 | 212714 | 0.0008 | 0.0025 | 13 | 16 |
| deepseek/deepseek-flash | bugfix | rust | 5 | 5 | 183848 | 204635 | 0.0009 | 0.0026 | 13 | 14 |
| deepseek/deepseek-flash | feature | ts | 5 | 5 | 180775 | 278834 | 0.0012 | 0.0016 | 16 | 19 |
| deepseek/deepseek-flash | feature | rust | 5 | 5 | 250189 | 289346 | 0.0014 | 0.0022 | 18 | 30 |
| deepseek/deepseek-flash | refactor | ts | 5 | 5 | 216983 | 278397 | 0.0013 | 0.0016 | 17 | 21 |
| deepseek/deepseek-flash | refactor | rust | 5 | 5 | 252273 | 285125 | 0.0015 | 0.0017 | 17 | 21 |
| deepseek/deepseek-flash | multifile | ts | 5 | 5 | 217900 | 354198 | 0.0017 | 0.0023 | 16 | 25 |
| deepseek/deepseek-flash | multifile | rust | 5 | 5 | 220479 | 259062 | 0.0016 | 0.0019 | 17 | 18 |
| deepseek/deepseek-flash | recovery | ts | 5 | 5 | 221029 | 277858 | 0.0016 | 0.0017 | 28 | 34 |
| deepseek/deepseek-flash | recovery | rust | 5 | 5 | 268374 | 433440 | 0.0027 | 0.0038 | 37 | 44 |
| deepseek/deepseek-flash | long-session | ts | 5 | 5 | 341031 | 378474 | 0.0018 | 0.0025 | 36 | 40 |
| deepseek/deepseek-flash | long-session | rust | 5 | 5 | 316083 | 463685 | 0.0018 | 0.0029 | 30 | 44 |
| deepseek/deepseek-flash | impossible | ts | 5 | 5 | 121655 | 156078 | 0.0012 | 0.0021 | 21 | 29 |
| deepseek/deepseek-flash | impossible | rust | 5 | 5 | 155813 | 195744 | 0.0015 | 0.0022 | 22 | 33 |

Failed attempts (every gate failure, with its reason):
- none
