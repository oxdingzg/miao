# Versioned execution workers

Status: design, 2026-10-05; revised 2026-10-06 to close the P0/P1 findings of the
first review. Extends `specs/runtime-upgrades.md` ("Future service replacement")
into a concrete architecture. Not yet implemented.

The first review found that the split as originally written would produce a system
that "looks hot-swappable but actually drops events, double-writes, and
split-brains". The extra sections below (cross-process event delivery, projection
ownership, worker database access, cooperative fencing, crash recovery, control
channel trust, process-scoped service ownership) are prerequisites, not
follow-ups. They cite the code that makes each one necessary.

## Problem

One Runtime process owns a database's storage lock **and** runs Session
execution in-process (`RuntimeHost.start` builds `SessionExecutionLocal.node`
and the `SessionRunner`). The execution build is therefore pinned to the Runtime
process. Installing a release replaces the program on disk but leaves the
running Runtime's loaded code unchanged, and a compatible client silently joins
that older owner (`RuntimeConnect.ensure` compares only the wire protocol and
`configurationID`; the mismatch is only reported, never enforced,
`packages/miao/src/runtime/connect.ts:109`). The result is that a new window can
issue new prompts that are executed by the previous release's code, with no
signal to the user.

`specs/runtime-upgrades.md` deliberately preserves this shared-service model and
states that running different execution builds for one database is a separate
architecture change. This spec defines that change.

## Goal

After installing a release:

- new Sessions and new provider turns execute the **installed** build;
- a provider turn already in flight is not interrupted;
- one database still has exactly one storage owner and one serialized execution
  owner per Session;
- durable admission and exactly-once promotion are preserved;
- a client sees the same live event stream and the same Session status no matter
  which process runs the turn.

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
                         │ durable-event projection (Runtime-owned) · client event fan-out · remote leases ·  │
                         │ per-Session serialized ownership (session_lease) · routing · migration            │
                         └───────────────┬────────────────────────────────────────────────────────────────────┘
                                         │ local control channel (loopback + credential)
                          ┌──────────────┴───────────────┐
                          ▼                              ▼
              execution worker (build A)      execution worker (build B)
              SessionRunner · tools · LLM     SessionRunner · tools · LLM
              run-scoped Location services    run-scoped Location services
```

- **Runtime (coordinator)** keeps everything it already owns: the storage lock
  (`RuntimeOwnership`), discovery, authentication, the durable `session_input`
  inbox, the event store, project/Location services, database migration, and
  remote-control administration. It no longer runs `SessionRunner`. It owns the
  per-Session execution lease and routes drains to workers. Admission stays here:
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
- `build` is covered by the identity proof. `RuntimeIdentity.sign`
  (`packages/core/src/runtime/identity.ts:56`) and the attest comparison must
  include `build`, otherwise a Runtime could advertise a build it cannot prove.
- The workspace-revision source for source and preview runs is defined here: the
  git revision of the checkout that produced the running program, read at
  startup. When it cannot be determined, `build` is omitted and routing degrades
  to `version` comparison.
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

### Cooperative fencing

An expiring lease is not enough: a worker whose event loop is blocked (a long
synchronous tool, `node-pty`, a `SIGSTOP`) stops heartbeating while its already
scheduled side effects keep running. If the Runtime then reassigns the Session,
two drains run at once. Fencing must therefore be **cooperative on the worker**,
not only a conditional row update:

- The worker records its current lease epoch in the request context it passes
  down through the runner.
- Before any of the following, the worker issues a compare-and-swap "still
  holder" check and aborts the turn (releasing the lease) if it lost it:
  - every durable write;
  - input promotion;
  - every provider boundary (the same safe boundary the runner already uses to
    reload projected history).
- The check is cheap and local (the `session_lease` row is in the same database
  the worker already has open), so it does not add a cross-process round trip.
- The Runtime never reassigns a Session whose lease is still valid and whose
  holder is still heartbeating; expiry plus a lost CAS is the only way a turn is
  fenced.

A fenced worker stops before the next side effect; it never re-runs a provider
call that may already have produced output, matching
`specs/runtime-upgrades.md` ("an interrupted provider/tool call must never be
automatically replayed").

### Cross-process event delivery to clients

The client live stream is currently in-process, so a worker's events would never
reach a client. `/api/event` is built on `EventV2.allBounded`
(`packages/core/src/event.ts:182`), and the server-side `EventForwarder` also
subscribes to `events.listen` (`packages/miao/src/server/event-forwarder.ts:23`).
Both `listen` (`event.ts:654`) and `notify` (`event.ts:436`) are in-process
publish/subscribe. The durable stream already has a cross-process poll fallback
(`event.ts:131`), but no local route uses it.

The split therefore requires an explicit fan-out:

- The Runtime owns the client-facing `/api/event` stream. Workers do not serve
  clients.
- A worker publishes its durable events into the shared event store (it already
  opens the database read/write). The Runtime's client stream is driven by the
  durable poll, not the in-process `PubSub`, so a worker's events appear to
  clients with no extra wiring.
- Non-durable, turn-scoped signal (streaming deltas that do not deserve a
  durable row) is forwarded over the worker control channel as an ephemeral
  message the Runtime re-emits to clients. The durable projection stays the
  source of truth; ephemeral forwarding may be coalesced or dropped under load
  without breaking correctness.
- Naming and shape of the ephemeral control message is part of this spec so the
  TUI sees a single ordered stream regardless of which worker produced it.

### Projection ownership

`commitDurableEvent` runs the registered projector inline, in the same
transaction that appends the row (`projectors.get(event.type)` at
`packages/core/src/event.ts:266`; registration via `event.ts:667`, and
`SessionProjector.node` is wired in `packages/core/src/session.ts:827`). The
original architecture diagram assigned projection to the Runtime, but the code
projects in the writer. Two processes both writing projections would drop or
duplicate rows.

Ownership is therefore fixed by writer:

- **Each durable event is projected by the process that commits it.** The
  projection runs in the same transaction as the append, so it is atomic and
  exactly-once by construction.
- Because a Session's execution writes are serialized by its lease, only the
  lease holder commits and projects that Session's execution events. The Runtime
  commits and projects Runtime-owned events: admission, lease acquire/renew/
  release, and placement.
- The projector registry must be loadable without the storage lock so a worker
  can construct `SessionProjector`. This is the same requirement as worker
  database access below.
- The rule is per event type: the schema manifest for each durable event must
  name its single writer class (Runtime or lease holder), and both processes
  assert they only ever commit types they own.

### Database access by workers

`Database.node` unconditionally acquires the shared storage lock
(`RuntimeOwnership.acquireShared`, `packages/core/src/database/database.ts:43`)
and applies migrations (`DatabaseMigration.apply`, `database.ts:31`). A second
process that opens the same database hits `RuntimeOwnership.BusyError`
(`packages/core/src/runtime/ownership.ts:7`). The original spec said "workers
never migrate" without saying how a worker opens the database at all.

The worker therefore opens a **participant** connection that:

- does not call `RuntimeOwnership.acquireShared` (the Runtime keeps the one
  storage lock);
- never calls `DatabaseMigration.apply`; if the schema version is older than the
  worker's build, the worker refuses to start and the Runtime keeps routing to a
  compatible worker (or fails the turn with a clear error);
- opens the same file read/write under WAL (`database.ts:25`), so it can commit
  durable events and projection rows;
- shares one SQLite connection per process, with the same busy-timeout and WAL
  settings, so the two processes interleave without corruption.

The Runtime is the only writer of migrations and the only process allowed to
upgrade the schema.

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

### Cross-process session semantics

The in-process coordinator exposed more than routes; the split must preserve the
observable semantics for each:

- `resume` propagates a terminal `RunError` to the caller. Across processes the
  Runtime cannot receive a thrown exception; the worker reports the terminal
  result over the control channel and the Runtime resolves the waiting `resume`
  with the same success/failure value.
- `wait` / `awaitIdle` (`packages/core/src/session/delegation.ts:100`) await a
  child Session reaching idle. Today this is a local fiber join; after the split
  the Runtime must re-resolve it from the lease registry plus the durable
  `Prompted` boundary, and a child that is reassigned mid-wait must still
  resolve.
- `status` reports a phase (idle / running / waiting). The Runtime derives the
  phase from the lease registry and the last durable event, so a Session drained
  by a worker reports the same phase a local drain would.
- `interruptIf(sessionID, executionID)` maps `executionID` to its holder. The
  Runtime keeps the mapping; the worker that holds it is the target. A worker
  restart must not lose the mapping for a still-running `executionID`.

### Worker control channel

"Reuses the existing authentication" is not sufficient on its own:

- Worker control methods must be callable **only** by a worker holding the
  Runtime credential; they must not be reachable by an ordinary client or a
  remote grant. They carry a distinct capability, not just the shared HTTP
  surface.
- The first version pins one worker protocol version. The Runtime records each
  worker's protocol version at registration and refuses to route unsupported
  work to it; a worker that does not advertise what the Runtime needs is retired
  rather than used.
- Capability negotiation (so a newer Runtime may assume an older worker
  implements a method) is the follow-up that makes mixed versions safe; until it
  lands, the Runtime and workers it spawns are from the same release.

### Process- and Location-scoped services

The runner needs Location-scoped services (LSP, MCP, formatter, file watcher,
git), and several of them own process-level background loops
(`ToolOutputStore.cleanupNode`, model catalog refresh, observability). If both
processes hold them, LSP/MCP are started twice, cleanup runs twice, and
formatters race on the same files.

Ownership is fixed as:

- **Runtime-owned, shared:** anything that must have one instance per database —
  the model catalog, observability export, the storage/event store, and the
  Session inbox.
- **Worker-owned, per drain:** services the runner actually drives while
  executing (LSP, MCP clients, formatter, watcher). The worker holds them for
  the Sessions it leases and disposes them at the safe boundary, exactly as the
  in-process instance disposes on Session teardown.
- The Runtime never holds a worker-owned service; the worker never holds a
  Runtime-owned one. The rule names each service in one place so the wiring is
  auditable.

### Runtime learning the installed build

`InstallationVersion` is compiled into the running process, so the Runtime
cannot read a newer build's version from its own memory. The original spec asked
the Runtime to "observe that the installed build differs" without giving it a
channel.

The channel is the one already used by `miao runtime restart`: `CliProgram`
resolves the installed binary (`packages/miao/src/runtime/connect.ts:123`) and
spawns it detached (`connect.ts:125`, `child.unref()` at 139). The Runtime:

- on each client connect and on a timer, resolves the installed program path the
  same way `restart` does, asks it for its `build`/`version` (a `--version`
  style probe), and compares with the running owner's and every worker's build;
- when the installed build differs, starts or reuses a worker of that build and
  marks it preferred;
- when the installed program cannot be resolved or probed, keeps routing to the
  current worker and surfaces the mismatch through the existing connect warning
  (`connect.ts:109`) rather than failing prompts.

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
- **Promotion once.** Promotion only happens under a valid lease, after the
  cooperative holder check, and the projector writes the visible `Prompted`
  message and marks the inbox row promoted in one transaction, so two workers
  cannot double-promote.
- **Admission stays in the Runtime.** A worker never admits input; it only
  promotes already-admitted rows.
- **Migrations stay in the Runtime.** Workers open the database read/write under
  WAL (participant connection above) but never migrate and never take the
  storage lock.

### Crash recovery

The point of the split is that the coordinator survives a worker crash, but the
original spec never defined what happens to a Session a dead worker held.

- **Detection.** A crashed worker stops renewing its leases and stops
  heartbeating. When a lease expires, the Runtime marks every Session that
  worker held as unowned.
- **Reassignment.** The Runtime reassigns those Sessions to a live worker and
  dispatches a wake, exactly as if the Session had just been promoted. An
  expired lease is never renewed by the old holder (compare-and-swap on epoch),
  so recovery cannot race the old worker.
- **Running tools.** Any tool still projected as `running` for a reassigned
  Session is failed with `Tool execution interrupted` before the new worker
  drains it, so a side effect that may have happened is never replayed.
- **Admitted-but-unpromoted input.** `session_input` rows are durable and
  Runtime-owned, so they survive the crash untouched; the next drain promotes
  them. No input is lost.
- **Interrupted turn.** The last assistant turn is left as projected (partial
  output is kept, not replayed), consistent with `specs/runtime-upgrades.md`
  ("an interrupted provider/tool call must never be automatically replayed").
  Recovery resumes at the next wake, not by re-running the lost turn.
- This section is the mechanism the regression row "the Runtime reassigns the
  Session" previously assumed but did not define.

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
  assume an older worker implements them (until then Runtime and workers are the
  same release).
- A rolling handoff for a Session with a long-running background subagent.
- Worker placement beyond the local machine (the coordinator/worker split is
  the seam that makes future remote placement possible).

## Regression coverage

- A worker acquires, renews, and releases a lease; a non-holder cannot renew or
  release it, and an expired lease cannot be renewed.
- A worker that loses its lease before a durable write, a promotion, or a
  provider boundary aborts the turn and performs no further side effect.
- Two workers competing for one Session yield exactly one drain; the loser does
  not promote input or execute tools.
- A worker crash lets the Runtime reassign the Session; the abandoned `running`
  tool is failed, never replayed; admitted `session_input` survives.
- A client's `/api/event` stream receives a worker's durable events (via the
  durable poll) and its ephemeral stream signal (via the control channel).
- Each durable event type is projected by exactly one writer class, and a worker
  refuses to commit an event type it does not own.
- A worker opens the database without the storage lock, never migrates, and
  refuses to start against a newer schema.
- Across a build change, an in-flight provider turn completes on the old worker
  and the next wake runs on the new worker.
- `interruptIf` routes to the current holder and is a no-op for a stale
  `executionID`; `resume` propagates the terminal `RunError`; `wait`/`awaitIdle`
  resolve for a Session that is reassigned mid-wait.
- Admission remains in the Runtime; a worker never writes a new `session_input`
  row.
- The existing `packages/core` execution, `run-coordinator`, and `packages/miao`
  runtime tests still pass with a single in-process worker.
