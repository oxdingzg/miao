# Auxiliary provider usage and coverage

`usage_report` retains its primary conversational turn counters and adds:

- `providerUsage`: normalized observed axes across primary (including partial) usage rows and
  settled auxiliary attempts, with observation/axis coverage and a weighted cache-read ratio.
- `auxiliary`: accepted, semantically rejected and provider-failed attempt counts, role/path/model
  detail, actual reported usage and the started/completed ledger interval when timestamps exist.
- `providerDetail`: individual primary and auxiliary observations for catalog pricing at each
  observation's own input tier. Semantic rejection does not erase reported billable usage.

No raw `providerMetadata` values are summed into normalized totals. A missing axis stays absent in
individual observed usage and is `null` in aggregate tokens when never reported. A real measured
zero has nonzero coverage. Cache-read ratios remain unknown when their required axes are missing
or the observed breakdown is invalid. Role receipts do not become the primary context-size anchor.

Role completion receipts link their start sequence. Identity records distinguish request-level
fallback metadata from reply-level metadata; an opaque model is not guessed. Attempt intervals use
ledger wall-clock timestamps, and stay unknown for missing or backwards timestamps. They are not
provider TTFT measurements.

The product projects primary, partial and auxiliary observations through its own model catalog,
including rejected work, while keeping conversational turn counts separate. `SessionInfo.Usage.coverage`
exposes observation counts, auxiliary counts, missing usage, unavailable pricing and axis coverage.
Observed aggregate token subtotals survive unknown model identity, even when they cannot be priced.
Empty observations are not converted into fake priced zero-token turns. Older reports use the
existing compatible projection.

These are observed per-Session costs/subtotals, not a provider invoice or a claim that unknown
requests are free. Catalog prices, unreported usage and missing cache axes limit completeness.
Child Sessions remain separate scopes; their `SubagentStop` evidence includes all observed primary
and auxiliary usage coverage so a parent+child evaluation can aggregate each scope exactly once.
Copied historical fork messages do not create duplicate usage facts.
