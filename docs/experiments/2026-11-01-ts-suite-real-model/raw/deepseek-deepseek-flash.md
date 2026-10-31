# Engine cost benchmark — 2026-10-31

- binary: `miao-dev`, models: `deepseek/deepseek-flash`, repeat: 2
- tasks: bugfix, feature, refactor, multifile, recovery, long-session, impossible; engines: ts
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `deepseek/deepseek-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| bugfix (bug fix) | 7t · 204997b-in (108869in/96128cached)/653out · $0.0026 · 23s | — | — |
| feature (feature) | 5t · 150260b-in (76020in/74240cached)/826out · $0.0010 · 26s | — | — |
| refactor (refactor) | 7t · 214983b-in (108615in/106368cached)/1016out · $0.0013 · 31s | — | — |
| multifile (multi-file consistency) | 7t · 216720b-in (109840in/106880cached)/1135out · $0.0014 · 87s | — | — |
| recovery (interrupt + resume) | 6t · 181096b-in (91880in/89216cached)/1108out · $0.0013 · 44s · resumed | — | — |
| long-session (multi-turn long session) | 9t · 269742b-in (136110in/133632cached)/744out · $0.0012 · 41s | — | — |
| impossible (contradiction (expected refusal)) | 4t · 121246b-in (61342in/59904cached)/1596out · $0.0014 · 22s | — | — |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | bugfix | ts | 2 | 2 | 239235 | 239235 | 0.0026 | 0.0026 | 32 | 32 |
| deepseek/deepseek-flash | feature | ts | 2 | 2 | 282868 | 282868 | 0.0018 | 0.0018 | 31 | 31 |
| deepseek/deepseek-flash | refactor | ts | 2 | 2 | 244261 | 244261 | 0.0013 | 0.0013 | 31 | 31 |
| deepseek/deepseek-flash | multifile | ts | 2 | 2 | 218822 | 218822 | 0.0018 | 0.0018 | 87 | 87 |
| deepseek/deepseek-flash | recovery | ts | 2 | 2 | 182143 | 182143 | 0.0013 | 0.0013 | 44 | 44 |
| deepseek/deepseek-flash | long-session | ts | 2 | 2 | 341531 | 341531 | 0.0019 | 0.0019 | 49 | 49 |
| deepseek/deepseek-flash | impossible | ts | 2 | 2 | 181966 | 181966 | 0.0017 | 0.0017 | 26 | 26 |

Failed attempts (every gate failure, with its reason):
- none
