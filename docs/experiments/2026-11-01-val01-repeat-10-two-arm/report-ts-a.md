# Engine cost benchmark — 2026-11-01

- binary: `/tmp/bench-run-cli`, models: `deepseek/deepseek-flash`, repeat: 10
- tasks: bugfix, feature, refactor, unfamiliar-repo, multifile; engines: ts
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `deepseek/deepseek-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| bugfix (bug fix) | 5t · 150391b-in (75895in/74496cached)/474out · $0.0007 · 29s | — | — |
| feature (feature) | 4t · 119669b-in (60405in/59264cached)/1009out · $0.0010 · 44s | — | — |
| refactor (refactor) | 6t · 184445b-in (93181in/91264cached)/860out · $0.0011 · 40s | — | — |
| unfamiliar-repo (unfamiliar repo) | 10t · 343397b-in (174181in/169216cached)/4268out · $0.0038 · 47s | — | — |
| multifile (multi-file consistency) | 5t · 155059b-in (78387in/76672cached)/1306out · $0.0013 · 22s | — | — |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | bugfix | ts | 10 | 10 | 182213 | 320311 | 0.0010 | 0.0031 | 39 | 80 |
| deepseek/deepseek-flash | feature | ts | 10 | 10 | 215909 | 314078 | 0.0014 | 0.0018 | 44 | 49 |
| deepseek/deepseek-flash | refactor | ts | 10 | 9 | 279167 | 315051 | 0.0017 | 0.0019 | 40 | 57 |
| deepseek/deepseek-flash | unfamiliar-repo | ts | 10 | 2 | 370598 | 541372 | 0.0038 | 0.0064 | 46 | 71 |
| deepseek/deepseek-flash | multifile | ts | 10 | 10 | 222811 | 258769 | 0.0017 | 0.0020 | 25 | 30 |

## Totals (all attempts)

Success rate counts every attempt, so a retried task also contributes its failed samples. `$ per verified success` divides the priced cost of passing attempts by the number of passing attempts; one passing attempt without provider-reported cost makes the figure `unknown` instead of cheap. `tasks within budget` counts, per task, whether its cheapest priced passing attempt fits `--budget $0.01`.

| model | engine | attempts | passed | success rate | total $ | $ per verified success | tasks within budget |
|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | ts | 50 | 41 | 41/50 (82%) | $0.0954 | $0.0016 | 5/5 |

Failed attempts (every gate failure, with its reason):
- deepseek/deepseek-flash/refactor/ts#5: discount check failed
- deepseek/deepseek-flash/unfamiliar-repo/ts#2: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-BIF4yo/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [22.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/ts#3: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-eFRkMX/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [25.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/ts#4: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-ZJVzb7/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [26.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/ts#5: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-0FJZdv/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [18.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/ts#7: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-aZUPlb/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [27.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/ts#8: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-chUwM5/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [15.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/ts#9: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-EZ5U3Z/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [21.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/ts#10: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpFJA2wS/bench-unfamiliar-repo-ts-ymwc3A/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [23.00ms]

