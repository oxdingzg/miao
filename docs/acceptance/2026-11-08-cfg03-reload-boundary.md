# Acceptance record — CFG-03 incremental hot reload for services

Item: `CFG-03`. Tree: `main` including #2685. Commands ran on the Linux build
host (`x86_64-unknown-linux-gnu`) from `crates/miao-engine/` and
`crates/miao-tui/` at that tree.

## The criteria this record accepts

**Reconfiguration lands per service when configuration changes, an active turn
accepts changes at a safe boundary, and unrelated state is never rebuilt.**

- *Per service*: each section reloads and reports independently — models
  (`config_reload_models`), instructions/context parts
  (`config_reload_context`), MCP connections (`config_reload_mcp`, including
  "a failed rebuild keeps the previous connection serving" and "an invalid
  manifest changes nothing"), permission/agent policy
  (`config_reload_policy`, including "a malformed policy fails the reload and
  keeps the running gates"), and LSP (`lsp.rs`: a reload reconciles the LSP
  section and keeps unchanged connections).
- *The safe boundary*: #2685's regression holds a turn genuinely in flight
  (a gated provider blocks the first call), lands the reload mid-flight, and
  requires the active turn to finish `completed` on the catalog it started
  with while the next admission resolves against the swapped catalog —
  `a_reload_during_an_active_turn_lands_at_the_boundary`, 3/3 consecutive
  green.
- *Unrelated state untouched*: the reload report names `changed` and
  `unchanged` sections explicitly; a no-change rewrite advances nothing
  (`generation` stays, `unchanged` lists the section), and the TUI's session,
  running turns and connections are not part of any rebuild.

## Suites

| what | command | observed |
| --- | --- | --- |
| models + the mid-flight boundary | `cargo test --test config_reload_models` | `2 passed; 0 failed` |
| instructions and context parts | `cargo test --test config_reload_context` | `1 passed; 0 failed` |
| MCP reconcile and failure keeping | `cargo test --test config_reload_mcp` | `4 passed; 0 failed` |
| policy swap, malformed keeps gates | `cargo test --test config_reload_policy` | `3 passed; 0 failed` |
| LSP reconcile keeps connections | `cargo test --test lsp` | `7 passed; 0 failed`, 1 ignored |

## What this record does not claim

- Windows unexercised, as before.
