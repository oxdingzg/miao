# Engine cost benchmark — 2026-11-01

- binary: `/tmp/bench-run-cli`, models: `deepseek/deepseek-flash`, repeat: 10
- tasks: bugfix, feature, refactor, unfamiliar-repo, multifile; engines: rust
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `deepseek/deepseek-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| bugfix (bug fix) | — | 5t · 142665b-in (77513in/65152cached)/456out · $0.0023 · 44s | — |
| feature (feature) | — | 4t · 121521b-in (61233in/60288cached)/776out · $0.0008 · 41s | — |
| refactor (refactor) | — | 7t · 217138b-in (109490in/107648cached)/883out · $0.0011 · 41s | — |
| unfamiliar-repo (unfamiliar repo) | — | 11t · 383668b-in (193460in/190208cached)/4535out · $0.0038 · 49s | — |
| multifile (multi-file consistency) | — | 5t · 159579b-in (80859in/78720cached)/1208out · $0.0013 · 17s | — |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | bugfix | rust | 10 | 10 | 184414 | 251100 | 0.0009 | 0.0023 | 39 | 46 |
| deepseek/deepseek-flash | feature | rust | 10 | 10 | 214590 | 287428 | 0.0013 | 0.0018 | 42 | 48 |
| deepseek/deepseek-flash | refactor | rust | 10 | 10 | 248692 | 291213 | 0.0013 | 0.0020 | 44 | 57 |
| deepseek/deepseek-flash | unfamiliar-repo | rust | 10 | 1 | 350038 | 477846 | 0.0032 | 0.0047 | 45 | 52 |
| deepseek/deepseek-flash | multifile | rust | 10 | 10 | 193030 | 228810 | 0.0016 | 0.0023 | 22 | 29 |

## Totals (all attempts)

Success rate counts every attempt, so a retried task also contributes its failed samples. `$ per verified success` divides the priced cost of passing attempts by the number of passing attempts; one passing attempt without provider-reported cost makes the figure `unknown` instead of cheap. `tasks within budget` counts, per task, whether its cheapest priced passing attempt fits `--budget $0.01`.

| model | engine | attempts | passed | success rate | total $ | $ per verified success | tasks within budget |
|---|---|---|---|---|---|---|---|
| deepseek/deepseek-flash | rust | 50 | 41 | 41/50 (82%) | $0.0884 | $0.0014 | 5/5 |

Failed attempts (every gate failure, with its reason):
- deepseek/deepseek-flash/unfamiliar-repo/rust#1: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-agwaB5/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [26.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#2: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-5zU1TL/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [37.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#3: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-ZpIsbB/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [22.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#4: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-LQGL9S/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [31.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#5: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-WfL4PX/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [28.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#6: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-0U8Xgu/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [17.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#7: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-dVrEZG/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [30.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#8: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-nSulMW/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [38.00ms]

- deepseek/deepseek-flash/unfamiliar-repo/rust#10: bun test v1.3.14 (0d9b296a)


src/ledger.test.ts:

# Unhandled error between tests
-------------------------------
11 |   expect(render(entries)).toBe("coffee: 3.50
                                    ^
error: Unterminated string literal
    at /private/var/folders/3w/ll17256n7q9b7g7bt0qr9hqr0000gp/T/.tmpSPrY91/bench-unfamiliar-repo-rust-SCkvOB/src/ledger.test.ts:11:32
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [19.00ms]

