# V1 Retirement: TUI/Client Cutover to V2

## Goal

Make V2 the only session runtime the shipped clients use, then delete V1. This is the
endgame of the V1→V2 rebuild described in `specs/v2/todo.md`. It is staged so each step is
independently verifiable and reversible, and it never leaves the daily `miao` command in a
half-switched state that double-writes or reads intermittently.

## Current topology (verified)

- The release binary is built from `packages/miao` and its TUI worker serves the V1 server
  assembly (`packages/miao/src/server/routes/instance/httpapi/server.ts`), which mounts **both**
  the V1 `/session/*` tree and the V2 `/api/session/*` tree.
- The TUI writes through the legacy SDK `client.session.*` → `/session/*` (V1 engine
  `packages/miao/src/session/prompt.ts`, which writes `message`/`part`).
- The V2 engine (`packages/core/src/session/runner/llm.ts`) writes `session_message`.
- The web/desktop app already renders V2 events (`packages/app/src/context/data.tsx`) and has a
  protocol detector (`packages/app/src/utils/server-protocol.ts`), but the release server serves
  `/global/health`, so the app selects V1.

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
`session_message` primary keys stay unique. `session.command` renders the V2 template semantics
(positional placeholders, `$ARGUMENTS`, trailing-argument append). `rename` / `archive` publish a
new durable `session.next.info.updated` event; `remove` deletes the projected row and clears the
aggregate's events.

`revert` / `unrevert` aliases are not needed: V2 already exposes `revert.stage` / `revert.clear` /
`revert.commit`, which is what the clients call.

Stage 2 is complete. The remaining work is the cutover itself (Stages 3–5).


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

**Option 2 landed (read fallback).** `SessionStore.context` now falls back to reading the legacy
`message` / `part` tables and mapping them through `session/v1-read.ts` when a Session has no
`session_message` rows. This makes old sessions readable through the V2 API without touching data,
so Stage 3 (read shadow) can proceed. A backfill migration (Option 1) is still required before V1
can be deleted, because the fallback keeps V1 schema dependencies in V2.

**Stage 4 — write flip, per surface.** Flip writes to `/api/session/*` and run the V2 engine for
new sessions, one client surface at a time (TUI first, then app/desktop/web), each gated and
verified end to end (prompt, steer/queue, tool loop, compaction, permissions, revert). V1 routes
remain mounted but unused during the soak.

**Stage 5 — delete V1.** In the order from the migration map: app SDK shims → V1 route groups →
V1 session engine → V1 tools/transport → `packages/core/v1` schemas → legacy SDK → the
`packages/miao` server/engine. Each deletion only after its prerequisite stage is soaked.

## Acceptance for the cutover

- A session driven entirely through `/api/session/*` produces `session_message` rows and no
  `message`/`part` rows.
- The TUI and app show identical transcripts for the same session before and after the write flip.
- `bun run typecheck` plus `packages/core`, `packages/miao`, `packages/tui`, `packages/client`
  suites pass at every stage.
- No shipped client imports or calls a `/session/*` (V1) route after Stage 5.

## Stage 1 (this round)

- Align `packages/protocol/src/groups/health.ts` and `packages/server/src/handlers/health.ts` so
  `/api/health` returns a stable, versioned payload including the process id.
- Make `packages/app/src/utils/server-protocol.ts` select V2 from that payload, with a test.
- Regenerate the SDK.
