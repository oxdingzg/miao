# Engine cost benchmark — 2026-11-01

- binary: `/tmp/bench-run-cli`, models: `deepseek/deepseek-flash`, repeat: 10
- tasks: recovery, long-session, impossible, test-repair, tool-failure; engines: ts
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `deepseek/deepseek-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| recovery (interrupt + resume) | 7t · 216464b-in (109204in/107260cached)/1010out · $0.0012 · 58s · resumed | — | — |
| long-session (multi-turn long session) | 8t · 240012b-in (121100in/118912cached)/754out · $0.0011 · 70s | — | — |
| impossible (contradiction (expected refusal)) | 3t · 88116b-in (44596in/43520cached)/1023out · $0.0009 · 20s | — | — |
| test-repair (test repair) | 7t · 211307b-in (106859in/104448cached)/734out · $0.0011 · 21s | — | — |
| tool-failure (tool failure recovery) | 6t · 184739b-in (93219in/91520cached)/997out · $0.0011 · 20s | — | — |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | recovery | ts | 10 | 10 | 437051 | 487699 | 0.0029 | 0.0047 | 61 | 81 |
| deepseek/deepseek-flash | long-session | ts | 10 | 10 | 305879 | 406923 | 0.0017 | 0.0023 | 70 | 124 |
| deepseek/deepseek-flash | impossible | ts | 10 | 10 | 151960 | 190651 | 0.0014 | 0.0037 | 26 | 40 |
| deepseek/deepseek-flash | test-repair | ts | 10 | 10 | 216319 | 249149 | 0.0012 | 0.0015 | 20 | 27 |
| deepseek/deepseek-flash | tool-failure | ts | 10 | 10 | 246571 | 280624 | 0.0013 | 0.0015 | 20 | 21 |

## Totals (all attempts)

Success rate counts every attempt, so a retried task also contributes its failed samples. `$ per verified success` divides the priced cost of passing attempts by the number of passing attempts; one passing attempt without provider-reported cost makes the figure `unknown` instead of cheap. `tasks within budget` counts, per task, whether its cheapest priced passing attempt fits `--budget $0.01`.

| model | engine | attempts | passed | success rate | total $ | $ per verified success | tasks within budget |
|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | ts | 50 | 50 | 50/50 (100%) | $0.0844 | $0.0017 | 5/5 |

Failed attempts (every gate failure, with its reason):
- none
