# TUI Read-path Cutover to V2

## Goal

Make the TUI render sessions from the V2 API (`/api/session/*`) instead of the legacy V1 sync,
behind a flag first, then by default. This is Stage 3/4 of `specs/v2/v1-retirement.md` for the TUI
surface. It must not leave the daily TUI half-switched.

> Status (2026-10-03): landed and then superseded. The TUI always reads and writes V2; the
> `MIAO_TUI_V2` flag and the V1 fallback were removed with the V1 runtime. The design below is
> historical.

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

- **Flag**: `MIAO_TUI_V2` now defaults to on (V2 read and write); set `MIAO_TUI_V2=0` to fall back to
  the V1 read/write path. It started default-off for the read slice and was flipped on with the
  Stage 4 write flip.
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

Landed, now **default-on**:

- `Flag.MIAO_TUI_V2` defaults to on; `MIAO_TUI_V2=0` forces the V1 read/write path.
- `packages/tui/src/context/session-v2.ts` maps `session.context` output to the TUI's
  `Message` + `Part` shape (unit-tested in `packages/tui/test/session-v2.test.ts`).
- `session.sync` loads messages from `sdk.client.v2.session.context`, and the Stage 4 write flip
  routes create/prompt/shell/command/interrupt/fork/compact/revert/permission/question to V2, so a
  flagged/default TUI session is V2-only. Live updates come from V2 `session.next.*` events via a
  debounced re-hydration.
- The session list, todo, diff, and session `get` remain on V1 while the V1 routes are still mounted.

Still open (needs a live `miao-dev` session):

- End-to-end rendering of a projected session and a legacy session.
- The `LegacyNotMigratedError` prompt hint on send.
- Removing the remaining V1 reads and deleting V1 (Stage 5).
