# miao-credential

A standalone unix-socket daemon that is the **single refresh writer** for the
credential rows it serves. One process owns the read-refresh-write critical
region; every consumer — the engine, tools, the legacy TS broker during
migration — is a client.

## Why a daemon

A one-time refresh token must never be replayed after a rotation. The safest
way to guarantee that is not a cross-process lock protocol that two stacks
must keep in agreement, but a structural one: exactly one implementation of
the critical region, in exactly one process. The SQLite `credential` table
stays the shared source of truth; readers keep re-reading their row each turn
exactly as the engine's read-only bridge did — the daemon just guarantees that
what they read is fresh enough to survive a provider turn.

## Running

```sh
miao-credential serve --db /path/to/miao.db --socket /path/to/credential.sock
miao-credential discover --db /path/to/miao.db
miao-credential login --socket /path/to/credential.sock --credential-id cred_device --label Work
```

- `serve` binds the socket with `0600` permissions: the daemon speaks full
  credential values, so only the owning user may reach it.
- Refreshes start inside a five-minute margin before the stored expiry
  (`--refresh-margin-ms` to change it), so a turn never starts with a token
  that would die mid-turn.
- The OpenAI profile mirrors the TS broker's token request byte-for-byte
  (endpoint, `client_id`, form encoding, `miao/...` User-Agent), so the
  provider cannot tell the two writers apart.

## Protocol

One JSON object per line over the socket. Every reply echoes the request `id`.

```jsonc
{"id":1,"op":"get","credential_id":"cred_X","integration":"openai"}
{"id":2,"op":"refresh","credential_id":"cred_X","integration":"openai"}
{"id":3,"op":"discover"}
```

- `get` returns the stored credential value, refreshing it first when it sits
  inside the margin. This is what the engine calls once per provider turn.
- `refresh` forces a rotation and returns only the new expiry, never tokens.
- `discover` lists id/integration/label/kind/expiry and never serializes
  secret material.

Errors come back as `{"id":N,"error":{"code":"..."}}` with stable codes:
`missing`, `invalid`, `integration`, `not_refreshable`,
`refresh_rejected` (re-login; do not retry), `refresh_unavailable`
(transient; retry next turn), `io`, `database`, `protocol`.

## Concurrency and safety

- The daemon is the only writer: concurrent requests for one row serialize on
  a per-row mutex, and the row is re-checked under the lock, so a waiter whose
  row was already rotated returns the fresh value instead of replaying the old
  refresh token against the provider.
- Writes patch the stored JSON field-by-field (`access`, `expires`, and
  `refresh` only when the provider rotated it); `methodID`, `metadata`, and
  any future unmanaged fields survive a rotation untouched.
- A rejected refresh (400/401) is final for that refresh token: the daemon
  reports `refresh_rejected` and leaves the stored row untouched.
- During migration the legacy TS broker may still write rows the daemon does
  not own yet; `busy_timeout` covers that window, and per-row ownership moves
  to the daemon as migration lands.

## Device login and process ownership

`login` runs the OpenAI headless flow through the daemon. The client prints the
verification URL and user code, then polls an opaque handle. The device secret,
PKCE verifier, code exchange, account metadata extraction and credential insert
all happen inside the daemon. The handle expires after 15 minutes, polling
respects the server interval plus a three-second margin, and a completed handle
cannot be consumed twice. An existing credential ID is never overwritten.

The daemon holds a database-path lease for its entire serving lifetime. A
second daemon, including one using a different socket for the same database,
is rejected before it can take over an existing socket. Only stale socket
files may be removed; regular files and symlinks are rejected. The process
lease is distinct from the per-row refresh mutex.

## Ownership handoff

After draining provider turns and stopping the old broker, run:

```sh
miao-credential adopt --socket /path/to/credential.sock --credential-id cred_X --integration openai
```

The adoption transaction keeps the same credential ID, tokens, method and
account metadata, writes `metadata.miaoCredentialSocket`, and installs a durable
owner record. SQLite guards refuse updates/deletes from ordinary connections.
The daemon releases that guard only inside its own write transaction and
restores it before commit; rollback restores it too. Newly device-authorized
credentials are inserted with ownership in the same transaction.

Restart the updated TS runtime after adoption. It reads the ownership marker
before selecting a refresh implementation and resolves through the socket.
Owner unavailability is an authorization failure, never a fallback to TS
refresh. Its mutation/replacement APIs refuse daemon-owned identities.
The daemon refuses to refresh unadopted OAuth rows.

The handoff requires an idle old broker: a token request already in flight
cannot be undone by changing SQLite ownership. Storage guards prevent stale
writes, but cannot revoke such an external request. No real user credentials
are moved by tests or by installing this code.

## Provider profiles

One daemon owns the database lease and registers multiple integration profiles.
OpenAI and GitHub Copilot are enabled by default. The Console integration is
explicitly enabled with `serve --console-server URL` (and optional
`--console-client-id ID`). Select the login integration with
`login --integration openai|opencode|github-copilot`.

- OpenAI uses its device/code exchange and form-encoded refresh endpoint.
- Console uses JSON device and refresh requests, loads account/organization
  metadata, and preserves the selected organization through token rotations.
- Copilot uses GitHub device authorization. Its token is non-expiring in the
  existing repository contract (`expires: 0`), and no refresh endpoint is
  called. `serve --github-server URL` selects an Enterprise issuer.

Each pending login retains its selected profile. Unknown integrations are
rejected rather than routed to another integration's token endpoint. The
Console credential's recorded server must match the configured issuer on
refresh.
