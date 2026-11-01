# Engine cost benchmark — 2026-11-01

- binary: `/tmp/bench-fixture-cli`, models: `deepseek/deepseek-flash`, repeat: 10
- tasks: unfamiliar-repo; engines: ts
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `deepseek/deepseek-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| unfamiliar-repo (unfamiliar repo) | 5t · 152480b-in (77088in/75392cached)/532out · $0.0008 · 16s | — | — |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | unfamiliar-repo | ts | 10 | 10 | 213746 | 274393 | 0.0011 | 0.0026 | 17 | 27 |

## Totals (all attempts)

Success rate counts every attempt, so a retried task also contributes its failed samples. `$ per verified success` divides the priced cost of passing attempts by the number of passing attempts; one passing attempt without provider-reported cost makes the figure `unknown` instead of cheap. `tasks within budget` counts, per task, whether its cheapest priced passing attempt fits `--budget $0.01`.

| model | engine | attempts | passed | success rate | total $ | $ per verified success | tasks within budget |
|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | ts | 10 | 10 | 10/10 (100%) | $0.0122 | $0.0012 | 1/1 |

Failed attempts (every gate failure, with its reason):
- none
