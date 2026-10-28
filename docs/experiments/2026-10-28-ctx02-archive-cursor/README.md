# Long-session archive recall cursor regression

The model's `recall` tool could not recover a tool output older than its bounded
message scan. After 1000 messages, the archive reader returned
`next_before_message_seq`, but handle-mode validation rejected
`before_message_seq`; the reader also always started from the newest message.
The raw output remained durable, but the advertised recovery path was unusable.

`archived_handle_scan_resumes_after_compaction_and_reopen` writes a tool output,
adds more than 1000 later messages, compacts the Session, closes the Store, and
reopens it. The first bounded page is empty and not exhausted. Passing its cursor
through `Tools.prepare` failed with `InvalidInput` before the fix. After the fix,
the same tool input restores the exact Unicode output and original message
sequence. A different Session cannot retrieve it, and the exclusive cursor
cannot select an output at or after that cursor.

Handle-mode requests now accept the existing message cursor and pass it to the
archive SQL query. Text queries and handles remain mutually exclusive. Invalid
or overflowing cursors remain rejected. The 1000-message page limit, Session
boundary, and output byte windows are unchanged. Tool instructions distinguish
message-scan cursors from `next_offset`, which pages an output after it is found.

Verification on a build host:

```sh
cd crates/miao-engine
cargo test --test recall --test context_prune --test session_shell
cargo test --lib --test compaction_acceptance --test context_wire
cargo clippy --lib --tests -- -D warnings
cargo fmt --check
```

The first command passed 16 tests after the fix. The regression failed before
the fix at tool-input validation, rather than failing to create or reopen the
fixture. All provider behavior in these checks uses local fixtures; no paid
comparison or model-quality improvement is claimed. This is implementation and
regression evidence, not a release or complete CTX-02 acceptance statement.

The operator RPC still exposes search-only recall. Delegated archive references
still use the existing single scan page. Extending those interfaces requires
separate work; this change repairs the model's existing paginated recall path.
