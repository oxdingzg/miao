# Refresh trigger for an expired credential on an engine-owned Session

An amendment to [ADR-09](../crates/miao-engine/docs/adr/0009-credential-refresh-ownership.md):
ownership stays exactly as decided there — this documents the missing trigger
path that makes an engine-owned Session recover from an expired access token
without giving the engine a write path.

## The gap

The engine re-reads the credential store at each provider turn and fails the
run with `credential is expired; its owning broker must refresh it`
(`crates/miao-engine/src/credential.rs`, `Error::Expired`). The failure is
correct, but nothing acts on it: the run dies, the host shows an auth error,
and recovery requires the operator to refresh manually. The product broker
refreshes on its own schedule; it does not observe the engine's expiry.

## Design

1. **Structured expiry on the engine.** `Error::Expired` carries the
   normalized identity the read path already has — credential id and
   integration — plus the expiry timestamp. No secret material moves. The run
   failure the host already translates (run-failed journal event) surfaces
   this structured payload.
2. **Host observes and routes to the owner.** The host translator, on an
   expired failure for an engine-owned Session, resolves the Session's
   credential binding from the product store and hands the refresh to
   whichever owner ADR-09 records for that row:
   - daemon-owned rows: a `CredentialDaemon.get` — the daemon refreshes on
     read and is the sole writer;
   - TS-owned rows: the product broker's refresh path — the TS runtime stays
     the sole writer in the sidecar phase.
   The engine remains strictly read-only; nothing here changes that.
3. **One retry, no loops.** After the owner reports success, the host admits
   a single steer ("credential refreshed; continue") so the drained Session
   retries the turn with the fresh token — the same reminder mechanism the
   worktree move uses. A failed or timed-out refresh surfaces the original
   auth error to the model and stops; the host never retries refresh in a
   tight loop.

## Engine changes

`Error::Expired` becomes a structured variant (id, integration,
expires-at) populated where the bound value is validated. The normalized
metadata already exists at the read boundary (`credential.rs` `Metadata`);
the change threads the identity into the binding's validation call sites.

## Host changes

1. `packages/miao/src/engine/bridge.ts` maps the structured payload off the
   run-failed translation.
2. A credential broker port (owner-resolving refresh, ADR-09 routing) is
   provided to the engine layer beside the owner router; the product-tools
   composition wires it to the daemon socket / product broker.
3. On success the translator admits exactly one retry steer.

## Tests

- Engine: an expired bound credential fails with the structured identity.
- Host: an expired run failure triggers exactly one owner refresh and one
  retry steer; a refresh failure surfaces the original error without a
  retry; a daemon-owned row routes through the daemon socket.
- ADR-09 conformance: no engine write path appears anywhere in the flow.
