# Moving an engine-owned Session into a git worktree

[Roadmap](roadmap.md) §9 gate 2 landed the product-tool reverse bridge, but the
bridge's manifest (`packages/miao/src/engine/product-tools.ts`) carries only the
peer tools and `push_notification`. The worktree pair
(`enter_worktree`/`exit_worktree`, `packages/core/src/tool/worktree.ts`) is
missing, and this document records why it cannot be added as a manifest-only
change, and the design that closes the gap.

## 1. Why a bridge-only implementation corrupts Sessions

Three engine facts make the TS move semantics unusable for a rust-owned
Session:

1. **The engine's per-Session root is immutable.** `Store::initialize` rejects
   an existing Session whose stored root differs (`Error::Conflict`, "another
   location cannot adopt the identity"), and `admit_at` applies the same rule
   to a prompt carrying a different root (`crates/miao-engine/src/store.rs`).
2. **One owner process per Location.** The host memoizes one engine child
   process per storage DB (`packages/miao/src/engine/owners.ts`, keyed by
   `storage`); a location mismatch on the same storage fails with
   `engine_owner_conflict`. Inside the engine, `Inner.tools` binds exactly one
   workspace and every Session API re-checks
   `store.location(session) == tools.location()` (`crates/miao-engine/src/runtime.rs`).
3. **The TS move does not reach the engine.** `MoveSession` publishes
   `SessionEvent.Moved` in the product catalog
   (`packages/core/src/control-plane/move-session.ts`); nothing engine-side
   consumes it.

A naive manifest registration would therefore move the product catalog while
the engine keeps executing tools in the old directory — or worse: after the
catalog moves, the next initialize lands in the destination's empty per-location
DB and **strands the entire history** in the source DB.

The product semantics to preserve are the TS ones: enter creates a worktree on
the Session's project and moves the Session into it; the running drain yields
at the boundary ("a moved Session cannot keep running in the runner that served
the move"), a steer reminder documents the move, and the owner of the new
directory promotes it (`packages/core/src/session/placement.ts`).

## 2. What already exists

- The **TS worktree flow**: `SessionPlacement.enterWorktree/exitWorktree`
  (create/remove via `ProjectWorktree`, move via `MoveSession`, steer reminder).
- The **transfer machinery** (#1105–#1148): durable freeze states
  (`packages/core/src/session/migration.ts`), the bundle format
  `miao.session.transfer.v1`, staged imports with exact-retry adoption
  (`crates/miao-engine/src/transfer.rs`), activation that validates against the
  product placement before importing history, snapshots, and bindings
  (`crates/miao-engine/src/transfer_activation.rs`), and reverse-migration
  deltas (#1144, #1148).
- The **coordinator pattern**: `SessionMigrationCoordinator.toNative`
  (`packages/core/src/session/migration-coordinator.ts`) shows the ordered,
  crash-recoverable freeze → stage → switch → activate → complete sequence this
  feature reuses.

## 3. Contract bindings that must change

The import path hard-requires a TypeScript source:
`stage_session_transfer` rejects any bundle whose
`source["source"]["engine"] != "ts"` (`crates/miao-engine/src/transfer.rs`).
Activation additionally requires the product placement's planned and placed
storage to equal the destination engine DB and both locations to equal the
bundle's `source.session.location`
(`activate_session_transfer`, `crates/miao-engine/src/transfer_activation.rs`);
it never writes `engine_location` for the imported Session. `prepare()` itself
validates agent/model/snapshots but not location, so the location coupling is
confined to activation.

An engine-owned Session lives in its own history DB, so a worktree move is a
**rust → rust live transfer**: source engine DB at the checkout directory,
destination engine DB at the worktree directory. That needs a native source
export (none exists — `export_session_transfer_import` re-exports an
already-staged import; `export_session_transfer_delta` is a TS-canonical,
text-only lossy view) and an activation that can land the identity at a new
location.

## 4. Engine changes

1. **Native source export** — a new store operation that serializes a live
   Session from `engine_message`/state/events into the
   `miao.session.transfer.v1` bundle shape with `source.engine == "rust"`:
   timeline, snapshots inventory, model binding, account, agent, and state
   operations. Tool calls, media, and opaque reasoning must be explicit
   refusals (parity with the reverse delta's rule), or fully carried — the
   implementation PR decides, but silence is not allowed.
2. **Rust-source staging and activation** — `stage_session_transfer` accepts
   `source.engine == "rust"` bundles; the bundle gains an explicit
   `target_location` (absolute path). Activation validates the product
   placement's planned/placed location against `target_location` instead of the
   bundle source location, and writes `engine_location = target_location` as
   part of the activation transaction, so the imported identity is addressable
   at the worktree directory immediately (no reliance on a first-prompt root).
3. **Moved-result run settlement** — a product tool reply may carry
   `{"moved": true, "directory": …}`. The run loop settles that tool call
   durably and ends the run cleanly (no further provider turn in the old
   location), the rust analog of the TS runner refusing a turn whose location
   no longer matches. A run with planned-but-unsettled approvals refuses the
   move at the host instead (the approval validation binds
   `engine_location.root` to the approval).
4. **Tests** — export/stage/activate round-trip including the `engine_location`
   write, moved-result settlement, and refusal cases (in-flight approvals,
   non-absolute target).

## 5. Host changes

1. **Move coordinator** (`packages/core/src/session/`, sibling of
   `migration-coordinator.ts`): claim ownership, verify no active drain except
   the one waiting on this very product-tool call, freeze, native source export
   from the source owner, stage + activate into the destination owner (its
   per-location DB is created on first owner build), rewrite the placement row
   `{storage, location}` atomically with the switched state, complete, then
   admit the steer reminder (which now routes to the new owner) and wake it.
   Crash recovery mirrors `toNative`: states are durable, activation is never
   aborted after switching, and a stale source freeze aborts only pre-switch.
2. **Bridge tools**: `enter_worktree`/`exit_worktree` join the manifest in
   `packages/miao/src/engine/product-tools.ts`. The executor creates/removes
   the worktree through `ProjectWorktree`, runs the move coordinator, and
   returns the `moved` reply so the engine settles the run. Placement rewrite
   happens before the reply so the post-reply world is consistent.
3. **Cancellation window**: the source owner's drain is waiting on the bridge
   call while the transfer runs. After the moved reply is written, the host
   cancels the source owner's Session (durable cancellation cascade) to retire
   the old process-local drain; the new owner owns every later turn.
4. **Children and timers**: child Sessions are not moved (parity with the TS
   flow — children are independent identities). Timers/crons re-arm through the
   existing dead-child supervisor sweep
   (`crates/miao-engine/docs/cross-process-timers.md`).

## 6. Non-goals

- No live flip between engines or into a foreign project (existing placement
  rules stand); the move stays within one project's worktree family, exactly
  like `MoveSession`'s project check.
- No migration of an existing TS-placed Session to rust as part of a worktree
  move; that remains the offline `switch-plan` path.

## 7. Acceptance

- An engine-owned Session enters a worktree: subsequent `bash`/`read` tools
  execute in the worktree, the TUI shows the new directory, and history
  (including the tool call that performed the move) replays from the new owner.
- `exit_worktree` returns it to the primary checkout; `remove` deletes the
  worktree.
- Crash at every coordinator state leaves either the source frozen (abortable)
  or the destination active (recoverable by completing the same import), with
  no stranded-history window.
- A Session with a pending approval refuses `enter_worktree` with a clear
  error and keeps running.
- TS-placed Sessions keep today's behavior byte-for-byte; the manifest addition
  is invisible to them.
