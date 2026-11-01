# VAL-03 (mechanical half): keystrokes and time-to-state for the six tasks

Measured 2026-11-01 on the macOS build host with the PTY harnesses in
`crates/miao-tui/tests/`. VAL-03 asks for six tasks measured on time-to-state,
keystrokes, mistakes and rework. Five of the six have a part that a script
observes honestly — keystrokes are counted by construction and the clock stops
when the target state renders. Mistakes and rework are not observable this way
for any of the six and stay with the operator session.

## Result

| task | route | keystrokes | time to state | harness |
| --- | --- | --- | --- | --- |
| startup | warm store, first frame | — | 31 ms (p50) | `startup_latency.rs` |
| startup | warm store, ready to type / to submit | — | 36 ms / 6 ms (p50) | `startup_latency.rs` |
| finding a session | walk `j` × 149 + `Enter` (200-Session catalog) | 150 | 456 ms | `interaction_cost.rs` |
| finding a session | `/` + `session 150` + `Enter` | 13 | 48 ms | `interaction_cost.rs` |
| editing input | line motions to fix the first character | 44 | 46 ms | `interaction_edit.rs` |
| editing input | retype the line instead | 120 | 91 ms | `interaction_edit.rs` |
| approval | `1` on the blocking decision | 1 | 5 ms | `interaction_approval.rs` |
| failure recovery | recall the failed prompt + send again | 2 | 30 ms | `interaction_recovery.rs` |
| reviewing changes | `<leader>g` | 2 | not measured yet | — |

Reading it: the two findings VAL-03 can already state as numbers are that a
query costs 11× fewer keystrokes than walking a 200-row list (13 vs 150) and that
line motions cost about a third of retyping (44 vs 120), for the same outcome on
the same surface. Approval is one keystroke because the decision is a closed
vocabulary, not because of any optimisation.

Startup figures are quoted from `docs/experiments/2026-11-01-startup-latency`,
which owns that measurement and its own scenario definitions; they are repeated
here only so one table answers VAL-03's "startup" line.

## What is not measured, and why

**reviewing changes.** The panel opens on `<leader>g` — the rendered frame in the
test log shows the `workspace changes` title — but its body stays empty under the
scripted engine, and the test therefore fails rather than reporting a fake
number. Ruled out while trying: the workspace not being a repository (a `git
init` plus commit in the fixture left it empty), and a pending approval holding
the panel (removing `MIAO_TUI_FAKE_APPROVAL` changed nothing). `decode()` in
`workspace_changes.rs` accepts the fixture's payload shape (`repository: true`
plus a three-file list). The next step is to find where the request or its
response is lost; until then this row stays empty.

**mistakes and rework.** Not observable from a script for any of the six tasks: a
mistyped query, a wrong pane, or an overshoot is exactly what a scripted keystroke
sequence does not have. This is the part of VAL-03 that needs a real operator
record, and no amount of harness work substitutes for it.

**the shape of a real workspace.** The session catalog is synthetic (200 rows,
newest first) and the change set is a fixed three files, so these are costs per
surface, not per real workload.

## Reproduction

```sh
cd crates/miao-tui
cargo test --test interaction_cost   -- --nocapture   # finding a session
cargo test --test interaction_edit   -- --nocapture   # editing input
cargo test --test interaction_approval -- --nocapture # approval
cargo test --test interaction_recovery -- --nocapture # failure recovery
cargo test --test startup_latency    -- --nocapture   # startup
```

Each prints one `VAL-03 …` line with the numbers above. The harnesses drive the
real `miao-tui` binary over a PTY against a scripted engine, so the surface under
measurement is the product's, not a mock.
