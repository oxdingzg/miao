# Acceptance record — TOOL-04 diagnostics carry their version

Item: `TOOL-04`. Tree: `097e6717ee`. Command, from the crate directory:

```sh
cd crates/miao-engine && cargo test --locked --no-fail-fast --test lsp
# 7 passed; 0 failed; 1 ignored
```

The ignored case is `real_rust_analyzer_observes_edited_document`: it needs an
installed `rust-analyzer` and runs only when asked for explicitly.

## "Include file versions and stale status within diagnostic payloads" — accepted

| assertion | test | observed |
| --- | --- | --- |
| the payload reports the document version and the version the diagnostics were pushed for | `lsp_tools_query_a_language_server` | `source.document_version=1`, `source.diagnostics_version=1`, `source.version_verified=true` |
| an external write between the query and the answer marks the answer stale and drops it | same | `source.stale=true`, `source.version_verified=false`, `source.current_sha256` is the outside content's digest, `diagnostics` is empty |
| a post-edit payload names the revision it describes | `edited_documents_refresh_diagnostics_and_queries_without_reopening` | `diagnostics_source.sha256` equals the applied file's digest and `matches_applied_revision=true`; a server that pushes no version leaves `version_verified=false`, so the answer is advisory rather than proof |

## "Connect LSP warmup, post-edit diagnostics, and verification commands …" — partial

- **Warmup** ✓ `read_file_warms_the_language_server_for_the_next_edit`: reading a file opens it, so the next edit's diagnostics arrive without a second open.
- **Post-edit diagnostics** ✓ same case as above, through `edit_file`'s product path.
- **Verification commands** ✗ **not accepted**: `--verify-command` is pinned only as CLI plumbing (`tests/cli_options.rs`); no case runs a verification command through a turn and reports its failure.

## "Continue repair or report failures explicitly upon check failure …" — not accepted

This run contains no repair-loop case, so it is named as a gap rather than
implied by the diagnostics rows above.

Still unaccepted after this record: the verification-command execution path, the
repair loop, and the real language server (the ignored case needs
`rust-analyzer` installed on the machine that runs it).
