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

Progress: `session.todo`, `session.children`, `session.status`, `session.shell`, `session.skill`
landed. Remaining and why they are harder:

- `session.diff` — needs a persisted session baseline snapshot; V2 captures a start snapshot per
  turn but does not yet persist the session snapshot range into queryable history.
- `session.fork` — the event-sourced message model has no per-message copy primitive; a fork must
  replay the parent's durable events under a new Session aggregate.
- `revert` / `unrevert` aliases — V2 already exposes `revert.stage` / `revert.clear` /
  `revert.commit`; the alias surface depends on the exact client call shapes and must be added
  with the client cutover so the semantics stay consistent.


**Stage 3 — dual-read shadow.** TUI and app read V2 session data (`/api/session/:id/context`,
`/event`) and render it, while still writing through V1. Verify V2 sees everything V1 records
(no lost messages) before any write flip. This proves read parity with zero write risk.

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
