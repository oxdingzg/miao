# TUI Read-path Cutover to V2

## Goal

Make the TUI render sessions from the V2 API (`/api/session/*`) instead of the legacy V1 sync,
behind a flag first, then by default. This is Stage 3/4 of `specs/v2/v1-retirement.md` for the TUI
surface. It must not leave the daily TUI half-switched.

## Current state (verified)

- The TUI talks to the legacy SDK (`@opencode-ai/sdk`): `sdk.client.session.*`, `config.providers`,
  `provider.list`, `app.agents`, `command.list`, `lsp.status`, and per-session message/event sync
  in `packages/tui/src/context/sync.tsx`. Messages come from `sync.data.message[sessionID]`.
- It builds its own screen from the V1 session route `packages/tui/src/routes/session/index.tsx`.
- A separate V2 client exists at `@opencode-ai/sdk/v2` with `createOpencodeClient`.
- V2 read semantics (just landed): a `legacy` (never projected) or `mixed` session is **readable**
  through `session.context` (mapped from `message`/`part`), but **continuing** it
  (`session.prompt`) fails with `Session.LegacyNotMigratedError` until `miao db backfill` runs.

## Design

- **Flag**: `MIAO_TUI_V2=1` selects the V2 read path for the TUI; default remains V1 so the release
  is unaffected. A later stage flips the default per surface.
- **Client**: when the flag is set, create a V2 client (`@opencode-ai/sdk/v2`) for the same server
  URL alongside the legacy one.
- **Messages**: for the open session, read `v2.session.context({ sessionID })` for the projected
  message list and subscribe to `v2.session.events({ sessionID })` for live updates, in place of
  `sync.data.message[sessionID]`.
- **Provider/agent/model lists**: read from the V2 endpoints (`session`-adjacent plus the existing
  `config.providers`/`provider.list`, which are server-wide and unchanged).
- **Legacy sessions**: reading works via the V2 mapping. When the user tries to send a prompt to a
  `legacy`/`mixed` session, surface the `LegacyNotMigratedError` as a clear action ("run
  `miao db backfill`") instead of a raw error.
- **Writes**: this stage is **read-only**; prompts still go through V1 so there is exactly one
  writer. The write flip is Stage 4.

## Non-goals

- No write flip here (separate stage).
- No app/desktop/web changes (separate surfaces).

## Acceptance

- With `MIAO_TUI_V2=1`, opening a V2-projected session renders the same transcript as V1.
- Opening a legacy session renders its mapped transcript; sending a prompt shows the backfill hint.
- With the flag unset, behavior is byte-for-byte the current V1 experience.
- Needs interactive verification on `miao-dev` before any default flip.

## Status

Not started. Requires a live `miao-dev` session to verify; cannot be validated headlessly.
