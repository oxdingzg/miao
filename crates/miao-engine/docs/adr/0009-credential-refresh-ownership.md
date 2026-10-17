# ADR-09: Credential freshness and refresh ownership

Status: Accepted, including explicit daemon handoff. Extends [ADR-06](0006-provider-semantics.md) (credentials) and
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

## Explicit daemon handoff and rollback

The standalone `miao-credential` daemon can own individual product credential
rows before the TS execution core is retired. `adopt` installs a durable socket
marker and SQLite update/delete guards atomically. The TS broker observes the
marker and delegates refresh to that daemon; it does not remain a second writer.
The daemon holds a database-scoped process lease and serializes each row's
refresh and handoff operations.

`release` is the inverse migration, requested over the same local IPC endpoint:

```sh
miao-credential release --socket PATH --credential-id ID --integration INTEGRATION
```

It joins an in-flight rotation, then removes the owner marker and SQL guard in
one transaction, preserving the newest access/refresh tokens, expiry, account
metadata and method identity. An identical retry reconciles an already-released
row. An integration mismatch or a different recorded owner fails without
changing the row. A refresh waiting on the row lock rechecks ownership before
calling the provider, so it cannot rotate a token after handback. Subsequent
product refreshes use the original broker, and a later `adopt` reinstalls daemon
ownership. No secret material is returned by either migration command.

Verification: `miao-credential/tests/ownership.rs` exercises the SQL guards,
identity preservation and re-adoption on all platforms;
`miao-credential/tests/daemon.rs` exercises release during a real local token
request and CLI retry over the socket. These deterministic checks do not stand
in for real-account provider acceptance.

## Consequences

- The sidecar phase can retain the product broker or explicitly migrate a row
  to the standalone daemon; neither mode permits a second refresh writer.
- The engine remains a read-only consumer in both modes. Only the selected
  credential broker writes refresh results.
- A future client that wants the engine to refresh must first make it the sole
  runtime for that credential, which is the ADR-08 hand-off.
