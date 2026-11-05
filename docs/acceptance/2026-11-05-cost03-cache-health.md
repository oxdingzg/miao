# Acceptance record — COST-03 cache health and recommendations

Item: `COST-03`. Tree: `82d4e77eae` plus this record's commits. Commands ran on the
Linux build host from `crates/miao-engine`.

## Criterion 1 — cache health for the current Session is displayed

`usage_report` already carried `cacheDiagnostics` (observed requests and usage
observations, per-field coverage, per-turn history states, `invalidBreakdowns`,
`serverCacheState`, and a `hitRatio` withheld whenever it would not be measured), and
`miao stats <session>` prints that report for one Session (`crates/miao-cli/src/cli.rs`,
`stats_via_engine`). Recorded as accepted **at the CLI surface**.

Not accepted: the TUI sidebar does not read `cacheDiagnostics`, so a Session watched in
the product shows no cache line. That presentation gap is named here rather than
implied away.

## Criterion 2 — every unhealthy cache state carries an actionable recommendation

`cacheDiagnostics.recommendations` is new. Each entry is a `code` plus a `message` that
carries the numbers it is based on:

| code | when | message |
| --- | --- | --- |
| `invalidBreakdown` | a usage report counted more cache tokens than input tokens | the count, and that the ratio stays withheld |
| `unreportedCacheReads` | the provider reported cache reads on fewer turns than it reported usage | `reported N of M turns` and that caching is unmeasurable on the route |
| `noCacheReads` | every input token was reported uncached | the turn count, and the two things that fix it (stable prompt prefix, supported cache key) |

A healthy Session gets an empty list: the recommendation is the *state*, not a constant
line. This matters because `hitRatio` is `null` both when caching is unmeasurable and
when the breakdown is invalid — the recommendation says which of the two it is.

| command | observed |
| --- | --- |
| `cd crates/miao-engine && cargo test --test cache_health` | `1 passed; 0 failed` — one Session per state: `0.75` with no recommendation, `null` + `unreportedCacheReads`, `0.0` + `noCacheReads`, `null` + `invalidBreakdown` with `1 usage report(s)` in the message |
| `cd crates/miao-engine && cargo test --test usage_lineage --test retry_attribution --test hook_cost --test interventions_rework --test auxiliary_usage` | `2 + 2 + 3 + 2 + 2 passed; 0 failed` — the existing report readers are unchanged by the new field |

Result: **accepted** for criterion 2. Criterion 3 (linked PRs, records, version) is
satisfied by this record and its pull request; the TUI presentation gap above stays open
on the item's criterion 1.
