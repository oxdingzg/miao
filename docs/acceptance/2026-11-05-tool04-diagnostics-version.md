# Acceptance record — TOOL-04 diagnostics and the completion check

Item: `TOOL-04`. Tree: `097e6717ee`. Commands, from the crate directory:

```sh
cd crates/miao-engine
cargo test --locked --no-fail-fast --test lsp
# 7 passed; 0 failed; 1 ignored
cargo test --locked --no-fail-fast --test verification
# 5 passed; 0 failed; 0 ignored
```

The ignored LSP case is `real_rust_analyzer_observes_edited_document`: it needs
an installed `rust-analyzer` and runs only when asked for explicitly.

## "Include file versions and stale status within diagnostic payloads" — accepted

| assertion | test | observed |
| --- | --- | --- |
| the payload reports the document version and the version the diagnostics were pushed for | `lsp_tools_query_a_language_server` | `source.document_version=1`, `source.diagnostics_version=1`, `source.version_verified=true` |
| an external write between the query and the answer marks the answer stale and drops it | same | `source.stale=true`, `source.version_verified=false`, `source.current_sha256` is the outside content's digest, `diagnostics` is empty |
| a post-edit payload names the revision it describes | `edited_documents_refresh_diagnostics_and_queries_without_reopening` | `diagnostics_source.sha256` equals the applied file's digest and `matches_applied_revision=true`; a server that pushes no version leaves `version_verified=false`, so the answer is advisory rather than proof |

## "Connect LSP warmup, post-edit diagnostics, and verification commands into real product execution paths" — accepted

| part | test | observed |
| --- | --- | --- |
| warmup | `read_file_warms_the_language_server_for_the_next_edit` | reading a file opens it, so the next edit's diagnostics arrive without a second open |
| post-edit diagnostics | `edited_documents_refresh_diagnostics_and_queries_without_reopening` | the edit's own payload carries the diagnostics for the revision it wrote |
| verification command | `a_passing_completion_check_lets_the_run_finish`, `a_failing_completion_check_continues_once_then_closes_with_a_classification` | `verify_with` runs the configured command at the end of a run; a zero exit lets the run finish, a non-zero exit is recorded and handled by the repair path below |

## "Continue repair or report failures explicitly upon check failure …" — accepted

- `a_failing_completion_check_continues_once_then_closes_with_a_classification`: a failed check records `verification.failed`, admits exactly one repair prompt (`loop.continuation` with `reason=verification-failed`), and a second consecutive failure closes the run with `loop.stopped`/`verification-failed` instead of retrying forever.
- `a_zero_exit_cannot_validate_a_tracked_revision_changed_during_the_check` and `a_check_is_bound_to_the_task_revision_it_started_with`: a check that exits 0 does not validate a tree that moved while it ran, so a stale pass is reported as a failure rather than a success.
- `cancellation_records_an_unaccepted_receipt_without_admitting_a_repair_prompt`: a cancelled check cannot manufacture a repair turn.

Still unaccepted after this record: the **real language server**. The only case
that runs one is ignored by default because it needs `rust-analyzer` installed
on the machine that runs it, so default CI proves the diagnostics contract
against a scripted server, not against a real one.
