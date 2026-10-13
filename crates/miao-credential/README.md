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
