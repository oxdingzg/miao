# Acceptance record — JOB-05 editing a schedule from the TUI

Item: `JOB-05` (#1965). Tree: the pull-request head for branch `feat/job05-cron-edit`,
parent `origin/main` `51af29fc03`. Commands ran on the Linux build host `xx04` from
`crates/miao-tui` and `crates/miao-engine`, `cargo 1.99.1`.

`2026-11-01-tui-batch-2.md` accepted the schedule list and its cancel verb and named the
gap: **creating or editing a schedule from the TUI** stayed with the model's tools. This
tree closes the editing half. It does **not** close the item — the two rows left open
below are stated at the end.

## What changed

- `crates/miao-engine/src/protocol.rs`: `ChangeCron { session_id, change }` and
  `ChangeWakeup { session_id, change }`, carrying the same partial-edit structs the
  `cron_edit` / `wakeup_edit` tools use, so a client and the model cannot drift into two
  vocabularies for one operation.
- `crates/miao-engine/src/host.rs`: both commands dispatch to the `Runtime` methods that
  already existed (`edit_cron`, `edit_wakeup`) — no new scheduling logic.
- `crates/miao-tui/src/dialogs.rs`: the schedule panel gains `e`, which opens a text
  dialog titled `edit schedule` for the row under the cursor; `x` still cancels. The row's
  `kind:id` grammar is shared by both verbs.
- `crates/miao-tui/src/app.rs` + `engine.rs`: submitting the dialog sends
  `change_cron` (a cron expression) or `change_wakeup` (a delay in seconds, parsed and
  refused rather than guessed), then re-reads the list so the panel shows what the engine
  stored.

## Criterion — "Provide editing and cancellation capabilities while distinguishing scheduled triggers from goal continuation."

| capability | command (`crates/miao-tui`) | observed |
| --- | --- | --- |
| `e` on a schedule row asks for an edit of *that* row, for both kinds | `cargo test --lib e_on_a_schedule_row_asks_for_an_edit_of_that_row` | `ok` — `EditSchedule("wakeup:t1")` then, after one `Down`, `EditSchedule("cron:c1")`; the editor is a text dialog with the title `edit schedule` |
| cancelling still names the kind it cancels | `cargo test --lib a_schedule_row_names_its_kind_so_x_cancels_the_right_thing` | `ok` |
| submitting tells the engine the row and the new value | `cargo test --lib editing_a_scheduled_row_sends_the_new_value_for_that_row` | `ok` — `ChangeSchedule { session_id: "ses_a", kind: "cron", id: "c1", value: "0 9 * * 1" }` |
| the rest of the panel is unchanged | `cargo test --lib schedule` | `5 passed` |
| the crate around it | `cargo test --lib` (`crates/miao-tui`) | `636 passed; 0 failed` |
| the engine accepts the new commands | `cargo test --lib` (`crates/miao-engine`) | `468 passed; 0 failed` |

Scheduled triggers and goal continuation were already separate durable kinds (`#2742`:
`session.state.plan`/`goal`/`todos` beside the cron rows) and the schedule panel lists only
`cron`/`wakeup` rows, so a goal continuation never appears there as a trigger.

## Still open on this item

- **Timezone, ownership and expiration in the rows**: `Store::crons` already returns
  `timezone`, `session_id`, `expires_at_ms` and the state, but the panel's row text shows
  only the pattern and the fired/skipped counts.
- **Accounting a task's model calls against its budget**: the engine bounds a Session's
  tokens (`goal.budget`) but a schedule's own cost is not tracked against a per-task
  budget; that is `COST-02` (#1972)'s design, and doing it here would create a second
  vocabulary for the same idea.

## Version

No `roadmap:` stamp: this tree is in no published release yet, and the item is not fully
accepted regardless.
