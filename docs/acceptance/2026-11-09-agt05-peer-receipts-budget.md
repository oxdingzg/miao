# Acceptance record — AGT-05 cross-Session receipts, replies, and loop cost budgets

Item: `AGT-05`. Tree: PR #2786, squash `dcfccbd481` on `main`. The commands
below are the cargo invocations the pull request's CI workflow runs on
ubuntu-24.04 from the crate directory on this recorded tree; the observed
cells cite that run (run 42683997758: all four engine shards, unit,
typecheck, cli green; the first attempt's unit call was abandoned by infra
and rerun).

## Criterion — cross-Session message receipts, replies, and loop cost budgets, closed on the engine side

A typed `PeerReceipt` (sessionID, receipt, duplicate, wake, reason, reply_to)
rides the wire; the input ledger carries durable `sender`/`reply_to` columns
with same-project identity enforced at the store boundary; reply linkage is
exact (receipt column + `instr` legacy fallback, no LIKE wildcards); refusals
record a durable `peer.message.refused` event with a stop reason
(`reply_budget_exhausted`, `inbound_queue_full`); pre-upgrade threads keep
working through legacy-row fallbacks.

Pinned tests (all `ok` in run 42683997758, `tests/session_messaging.rs`):

- `a_peer_outside_the_project_is_not_addressable`
- `a_full_inbox_refuses_mail_at_the_recipient_boundary`
- `an_exact_retry_of_a_peer_send_duplicates_nothing`
- `mail_survives_a_restart_exactly_once`
- `a_wake_reaches_only_the_addressed_peer`
- `the_receipt_names_the_recipient_and_the_thread`
- `a_second_reply_to_the_same_message_is_refused`
- `a_reply_to_an_unknown_receipt_is_refused`
- `a_message_lands_in_the_peer_inbox_without_waking_it`
- `a_denied_target_receives_nothing`
- `a_reply_to_a_real_receipt_names_it_in_the_delivered_prompt`
- plus the `peer_tests` serialization pin for the documented wire shape

| command | observed |
| --- | --- |
| `cargo test --test session_messaging` (engine shards of run 42683997758) | ok |
| `cargo test --lib` (unit leg, same run) | ok |
| engine shards 1-4 | success |

## Criterion 4 — link the implementation PR, acceptance records, and target versions

- Implementation: #2786, squash `dcfccbd481` on `main`.
- Acceptance record: this file.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

**Recorded open, not hidden:** the TUI/CLI thread view and a budget
configuration surface (the reply budget is an engine constant, not
operator-configurable) stay open.
