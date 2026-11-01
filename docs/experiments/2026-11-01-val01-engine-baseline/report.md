# Engine cost benchmark — 2026-11-01

- binary: `miao-dev`, models: `opencode-go/deepseek-v4.1-flash`, repeat: 3
- tasks: bugfix, feature, refactor, multifile, recovery, long-session, impossible; engines: ts, rust
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `opencode-go/deepseek-v4.1-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| bugfix (bug fix) | 4t · 118325b-in (59701in/58624cached)/306out · $0.0005 · 22s | 6t · 168553b-in (92521in/76032cached)/543out · $0.0030 · 25s | 42% |
| feature (feature) | 7t · 201263b-in (108719in/92544cached)/1178out · $0.0034 · 29s | 5t · 138555b-in (77499in/61056cached)/824out · $0.0031 · 27s | -31% |
| refactor (refactor) | 6t · 168002b-in (92354in/75648cached)/998out · $0.0033 · 28s | 6t · 188663b-in (95607in/93056cached)/1102out · $0.0013 · 29s | 12% |
| multifile (multi-file consistency) | 5t · 142583b-in (78839in/63744cached)/852out · $0.0030 · 30s | 5t · 155764b-in (79092in/76672cached)/1014out · $0.0012 · 28s | 9% |
| recovery (interrupt + resume) | 15t · 470804b-in (245524in/225280cached)/2483out · $0.0052 · 61s · resumed | 7t · 216539b-in (109659in/106880cached)/898out · $0.0013 · 42s · resumed | -54% |
| long-session (multi-turn long session) | 10t · 261560b-in (154424in/107136cached)/1098out · $0.0081 · 99s | 8t · 246595b-in (124355in/122240cached)/1060out · $0.0013 · 62s | -6% |
| impossible (contradiction (expected refusal)) | 3t · 74745b-in (45305in/29440cached)/976out · $0.0031 · 26s | 4t · 107729b-in (62417in/45312cached)/1922out · $0.0039 · 35s | 44% |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| opencode-go/deepseek-v4.1-flash | bugfix | ts | 3 | 3 | 166165 | 196685 | 0.0030 | 0.0031 | 25 | 27 |
| opencode-go/deepseek-v4.1-flash | bugfix | rust | 3 | 3 | 171772 | 182248 | 0.0027 | 0.0030 | 25 | 25 |
| opencode-go/deepseek-v4.1-flash | feature | ts | 3 | 3 | 234617 | 263705 | 0.0034 | 0.0037 | 31 | 38 |
| opencode-go/deepseek-v4.1-flash | feature | rust | 3 | 3 | 170542 | 202450 | 0.0032 | 0.0034 | 29 | 29 |
| opencode-go/deepseek-v4.1-flash | refactor | ts | 3 | 3 | 217786 | 343375 | 0.0019 | 0.0033 | 32 | 36 |
| opencode-go/deepseek-v4.1-flash | refactor | rust | 3 | 3 | 220956 | 341859 | 0.0016 | 0.0039 | 33 | 38 |
| opencode-go/deepseek-v4.1-flash | multifile | ts | 3 | 3 | 153936 | 377785 | 0.0030 | 0.0044 | 30 | 47 |
| opencode-go/deepseek-v4.1-flash | multifile | rust | 3 | 3 | 158870 | 190749 | 0.0014 | 0.0015 | 28 | 28 |
| opencode-go/deepseek-v4.1-flash | recovery | ts | 3 | 3 | 509435 | 525682 | 0.0052 | 0.0058 | 61 | 73 |
| opencode-go/deepseek-v4.1-flash | recovery | rust | 3 | 3 | 401022 | 411681 | 0.0033 | 0.0053 | 65 | 65 |
| opencode-go/deepseek-v4.1-flash | long-session | ts | 3 | 3 | 340935 | 342026 | 0.0022 | 0.0081 | 99 | 130 |
| opencode-go/deepseek-v4.1-flash | long-session | rust | 3 | 3 | 313004 | 333858 | 0.0018 | 0.0038 | 89 | 106 |
| opencode-go/deepseek-v4.1-flash | impossible | ts | 3 | 3 | 105176 | 201016 | 0.0032 | 0.0042 | 30 | 40 |
| opencode-go/deepseek-v4.1-flash | impossible | rust | 3 | 3 | 122858 | 214249 | 0.0039 | 0.0043 | 35 | 43 |

Failed attempts (every gate failure, with its reason):
- none
