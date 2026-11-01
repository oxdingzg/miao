# VAL-03 (mechanical half): keystrokes and time-to-state for the six tasks

Measured 2026-11-01 on the macOS build host with the PTY harnesses in
`crates/miao-tui/tests/`. VAL-03 asks for six tasks measured on time-to-state,
keystrokes, mistakes and rework. All six have a part that a script observes
honestly — keystrokes are counted by construction and the clock stops when the
target state renders. Mistakes and rework are not observable this way for any of
the six and stay with the operator session. Reviewing changes only became
measurable after the fix described below.

## Result

| task | route | keystrokes | time to state | harness |
| --- | --- | --- | --- | --- |
| startup | warm store, first frame | — | 31 ms (p50) | `startup_latency.rs` |
| startup | warm store, ready to type / to submit | — | 36 ms / 6 ms (p50) | `startup_latency.rs` |
| finding a session | walk `j` × 149 + `Enter` (200-Session catalog) | 151 | 463 ms | `interaction_cost.rs` |
| finding a session | `/` + `session 150` + `Enter` | 14 | 47 ms | `interaction_cost.rs` |
| editing input | line motions to fix the first character | 44 | 46 ms | `interaction_edit.rs` |
| editing input | retype the line instead | 120 | 103 ms | `interaction_edit.rs` |
| approval | `1` on the blocking decision | 1 | 7 ms | `interaction_approval.rs` |
| failure recovery | recall the failed prompt + send again | 2 | 180 ms | `interaction_recovery.rs` |
| reviewing changes | `<leader>g` | 2 | 16 ms | `interaction_review.rs` |

The failure-recovery figure moved from 30 ms to about 180 ms when the test
started waiting for the failed turn to settle before recalling the prompt. The
earlier number measured recovery keys sent while the client still believed the
turn was running, which queued the recalled prompt behind it and made the
admission count depend on timing: under a loaded machine the same test produced
a third admission. Both keystroke counts are unchanged.

Reading it: the two findings VAL-03 can already state as numbers are that a
query costs 11× fewer keystrokes than walking a 200-row list (14 vs 151) and that
line motions cost about a third of retyping (44 vs 120), for the same outcome on
the same surface. Approval is one keystroke because the decision is a closed
vocabulary, not because of any optimisation.

All figures were re-measured on `main` after the panel relayout fix (#2241) and
replace the first round, whose numbers appear in the history of this file. The
two exact counts moved by one keystroke each (150→151 and 13→14) after the
keybinding work in between, so they are re-stated rather than assumed stable;
the ratio they support is unchanged.

Startup figures are quoted from `docs/experiments/2026-11-01-startup-latency`,
which owns that measurement and its own scenario definitions; they are repeated
here only so one table answers VAL-03's "startup" line.

## What is not measured, and why

**reviewing changes — measured only after a fix.** Attempting it exposed a real
defect (#2218): the panel opened, the engine answered `vcs_status` with a
three-file set, the dialog received it (`ok files=3 gen=1`), and the body still
drew empty. The cause was in `render_dialog`: every dialog family had a dispatch
arm except the changes dialog, so the box was drawn with its title and nothing
else. With that arm added, the row above is measurable — 2 keys to the first
row, 13 ms — and the whole `miao-tui` suite passes (319 unit tests plus every
integration test).

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
