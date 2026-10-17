# Source-bound workspace knowledge

The Core `knowledge` tool and native engine use the same version-1
`.miao/knowledge.json` document. Notes are explicitly created and reviewed; they
are not extracted automatically or injected into every provider request.

Operations: `list`, `get`, `put`, `index_file`, and `delete`. To mutate a note,
provide both its `expected_revision` (0 for a new note) and the exact latest
`expected_store_sha256` (`null` only for an absent store). The global document
revision increases across deletions and recreation. Manual edits, unsupported
versions, malformed documents, and stale write requests are preserved for
review rather than silently replaced. Core commits through `FileMutation`'s
create/conditional-write boundary; an external editor is not part of Core's
process-local mutation lock.

The bounded format carries kind, title, body, derivation, source paths and
SHA-256 hashes, Location scope, originating Session, update time, and optional
expiry. The store is limited to 128 KiB and 64 notes; each source is at most
1 MiB, with an 8 MiB source-read budget per call. Notes may cite at most eight
ordinary workspace files. Preferences and constraints default to a seven-day
expiry. File indexes contain at most 32 lexical declaration candidates and
explicitly do not establish semantic completeness.

`get` returns bodies only while the listed sources are current, unless an
explicit `include_stale` requests review. Permission-restricted source bodies
remain withheld even with that flag, and restricted notes are omitted from
search results. Source-free or underived notes are `unverified`. Source hashes
prove byte freshness only, not claim truth. Current user instructions,
`AGENTS.md`, and live source remain authoritative.

Every call asserts the `knowledge` permission for the store. Mutations also
assert `edit`; source reads assert `read` for canonical resources. Paths are
resolved through the existing Location boundary, and stale resource identity
is checked again before committing. Reading an absent store creates no files.
