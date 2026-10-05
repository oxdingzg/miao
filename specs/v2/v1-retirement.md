# V1 Retirement: TUI/Client Cutover to V2

## Goal

Make V2 the only session runtime the shipped clients use, then delete V1. This is the
endgame of the V1→V2 rebuild described in `docs/roadmap.md` (formerly `specs/v2/todo.md`). It is staged so each step is
independently verifiable and reversible, and it never leaves the daily `miao` command in a
half-switched state that double-writes or reads intermittently.

## Current topology

- V1 has been removed from the runtime: `packages/miao/src/session`, `packages/miao/src/tool`,
  and the legacy `/session/*`, `/permission/*`, `/question/*`, and `/sync/*` route groups and
  handlers are gone.
- The V2 engine (`packages/core/src/session/runner/llm.ts`) writes `session_message`; every
  shipped client — TUI, `--mini`, ACP, `miao run`, the web/desktop app, the native app — reads
  and writes through `/api/session/*`.
- Compatibility that remains is data-only: `packages/core/src/session/{backfill,compact,v1-read,legacy-tables,restore}.ts`
  migrate and read databases written before V2, and `packages/core/src/v1/config` still reads
  old-shape configuration.
- Non-session legacy routes (`/config`, `/mcp`, `/lsp`, …) are still served and are being migrated
  to `/api/*`; see `docs/roadmap.md` (P7 inventory archived at `docs/archive/p7-non-session-routes.md`).

The pre-removal topology (V1 and V2 mounted side by side in the release assembly) is described in
the git history before this change.

## Why it is staged

Switching the TUI write path while the V1 engine still runs the release would produce two writers
against the same session identity and two storage shapes (`message`/`part` vs `session_message`).
The cutover must flip engine, routes, and clients together, per surface, with a verified V2 path
first. V1 may only be deleted after `specs/v2/session.md` reaches parity and no shipped client
calls `/session/*`.

## Stages

**Stage 0 — design (this document).**

**Stage 1 — protocol detection seam.** Make a V2-only server self-identify consistently so a
client can select the V2 path. Align `/api/health` payload with what the detector expects and add
a conformance test. Additive; no behavior change to the V1 release.

**Stage 2 — protocol parity additions.** Add the V2 endpoints a client still needs beyond
`session.todo` / `session.children`: `session.status`, `session.diff`, `session.fork`,
`session.shell`, `session.skill`, and the `revert`/`unrevert` aliases. Each with core + handler +
regenerated SDK, verified against the parity table.

Progress: `session.todo`, `session.children`, `session.status`, `session.shell`, `session.skill`,
`session.diff`, `session.fork`, `session.command`, `session.rename`, `session.archive`,
`session.remove` landed. `session.fork` replays the parent's stored event rows under the child
aggregate through `EventV2.replay`, remapping every message-scoped identifier so the projected
`session_message` primary keys stay unique. It also copies the parent's event-less projection
(backfilled legacy rows at a negative sequence) into the child with fresh ids, so forking a
backfilled session keeps its legacy history. `session.command` renders the V2 template semantics
(positional placeholders, `$ARGUMENTS`, trailing-argument append). `rename` / `archive` publish a
new durable `session.next.info.updated` event; `remove` deletes the projected row and clears the
aggregate's events.

`revert` / `unrevert` aliases are not needed: V2 already exposes `revert.stage` / `revert.clear` /
`revert.commit`, which is what the clients call.

Stage 2 is complete. Stages 3, 4, and 5 have landed: the runtime is V2-only. The remaining work is
the legacy JS SDK (P5) and the non-session legacy routes (P7).

The app already reaches these through `packages/app/src/utils/server-compat.ts` while they are
missing, so the cutover (Stage 3–4) can proceed without them and they can be filled in behind it.

**Stage 3 — old-session visibility (revised).** The original "dual-read shadow" is not viable:
V2 reads only `session_message`, while existing sessions live in V1's `message` / `part`
(`session/history.ts` reads `SessionMessageTable` only, and a migration
`20260622170816_reset_v2_session_state` explicitly clears V2 state). A V2 read of a V1 session is
therefore empty, so reads cannot move ahead of writes. Two viable options, in order of
preference:

1. **Backfill migration.** A one-time migration converts each V1 session's `message` / `part`
   rows into projected `session_message` rows so the V2 read model and runner can serve them.
   Old sessions become continuable on V2; V1 then only owns the engine, not the read path.
2. **Read fallback.** `SessionStore.context` falls back to V1 `message` / `part` (mapped to
   `SessionMessage`) when a session has no `session_message` rows. Simpler, but keeps V1 schema
   dependencies in V2 and delays V1 deletion.

Option 1 is preferred because it is the only path that lets V1 be deleted. It needs an explicit
message/part → `SessionMessage` mapping and must preserve ordering and tool state.

**Option 1 landed (opt-in backfill).** `SessionBackfill.backfill` (core) converts each V1 session's
`message` / `part` rows into projected `session_message` rows, one transaction per session, and is
exposed as `miao db backfill` rather than an automatic migration so it never mutates history
without an explicit command. It is idempotent and also repairs a session that already has a
projection but still holds stranded legacy messages. Because `session_message.seq` is the EventV2
aggregate sequence, backfilled legacy rows are written strictly below every existing and future
sequence (negative when the session has no projection yet) so the next event cannot collide with
them. `--dry-run` reports the pending counts without writing.

Option 2 landed (read fallback). `SessionStore.context` and `SessionV2.messages` fall back to the
legacy `message` / `part` tables (mapped through `session/v1-read.ts`) when a session has no
`session_message` rows, so an un-migrated session reads the same through either API. Backfill is
still required before V1 can be deleted, because the fallback keeps V1 schema dependencies in V2.

**Stage 3 guard (landed).** `SessionStore.historyState` classifies a session as
`empty` / `legacy` / `projected` / `mixed` (`mixed` = a legacy message missing from the
projection). Every V2 write path — the runner drain plus `prompt`, `shell`, `skill`, `switchAgent`,
`switchModel`, `command`, `fork`, `compact`, `resume` — refuses a `legacy` or `mixed` session with
`Session.LegacyNotMigratedError`, surfaced as a 503 telling the user to run `miao db backfill`.
An old session is therefore never run against an empty projected context, and no new `mixed` state
can be created. The `miao db backfill` run converts (or repairs) it to `projected`, after which it
reads and continues normally.

**Stage 4 decision.** Keep the migration explicit: no automatic backfill at startup or upgrade.
The 503 from the guard is the signal a client should surface to prompt the user to run
`miao db backfill` once before the cutover.

**Stage 4 — write flip, per surface (landed; rollbacks later removed).** Session writes,
`context`/`messages`, `get`/`todo`/`list`/`rename`/`remove`/`diff`, permissions, questions, and
status all go through `/api/session/*`, with V2 shapes mapped in
`packages/tui/src/context/session-v2-read.ts`. The TUI and the app/desktop/web surfaces always use
V2. The temporary `MIAO_TUI_V2=0` and `?protocol=v1` rollbacks were removed with V1.

Behaviors that changed because V2 has no exact equivalent (confirm during soak): `session.list`
drops the V1 `start` recency filter and filters roots client-side; status comes from
`v2.session.active()` plus a derived per-session status instead of a bulk endpoint; the last-turn
diff is session-scoped (no message cutoff); share/unshare is hidden.

Creation is now fully V2: `SessionCreate` publishes `session.next.created.1` (current
`Session.Info` plus `slug`/`version`) instead of the legacy `session.created`, so the create path
writes no V1 durable event. The V1 projector remains only to read/backfill older databases.

**Stage 5 — delete V1 (landed).** The V1 session engine and tools
(`packages/miao/src/session`, `packages/miao/src/tool`), the `/session/*`, `/permission/*`,
`/question/*`, and `/sync/*` route groups and handlers, and the `MIAO_TUI_V2=0` / `?protocol=v1`
rollbacks are removed. `packages/core/v1` (config, permission, session) and the core session
migration readers remain deliberately: they are needed for backward-compatible reads and
`miao db backfill` / `compact` / `restore`. The legacy JS SDK package and the non-session legacy
routes are the remaining P5/P7 work.

## Acceptance for the cutover

- A session driven entirely through `/api/session/*` produces `session_message` rows and no
  `message`/`part` rows.
- The TUI and app show identical transcripts for the same session before and after the write flip.
- `bun run typecheck` plus `packages/core`, `packages/miao`, `packages/tui`, `packages/client`
  suites pass at every stage.
- No shipped client imports or calls a `/session/*` (V1) route; the routes are no longer served.

## Stage 1 (first round, complete)

- Align `packages/protocol/src/groups/health.ts` and `packages/server/src/handlers/health.ts` so
  `/api/health` returns a stable, versioned payload including the process id.
- Make `packages/app/src/utils/server-protocol.ts` select V2 from that payload, with a test.
- Regenerate the SDK.
