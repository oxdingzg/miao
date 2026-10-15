# Native-owned product history reads

The product context and message-list endpoints must use the recorded engine
placement. A native-owned Session has no TypeScript message authority; reading
that table can return an empty conversation while the engine has a completed
answer. The history adapter is a transient read model, never a migration or a
second execution loop.

## Read contract

1. Capture one native snapshot: cursor, visible message sequences and latest
   compaction cut/summary are read in the same SQLite transaction.
2. Replay journal projections only through that captured cursor. Reuse the
   captured snapshot when the replay reader asks for one; do not combine a cut
   from one generation with messages from another.
3. Reduce the validated product events with the same pure `SessionTranscript`
   reducer used by the TUI. Final text/reasoning and committed calls create
   their parts even if no live stream-start fragments were recorded.
4. Filter by the snapshot's active sequences. Preserve client prompt IDs and
   provider-start assistant anchors; calls and results use the same assistant
   anchor as text and step events. Reverted rows do not reappear from replay.
5. Context reads apply the compaction cut and prepend its recorded summary.
   The legacy engine compaction event does not record an auto/manual reason,
   so this is an explicit system summary rather than an invented reason.
6. Message-list reads paginate the visible raw timeline with stable message
   IDs in the requested order. A cursor whose message is no longer visible
   fails rather than being interpreted as a different offset.

Native promotion publishes `prompted` as well as the compatibility admission
notice: an admission receipt alone must not make a pending user message visible.
Native text, calls and settled results all address the same anchored assistant.

## Bounds and compatibility

This adapter inherits the engine's existing snapshot limits (1,000 projected
messages, 2 MiB message content, 4 MiB total snapshot); it does not promise an
unbounded history scan. A larger snapshot or an older engine missing selection
metadata fails with a native conflict rather than silently falling through to
TypeScript storage. A provenance-rich incremental engine query is the follow-up
for paging histories beyond the snapshot budget.

No client credentials, directory selection or storage ownership bypass is
introduced. The placement/location middleware and native connection checks
still run before the read.

## Evidence

- Rust history test captures compaction selection and visibility together and
  verifies revert removes the cut and hidden messages.
- Native transcript tests cover client IDs, assistant anchors, usage,
  selected-versus-raw history, revert visibility, captured-cursor replay and
  incompatible-snapshot refusal.
- A real engine + HTTP product test covers admit-only visibility, completed
  text/usage, ascending/descending/previous/next pages, invalid cursors and
  **zero** rows in the TypeScript message table after both read endpoints.
- Native coding HTTP tests restore successful and denied tool results.
