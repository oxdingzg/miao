# ADR-09: Credential freshness and refresh ownership

Status: Proposed. Extends [ADR-06](0006-provider-semantics.md) (credentials) and
[ADR-08](0008-delivery-and-migration.md) (migration).

## Context

Credentials live in two shapes the engine already reads: the product's V2
credential database (`credential` rows whose `value` is JSON) and the legacy
`auth.json` file. An OAuth entry carries an access token, a refresh token, an
absolute expiry and an account id; an API-key entry carries only the key. The
engine opens these stores read-only, re-reads at each provider turn, and reports
`expired` when the access token is past its expiry — it never writes.

An access token is shared state. If two runtimes both refresh it, they race: one
rotates the token, the other persists a stale or already-consumed one, and a
later authentication fails for reasons that look unrelated. The store is not a
place two owners may write.

## Decision

- **Exactly one component owns refresh for a given credential.** Ownership is
  exclusive and explicit, never implicit.
- **While the product's TypeScript runtime remains the runtime** (the sidecar
  phase of ADR-08), it stays the sole broker: it refreshes and writes, and the
  engine stays strictly read-only. The engine's job is to read the current
  access token each turn and to fail clearly (`expired`) when it is stale, so a
  missing refresh is visible rather than silent.
- **When the engine becomes the sole runtime** (the replacement end state), the
  engine — or a dedicated broker process it supervises — becomes the sole owner.
  Only then does the engine gain a write path to the credential store, and the
  read path is unchanged: both the V2 database and the legacy file shape stay
  supported.
- **Never both.** There is no configuration in which the engine and the product
  refresh the same credential concurrently. A hand-off is a migration step, not
  a coexistence mode.
- **The engine's read path accepts both stores and both kinds** (API key and
  OAuth), and never logs secret bytes; only normalised id/integration/kind/expiry
  metadata is observable.

## Consequences

- The sidecar phase needs no engine-side broker and cannot double-refresh.
- The refresh implementation is bounded and lands with the replacement, not
  before it, keeping the engine read-only until it is the only writer.
- A future client that wants the engine to refresh must first make it the sole
  runtime for that credential, which is the ADR-08 hand-off.
