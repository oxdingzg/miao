# Acceptance record — WSP-01 legacy workspace-create surface removal

Item: `WSP-01`, follow-up to the record of 2026-11-07
(`2026-11-07-wsp01-workspace-surfaces.md`). Tree: this change, based on `main` at
`2d23794579`. Commands ran on the Linux build host (`x86_64-unknown-linux-gnu`)
from `crates/miao-tui/` at that tree.

## What the earlier pass left unaccepted

The 2026-11-07 record named three things it did not claim. The first two traced to
one cause, found by reading the protocol instead of re-running the dialog:

- The TUI's `WorkspaceCreate` binding sent a generic `host_call` op
  (`workspace.create`). The engine's command table
  (`crates/miao-engine/src/protocol.rs`) has no such method: the wire deserialises
  every request into the `Command` enum, so the op could only ever answer
  `invalid request`. The success path the record called unaccepted was not an
  unexercised path — it was a path with no server.
- The workspace list the same pass could not prove rows for reads
  `MIAO_WORKSPACES_JSON`, which no product entry point exports. The dialog is a
  live extension point (the engine serves whatever the host exports), but the
  product ships no producer for it.

The op targeted the retired TypeScript workspace registry
(`packages/server/src/handlers/workspace.ts`), which the Rust product replaced
with the worktree lifecycle: the worktrees dialog (`n` new, `enter` move,
`d` remove) and `miao worktree add|list|remove`, both accepted in the 2026-11-07
record.

## The change

Removes the dead path so the product no longer advertises a key that cannot work:

- `Action::WorkspaceCreate` and its `<leader>C` binding;
- `App::create_workspace()` and the `workspace.create` host-result branch.

The generic `host_call` channel itself stays: the device-pairing actions
(`remote.reject` and friends) still send through it, and their fate belongs to the
remote-binding item, not this one. The workspace list dialog and its env export
stay untouched as the extension point they are.

## Suites

| what | command | observed |
| --- | --- | --- |
| worktree suites behind the acceptance bullet | `cargo test --lib worktree::` (from `crates/miao-engine/`) | `test result: ok. 4 passed; 0 failed` |
| relative paths and project ownership in Location | `cargo test --lib placement::` | `test result: ok. 5 passed; 0 failed` |
| a Session-level tool sees the same worktrees | `cargo test --lib worktree_tool_tests` | `test result: ok. 2 passed; 0 failed` |
| the TUI compiles and passes its suites after the removal | `cargo test` (from `crates/miao-tui/`) | all `test result: ok`, exit 0 |

The one timing-sensitive file (`input_latency`, a PTY latency measurement) passed
solo in 1.07 s and once flaked when the whole suite ran while a full dependency
build linked on the same host; it is load jitter around a 30 s bound, not a
behaviour change of this commit. Separately, the run surfaced a real defect on
`main`, unrelated to this change: `crates/miao-cli`'s worktree-filtered unit tests
fail deterministically when run together because they mutate the process-global
`MIAO_ENGINE_STORAGE`/`HOME` environment; that fix lands as its own change.

## What this record does not claim

- No new workspace registry exists. If the product later grows one, it arrives as
  an explicit engine command with its own design, not by resurrecting the removed
  op.
- Windows path spelling and remote placement remain unexercised, as before.
