# Engine cost benchmark — 2026-11-01

- binary: `/tmp/bench-run-cli`, models: `deepseek/deepseek-flash`, repeat: 10
- tasks: recovery, long-session, impossible, test-repair, tool-failure; engines: rust
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `deepseek/deepseek-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| recovery (interrupt + resume) | — | 8t · 247213b-in (124717in/122496cached)/857out · $0.0012 · 38s · resumed | — |
| long-session (multi-turn long session) | — | 8t · 244122b-in (123290in/120832cached)/821out · $0.0012 · 47s | — |
| impossible (contradiction (expected refusal)) | — | 3t · 90540b-in (45868in/44672cached)/1418out · $0.0012 · 28s | — |
| test-repair (test repair) | — | 6t · 186954b-in (94282in/92672cached)/806out · $0.0010 · 22s | — |
| tool-failure (tool failure recovery) | — | 6t · 187353b-in (94553in/92800cached)/653out · $0.0009 · 18s | — |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | recovery | rust | 10 | 10 | 348134 | 526297 | 0.0024 | 0.0042 | 64 | 88 |
| deepseek/deepseek-flash | long-session | rust | 10 | 9 | 276977 | 416737 | 0.0013 | 0.0022 | 74 | 121 |
| deepseek/deepseek-flash | impossible | rust | 10 | 10 | 156178 | 191737 | 0.0016 | 0.0026 | 28 | 31 |
| deepseek/deepseek-flash | test-repair | rust | 10 | 10 | 221216 | 254348 | 0.0012 | 0.0014 | 22 | 24 |
| deepseek/deepseek-flash | tool-failure | rust | 10 | 10 | 221630 | 292763 | 0.0013 | 0.0018 | 20 | 25 |

## Totals (all attempts)

Success rate counts every attempt, so a retried task also contributes its failed samples. `$ per verified success` divides the priced cost of passing attempts by the number of passing attempts; one passing attempt without provider-reported cost makes the figure `unknown` instead of cheap. `tasks within budget` counts, per task, whether its cheapest priced passing attempt fits `--budget $0.01`.

| model | engine | attempts | passed | success rate | total $ | $ per verified success | tasks within budget |
|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | rust | 50 | 49 | 49/50 (98%) | $0.0803 | $0.0016 | 5/5 |

Failed attempts (every gate failure, with its reason):
- deepseek/deepseek-flash/long-session/rust#10: bun test v1.3.14 (0d9b296a)

No tests found!

Tests need ".test", "_test_", ".spec" or "_spec_" in the filename (ex: "MyApp.test.ts")

Learn more about bun test: https://bun.com/docs/cli/test

