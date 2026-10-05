# Versioned execution workers

Status: design, 2026-10-05. Extends `specs/runtime-upgrades.md` ("Future service
replacement") into a concrete architecture. Not yet implemented.

## Problem

One Runtime process owns a database's storage lock **and** runs Session
execution in-process (`RuntimeHost.start` builds `SessionExecutionLocal.node`
and the `SessionRunner`). The execution build is therefore pinned to the Runtime
process. Installing a release replaces the program on disk but leaves the
running Runtime's loaded code unchanged, and a compatible client silently joins
that older owner (`RuntimeConnect.ensure` compares only the wire protocol and
`configurationID`). The result is that a new window can issue new prompts that
are executed by the previous release's code, with no signal to the user.

`specs/runtime-upgrades.md` deliberately preserves this shared-service model and
states that running different execution builds for one database is a separate
architecture change. This spec defines that change.

## Goal

After installing a release:

- new Sessions and new provider turns execute the **installed** build;
- a provider turn already in flight is not interrupted;
- one database still has exactly one storage owner and one serialized execution
  owner per Session;
- durable admission and exactly-once promotion are preserved.

## Non-goals

- Clustering across machines. This is local, multi-process only.
- Changing the durable Session contract, event vocabulary, or client wire
  protocol. Clients stay compatible; only the owner-side execution placement
  changes.
- Hot-loading execution code into one process. Compiled releases cannot load a
  newer build's code in place; a separate process is the only swap unit.

## Architecture

Split the current single Runtime process into one stable coordinator and one or
more versioned execution workers.

```
                         ┌────────────────────────────── Runtime (coordinator) ──────────────────────────────┐
client ── HTTP/WS ──────▶│ storage lock · discovery · durable admission (session_input) · event store ·       │
                         │ client/remote leases · per-Session serialized ownership (session_lease) · routing  │
                         └───────────────┬────────────────────────────────────────────────────────────────────┘
                                         │ local control channel (loopback + credential)
                          ┌──────────────┴───────────────┐
                          ▼                              ▼
              execution worker (build A)      execution worker (build B)
              SessionRunner · tools · LLM     SessionRunner · tools · LLM
```

- **Runtime (coordinator)** keeps everything it already owns: the storage lock
  (`RuntimeOwnership`), discovery, authentication, the durable `session_input`
  inbox, the event store, project/Location services, and remote-control
  administration. It no longer runs `SessionRunner`. It owns the per-Session
  execution lease and routes drains to workers. Admission stays here:
  `SessionV2.prompt` keeps calling `SessionInput.admit` and then signals the
  router.
- **Execution worker** runs the agent loop — `SessionRunner`, model resolution,
  tool registry, permissions, filesystem — for the Sessions it holds. A worker
  is the installed binary started in worker mode, so a worker always runs the
  installed build.
- **Per-Session lease** is the serialized ownership chain. A worker must hold
  the lease for a Session before it drains, renews it while draining, and
  releases it when it reaches a safe boundary. The Runtime is the arbiter.

### Build identity

The lease and routing must distinguish builds, not just software versions, so
source and preview builds are handled too.

- `RuntimeIdentity` gains an optional `build` alongside `version`. For a release
  binary `build` is the content hash of the execution bundle; for a local run it
  is the workspace revision. When omitted, `version` identifies the build.
- `RuntimeDiscovery.Record` carries the same optional `build` so a client can
  compare its own build with the running owner without a request.
- The wire protocol is unchanged. `build` is advisory routing metadata, never a
  compatibility test; an unknown `build` degrades to version comparison.

### Per-Session lease

A durable `session_lease` row (in the owning database) plus an in-memory
registry:

```
session_lease(
  session_id   TEXT PRIMARY KEY,
  epoch        INTEGER NOT NULL,   -- monotonic; bumped on every acquisition
  holder       TEXT NOT NULL,      -- workerID
  build        TEXT NOT NULL,      -- holder's build identity
  expires_at   INTEGER NOT NULL,   -- heartbeat deadline
)
```

Acquire, renew, and release are conditional updates that compare `epoch` and
`holder` (compare-and-swap); a stale holder can never mutate a row it lost.
Leases expire, so a crashed worker is fenced without operator action.

The Runtime keeps the in-process `SessionRunCoordinator` for coalescing, the
drain cap (`MIAO_MAX_CONCURRENT_DRAINS`), and busy/idle reporting, but the
cross-process truth is the lease. A drain acquires the lease before it promotes
or dispatches work and releases it at the safe boundary.

### Routing

`SessionExecution` becomes a router on the Runtime side:

- `resume(sessionID)` / `wake(sessionID)` select the worker assigned to the
  Session — or the preferred (installed-build) worker when the Session is
  unassigned — and deliver one coalesced wake over the control channel.
- `interrupt(sessionID)` and `interruptIf(sessionID, executionID)` route to the
  worker recorded as the current holder for that `executionID`. A stale
  `executionID` is a no-op, exactly as the in-process coordinator behaves today.
- `active` / `executions` read the lease registry so clients see the same
  `{ type: "running", executionID }` shape regardless of which worker drains.

The worker speaks the same local HTTP surface with the Runtime credential and
registers over a worker control method. It reuses the existing authentication
and identity proof; no new public API is exposed.

### Safe boundary and handoff

The runner already promotes input and reloads history only at safe provider-turn
boundaries. Handoff reuses that boundary:

1. The Runtime observes that the installed build differs from a running
   worker's build and starts (or reuses) a worker for the installed build,
   marking it preferred.
2. New `wake`/`resume` assignments go to the preferred worker.
3. A Session currently drained by an older worker keeps running; the worker
   finishes the in-flight provider turn and releases the lease at the safe
   boundary.
4. The next wake assigns the Session to the preferred worker. The older worker
   exits once it holds no leases and the Runtime retires it.
5. `interruptIf` keeps working across the handoff because the Runtime tracks the
   current `executionID` holder.

### Exactly-once and fencing

- **Single owner.** The lease serializes drains per Session across processes.
  The existing durable projection of `running` tools plus the "fail any tool
  still projected as `running` from a previous process with `Tool execution
  interrupted`" rule means a fenced or crashed worker never silently replays a
  side effect.
- **Promotion once.** Promotion only happens under a valid lease, and the
  projector writes the visible `Prompted` message and marks the inbox row
  promoted in one transaction, so two workers cannot double-promote.
- **Admission stays in the Runtime.** A worker never admits input; it only
  promotes already-admitted rows.
- **Migrations stay in the Runtime.** Workers open the database read/write under
  WAL but never migrate. The Runtime keeps the one storage lock.

## Upgrade flow

```
client(vB) ── start ─▶ Runtime(vA) ── spawn ─▶ worker(vB)         (preferred)
                          │  route new wakes ──▶ worker(vB)
                          │  old turn finishes on worker(vA)
                          ▼  release lease
                      route next wake ──▶ worker(vB); retire worker(vA)
```

## Transition

A Runtime that predates this spec has no router or worker support, so the first
release that introduces workers still needs one explicit `miao runtime stop`
(assisted by `miao runtime restart`, see below). From that release onward,
upgrades are handled as above without a restart.

## Follow-ups

- Capability negotiation for worker control methods before a newer Runtime may
  assume an older worker implements them.
- A rolling handoff for a Session with a long-running background subagent.
- Worker placement beyond the local machine (the coordinator/worker split is
  the seam that makes future remote placement possible).

## Regression coverage

- A worker acquires, renews, and releases a lease; a non-holder cannot renew or
  release it, and an expired lease cannot be renewed.
- Two workers competing for one Session yield exactly one drain; the loser does
  not promote input or execute tools.
- A worker crash lets the Runtime reassign the Session; the abandoned `running`
  tool is failed, never replayed.
- Across a build change, an in-flight provider turn completes on the old worker
  and the next wake runs on the new worker.
- `interruptIf` routes to the current holder and is a no-op for a stale
  `executionID`.
- Admission remains in the Runtime; a worker never writes a new `session_input`
  row.
- The existing `packages/core` execution, `run-coordinator`, and `packages/miao`
  runtime tests still pass with a single in-process worker.
