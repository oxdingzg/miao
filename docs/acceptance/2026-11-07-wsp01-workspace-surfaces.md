# Acceptance record — WSP-01 project directory and workspace lifecycle

Item: `WSP-01`. Tree: `c922187e2a`, plus the two fixes this record travels with
(`fix/wsp01-workspace-surfaces`, PR #2663). Commands ran on the macOS build host
(`aarch64-apple-darwin`) against a debug build of `crates/miao-cli` at that tree,
from the crate directories the suites belong to. No network, no real provider: the
engine runs in-process with a placeholder credential, so every path below is the
product's own code rather than a scripted stand-in.

This record covers the first acceptance bullet only — **keeps project discovery,
naming, directory selection, the workspace list and the adapter**. The other three
bullets were accepted earlier and are not re-opened here.

## 1. Suites behind the criteria

| criterion | command | observed |
| --- | --- | --- |
| workspace identity, list and the move adapter | `cargo test --test workspace_transfer` (from `crates/miao-engine/`) | `test result: ok. 2 passed; 0 failed` |
| an explicit move carries a Session between locations | `cargo test --test transfer_move` | `test result: ok. 1 passed; 0 failed` |
| git plumbing is one owner (CLI, host and tools call the same adapter) | `cargo test --lib worktree:: -- --test-threads=1` | `test result: ok. 4 passed; 0 failed` |
| relative paths and project ownership unify in Location | `cargo test --lib placement:: -- --test-threads=1` | `test result: ok. 6 passed; 0 failed` |
| a Session-level tool sees the same worktrees | `cargo test --lib worktree_tool_tests -- --test-threads=1` | `test result: ok. 2 passed; 0 failed` |
| the TUI renders the workspace/worktree surfaces | `cargo test workspace` (from `crates/miao-tui/`) | `test result: ok. 14 passed; 0 failed` |
| working-tree status still answers per Session | `cargo test --test vcs` | `test result: ok. 5 passed; 0 failed` |

## 2. The real product pass

The surfaces were driven through a real TTY against the built product (not a unit
test): a PTY was forked, the TUI attached to it, keys written to the master, and the
raw ANSI stream replayed into a terminal emulator, so each excerpt below is what the
operator saw. Fixture: an empty git repository at `/private/tmp/wsp01-demo`.

### `/worktree` lists the checkout

```
┌ worktrees ───────────────────────────────────────────────────────────┐
│▸ checkout   /private/tmp/wsp01-demo                                  │
│enter move this session here · n new · d remove · esc close           │
└──────────────────────────────────────────────────────────────────────┘
```

### `n` creates a tree, and the list refreshes in place

Typing `demo-1` in the name dialog creates a real git worktree — `git worktree list`
afterwards reports `/private/tmp/wsp01-demo/.miao-worktrees/demo-1  df077a1 [demo-1]`
— and the dialog the operator returns to already shows it:

```
┌ worktrees ───────────────────────────────────────────────────────────┐
│▸ checkout   /private/tmp/wsp01-demo                                  │
│  demo-1   /private/tmp/wsp01-demo/.miao-worktrees/demo-1             │
│enter move this session here · n new · d remove · esc close           │
└──────────────────────────────────────────────────────────────────────┘
```

### `enter` moves the Session into the tree

Selecting the row and confirming reports `session moved` in the notice line. The move
is the product `MoveSession` host call; it needs the host's product database, which
the launcher injects as `MIAO_PRODUCT_DATABASE`. Started without that variable the
engine answers `move-session requires the host's product database` and the TUI shows
it as a failure notice — recorded here because it is how a hand-launched binary
behaves, not a defect.

### `d` asks before removing

```
┌ remove worktree ─────────────────────────────────────────────────────┐
│Remove the worktree "demo-1" and the branch it holds? Sessions still  │
│working there move back to the checkout first.                        │
│▸ cancel     remove                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

### `<leader>w` opens the workspace list

`ctrl+x w`:

```
┌ workspaces ──────────────────────────────────────────────────────────┐
│›                                                                     │
│▸ no workspaces                                                       │
│enter move session · esc cancel                                       │
└──────────────────────────────────────────────────────────────────────┘
```

`▸ no workspaces` is the honest answer here: the workspace list is host-prepared
(`MIAO_WORKSPACES_JSON`) and this hand-launched engine got none. What the row proves
is that the dialog opens and renders instead of failing the request.

### `<leader>C` reads a directory from the composer

`ctrl+x C` creates a workspace from the directory typed into the composer; with an
empty composer it answers `type a directory for the new workspace`, which is the
refusal path rather than a dialog. Recorded as observed; the success path needs a
host that serves `workspace.create`.

### The CLI owns the same plumbing

```
$ miao worktree list
/private/tmp/wsp01-demo
/private/tmp/wsp01-demo/.miao-worktrees/demo-2
```

Removal plans first, refuses an anchored tree without `--force`, and migrates on
`--force`:

```
$ miao worktree remove demo-2            # plan, then refusal with --apply
engine sessions · 1 anchored in …/8266b159….db (400.0 KiB)
  · removing the tree strands these sessions' cwd; move or close them first
miao worktree: 1 session(s) still anchor /private/tmp/wsp01-demo/.miao-worktrees/demo-2: move or close them first, or pass --force to point them back at the main checkout before removal

$ miao worktree remove demo-2 --apply --force
migrated 1 session(s) back to /private/tmp/wsp01-demo
removed demo-2
```

## 3. Two defects this pass found, and their fix

Both were found by driving the product, both block the acceptance bullet above, and
both are fixed in PR #2663 and re-verified on the same build.

**`<leader>w` could not list workspaces.** The TUI sent `workspaces` with an empty
`params` object; the engine envelope is adjacently tagged, so the unit command
rejected the key and answered `invalid_request: unsupported request workspaces`. The
transport already exposes `command()` for unit variants; the call now uses it. After
the fix the dialog renders (excerpt above).

**Removing a worktree could strand an anchored Session.** Removal counted anchored
Sessions only in the checkout's ledger. A tree created and worked in before any
Session moved into it anchors Sessions in its *own* ledger, which the checkout never
sees, so the tree was removed while a Session's cwd still pointed into it. Removal now
reads both ledgers and repoints both on `force`, matching what `miao worktree remove`
plans. After the fix, with one Session anchored in `demo-4`'s own ledger:

```
cannot remove the worktree demo-4: engine invalid_request: invalid request:
1 session(s) still anchor /private/tmp/wsp01-demo/.miao-worktrees/demo-4: move or
close them first, or pass force to point them back at the checkout
```

and `git worktree list` still shows `demo-4`.

## 4. What this record does not claim

- The workspace **create** success path is unaccepted: it needs a host that serves
  `workspace.create` (the TUI only sends the host call), and this pass ran without one.
  The refusal path (`type a directory…`) is what was observed.
- The workspace list was proven to open and render, not to render host-supplied rows;
  no host exported `MIAO_WORKSPACES_JSON` in this run.
- Unix only. Nothing here exercised Windows path spelling or a remote placement.
