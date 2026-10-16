# Revision-bound source observations

Native `grep` matches include `sha256`: the fingerprint of the exact file bytes used to generate the
line previews, including original line endings. This is an observed-content revision, not a claim
that the file is unchanged when a later edit starts. Conditional edits still require their normal
fingerprint checks.

`lsp_diagnostics` retains its existing `diagnostics` array and adds `source`:

- `sha256`: text sent to the language server.
- `document_version`: engine-assigned LSP document version.
- `diagnostics_version`: server-reported version, or `null` when absent.
- `current_sha256`: content re-read after the diagnostics arrive, or `null` when unavailable.
- `stale`: the content changed or could not be re-read; stale diagnostics are omitted from the array.
- `version_verified`: the server explicitly matched the requested version and the disk recheck matched.

Unversioned server notifications are advisory; their presence must not be described as version-
attested validation. The disk recheck observes one point in time and cannot prevent later external
writes. Existing bounded waits, output limits and stale version rejection remain in place.

Inline post-edit reports retain the bounded error/warning array as `diagnostics` and add
`diagnostics_source`, including `matches_applied_revision`. The engine only attaches diagnostic
messages when they match the just-applied content and the post-query disk recheck. A concurrent
external mutation instead leaves provenance indicating why the diagnostics cannot validate that edit.

These observations help locate and repair source issues. They are not independent completion
checks, whole-project typechecks or proof that an entire user objective is complete.
