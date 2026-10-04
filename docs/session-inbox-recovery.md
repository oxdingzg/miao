# Durable inbox display recovery

A Session's admitted inputs live in `session_input`. Global live subscriptions are process-local: another CLI can admit a message into the shared database without delivering a live event to an already open TUI.

## Read contract

`GET /api/session/:sessionID/inputs` reads inputs whose `promoted_seq` is null. It returns `{ data, hasMore }`, ordered by admission sequence. `after` is an exclusive admission sequence and `limit` is at most 100. Files are materialized using the same blob boundary as Session history. Reading inputs does not resume execution or promote them.

`GET /api/capabilities` advertises `pendingSessionInputs: true`. A new TUI does not request the endpoint from an older attached server that lacks the capability.

The TUI checks durable pending inputs alongside execution-status polling, normally once a second while busy and once every five seconds while idle. Newly discovered inputs become admitted display receipts. Once an observed receipt disappears from the pending snapshot, the TUI removes it and schedules authoritative transcript hydration. Existing transcript messages win over pending receipts.

A receipt admitted by a live event while a snapshot is in flight is not removed by that older snapshot. Only receipts present before the read are candidates for removal. Failed and still-sending local receipts are retained.

## Delivery vocabulary

- **Sending**: HTTP admission has not completed.
- **Admitted / received**: an input is durable; this is not a human-read acknowledgment.
- **Queued**: durable input waiting until the Session would otherwise become idle.
- **Promoted**: visible in authoritative history and eligible for model execution.

Execution ownership and wake coordination remain process-local. Inbox display recovery does not introduce clustered execution ownership or retry provider work after a crash. The sender's normal prompt admission still schedules its advisory wake unless `resume: false` was requested.

## Verification

- Six affected package typechecks passed, along with miao typecheck.
- Core prompt/inbox tests: 26 pass, including ordered pagination, attachment materialization, promotion removal, and missing-Session errors.
- SDK tests: 7 pass. A real independent Bun process admits a queued input using the assembled router and handlers, then the already open host reads it without receiving a live admission event. No execution starts during admit-only admission or inbox reading.
- TUI tests: 384 pass, 1 existing skip. Inbox cases cover missed events, promotion reconciliation, pagination, a live-admission/snapshot race, and compatibility with older server capabilities.
- Public OpenAPI tests: 17 pass.
