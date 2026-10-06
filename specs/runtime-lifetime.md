# Runtime lifetime and idleness

Status: design, 2026-10-06. Extends `specs/runtime-upgrades.md` and supplies the
quiescence signal its "Future service replacement" requires. Prerequisite for the
automatic replacement discussed there and for `specs/v2/execution-workers.md`.
Not yet implemented.

## Problem

`RuntimeConnect.ensure` starts the persistent Runtime detached and unreferenced
(`launch`, `packages/miao/src/runtime/connect.ts:123`, `child.unref()`), and
nothing ever reaps it. That launch path and `RuntimeHost.start`'s `stop` closure
(`packages/miao/src/runtime/host.ts`) are the only start and shutdown paths; the
latter runs only when `miao runtime stop` or a `SIGINT`/`SIGTERM` is explicitly
delivered. The Runtime therefore:

- is invisible: no client surface names it, its release, its clients, or its
  lifetime, so a user cannot tell it is running or which release executes their
  prompts; and
- has no shutdown moment: the upgrade contract asks for "a graceful explicit stop
  after tasks finish", but a background daemon shared by every window has no
  observable point at which the user is expected to run it.

These are one missing concept. The Runtime has no defined lifecycle and no
definition of **idleness**, so neither a shutdown timing nor a visibility surface
exists to attach to it.

## Goal

Give the Runtime an explicit, observable lifecycle with an automatic idle exit:

- a well-defined activity vector; while any part of it is non-empty the Runtime
  stays alive;
- when the vector is empty for a grace period, the Runtime drains and exits on its
  own, removing discovery and releasing storage ownership;
- a client and an operator can see the Runtime, its release, its clients, and how
  soon it will exit;
- the idle exit is a graceful drain, never a kill: one storage owner throughout,
  no double promotion, and no automatic replay of an interrupted provider/tool
  call.

## Non-goals

- Running different execution builds for one database, or replacing a live
  Runtime without a stop. That is `specs/v2/execution-workers.md`; this spec only
  supplies the lifecycle and quiescence it needs.
- Changing the client wire protocol, the durable Session contract, or the event
  vocabulary.
- Cluster placement or cross-machine ownership.
- Making the Runtime a managed OS service. An always-on supervisor mode is a
  follow-up (see below), not this change.
- `miao attach <url>`: explicitly attached servers keep their existing semantics
  and are not affected by the local Runtime lifetime.

## Lifecycle

```
starting ──ready──▶ ready(active) ──vector empty for grace──▶ draining ──▶ stopped
                        ▲   │
                        └───┘  activity resumes; countdown resets
```

- **starting**: storage ownership is acquired, services are built, the listener
  is bound, discovery is published (`RuntimeHost.start`). A Runtime is not a
  candidate for idle exit until it is `ready`.
- **ready(active)**: serving. A countdown is armed whenever the activity vector
  is empty and cancelled as soon as it becomes non-empty again.
- **draining**: the idle predicate held at the instant the countdown fired, so
  the ordered shutdown `RuntimeHost.stop` already performs is started
  uninterruptibly: stop the control agent, interrupt active execution, stop the
  listener, dispose execution and `AppRuntime`, remove discovery, release storage.
  If activity appears after the predicate passed but before the drain closes
  admission, the drain still completes; a newly connecting client is either
  served until it disconnects or observes discovery removal and starts a
  successor. Two owners never share one storage.
- **stopped**: terminal; the process exits.

`miao runtime start` (foreground), `stop`, and `restart`
(`packages/miao/src/cli/cmd/runtime.ts`) keep their current meaning. An explicit
`stop` is an unconditional drain and is never gated on idleness.

## Activity vector

The Runtime stays alive while any of the following is non-empty. Each entry names
its current source; counts are process-local truth plus durable admission.

| Activity | Source today | Effect |
| --- | --- | --- |
| Connected local clients | `WebSocketTracker` sockets (`packages/miao/src/server/routes/instance/httpapi/websocket-tracker.ts`) and `/api/event` streams | pin while at least one client is connected |
| Active execution | `SessionExecution.active` / `executions` (`packages/core/src/session/execution.ts:11`) | pin while any Session drains |
| Unpromoted input | `SessionInput.countPending` (`packages/core/src/session/input.ts:212`); add a global unpromoted count | pin until admitted input is promoted |
| Scheduled prompts | `SessionSchedule.count()` (`packages/core/src/session/schedule.ts`) | pin; jobs are process-local and deliberately non-durable, so idle exit would drop them |
| Background work | `BackgroundJob` (`packages/core/src/background-job.ts`) and running background subagent children (`docs/background-subagents.md`) | pin while a job runs |
| Remote control | `RuntimeControlAgent.start` when `MIAO_REMOTE_CONTROL_CONFIG` is set (`packages/miao/src/runtime/control-agent.ts`) | pin while a Hub connection or a live remote grant exists |
| Drain cleanup in flight | `SessionRunCoordinator` `stopping` entries (`packages/core/src/session/run-coordinator.ts`) | pin until cleanup finishes |

Notes:

- "Connected client" is a transport connection, not a window. A TUI that holds a
  Session open but sends nothing is still a connected client and pins the
  Runtime; this is what keeps a pane's Session alive.
- The vector is a liveness predicate, not an admission barrier. Idle exit is safe
  because it reuses the drain, which already interrupts execution and disposes
  services in order. It must not be used to reject new admissions while `ready`.

## Pinning and configuration

Automatic idle exit is opt-in only in the sense that the vector itself pins
background capabilities. Two settings are startup configuration, owned by the
Runtime exactly as `MIAO_CONFIG_CONTENT` is (a client cannot change them for a
running owner):

- `runtime.lingerMs` (env `MIAO_RUNTIME_LINGER_MS`): grace after the vector
  becomes empty before draining.
  - `> 0` (default, proposed 5 minutes): stay warm this long so a returning
    client reuses the process and its loaded build.
  - `0`: exit as soon as the last client disconnects and nothing else is active;
    this is the "follow the visible client" model.
  - `-1`: never exit automatically; run until `miao runtime stop` or a signal.
    This is the supervisor / always-on mode, and the choice when remote control
    or scheduled work must survive indefinitely.
- `runtime.remoteControlPins` (proposed default `true`): whether a configured
  remote-control agent pins the Runtime. Set `false` to let the Runtime idle-exit
  between remote activity and be restarted by the next remote request. Pinning by
  default preserves the current "outbound agent is always available" expectation.

## Idle shutdown sequence

When the countdown fires:

1. Re-evaluate the vector atomically; if it is non-empty, re-arm the countdown and
   return to `ready(active)`.
2. Enter `draining` and run the existing ordered `RuntimeHost.stop` path.
   Interrupt active execution by its execution identity so a delayed request
   cannot interrupt a successor (`docs/runtime.md`).
3. Remove discovery **before** releasing storage ownership
   (`RuntimeDiscovery.remove`, "Remove before releasing ownership"), then release
   the OS lock, then exit the process.
4. Never kill a successor: if another Runtime started while draining, the exiting
   process releases only its own resources and leaves it alone, matching the
   cross-release guard in `RuntimeConnect.stop`.

The contract from `specs/runtime-upgrades.md` is preserved: an interrupted
provider/tool call is left as projected and is never automatically replayed, and
an abandoned `running` tool is failed rather than retried.

## Visibility

The idle predicate and the counts it reads are also the visibility surface, so
what an operator sees cannot drift from what decides the exit.

- Extend the authenticated local status (the `status` method behind
  `RuntimeAccessCLI` / `RuntimeAdministration.status`) with a lifecycle block:
  `state`, `startedAt`, `idleDeadline`, and the activity vector with per-client
  detail (pane / session where known). This is authenticated local
  administration; it does not change discovery or the wire protocol.
- `miao runtime status` prints `state` and, when a countdown is armed, "exits in
  Ns"; `miao runtime ps` lists attached clients, active Sessions, unpromoted
  input, scheduled jobs, background jobs, and the remote-control state.
- The TUI shows the shared Runtime in its status line: release, protocol, and an
  attached/shared indicator, plus the existing release-mismatch warning
  (`RuntimeConnect.mismatch`, `packages/miao/src/runtime/connect.ts:109`). The
  line stays quiet when there is one client and one release.
- `miao doctor` reports the Runtime process, the discovery and lock paths, and
  whether a recorded Runtime is orphaned or unreachable.

## Relationship to upgrades

Idleness is the "execution quiescence signal" that `specs/runtime-upgrades.md`
names as a prerequisite for automatic service replacement.

- **Near term, manual.** `miao runtime restart` exists today because the loaded
  build does not change on install. With idle exit, the common case needs no
  command: when the user is done the Runtime exits, and the next client starts the
  installed build. When the Runtime is pinned (remote control, scheduled jobs,
  background work) it cannot idle; the mismatch warning remains and the user runs
  `miao runtime restart` when convenient.
- **Next, automatic self-replacement at quiescence.** Once the activity vector and
  the lease accounting from `feat/runtime-lease` and
  `specs/v2/execution-workers.md` land, the Runtime can compare the installed
  build with its own (the probe channel `RuntimeConnect.restart` already uses) and
  replace itself at the next quiescence instead of exiting. The user then never
  picks a moment; the Runtime picks a safe one. The existing rule holds: a busy
  Session that never quiesces is never silently interrupted, so a `max-linger` cap
  with an explicit "restart now" escape is still needed.
- **Endgame.** The coordinator/worker split makes routine upgrades not require a
  stop at all. Idle exit remains the lifecycle for the coordinator.

## Regression coverage

- The vector empty for the grace period drains gracefully: execution is
  interrupted, discovery is removed, the storage lock is released, and the
  process exits.
- New activity during the countdown resets it; no shutdown happens while a client,
  an active drain, unpromoted input, a scheduled job, a background job, or a
  remote-control connection is live.
- A client connecting during `draining` is either served until it disconnects or
  observes discovery removal and starts a successor; two owners never share the
  storage.
- `lingerMs=0` exits after the last client; `lingerMs=-1` never auto-exits and
  still stops on `miao runtime stop` or a signal.
- An idle exit never re-runs an interrupted provider/tool call; any `running` tool
  is failed, matching `specs/runtime-upgrades.md`.
- Cross-release `stop` still verifies identity and never shuts down a successor.
- `miao runtime status` / `ps` report the same vector the idle predicate uses.

## Follow-ups

- Automatic self-replacement at quiescence (depends on the execution-workers lease
  and admission barrier).
- A durable scheduled store: today `SessionSchedule` jobs are process-local and
  non-durable, so idle exit would drop them. Either keep them pinning the Runtime,
  or make them durable and reconcile them on the next owner.
- Remote-control idle policy: decide whether a configured-but-disconnected Hub
  agent keeps the Runtime alive, and how remote traffic restarts an idle-exited
  Runtime.
- An OS supervisor mode (`launchd` / `systemd --user`, socket activation) for
  always-on installations, where the service manager owns the lifecycle instead of
  the idle policy.
- A user-visible "keep running in background" toggle mapped to `lingerMs=-1` for
  the current storage.
