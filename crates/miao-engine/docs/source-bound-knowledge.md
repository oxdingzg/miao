# Source-bound workspace knowledge

The native `knowledge` tool manages a bounded, reviewable `.miao/knowledge.json` file shared by
Sessions at the same canonical workspace Location. Reads return a short index before bodies.
Knowledge is advisory tool data: current user instructions, AGENTS.md and live source take precedence.
Source freshness validates listed file bytes, not the semantic truth of a model-authored claim.

## Operations

- `list` accepts optional literal `query` and `limit` (default 10, maximum 20). Entries include ID,
  title, kind, note revision and source state; bodies are retrieved separately.
- `get` takes `id`. Bodies are returned by default only for current sourced notes. `include_stale:true`
  permits explicit review of expired, foreign, changed or unverified notes. Restricted sources stay
  withheld by this tool.
- `put` takes `id`, `expected_revision`, `title`, `kind`, `body`, and optional `sources`, `derivation`
  and `ttl_seconds`. `repo_fact` and `file_index` require source fingerprints and a derivation.
  Preference/constraint notes without adequate sources remain unverified; their default expiry is
  seven days. An explicit TTL is bounded to 30 days.
- `index_file` takes `id`, one workspace-relative `path`, and `expected_revision`. It builds a small
  deterministic file index: byte/line counts and up to 32 lexical declaration candidates. Candidate
  coverage is explicitly partial; use live source or LSP for semantic symbol resolution.
- `delete` takes `id` and `expected_revision`.

Writes also carry `expected_store_sha256`, returned by list/get/write operations. A null hash creates
an absent store. The whole-file hash protects manual edits and concurrent writers; the per-note
revision protects stale record updates. Revisions are allocated from a monotonically increasing
store counter, so deleting/recreating a note does not reuse an old record revision. A changed hash
requires reviewing the current index before retrying. Existing malformed or unsupported files are
preserved rather than reset.

## Provenance and invalidation

Each note records its writing Session, write time, workspace fingerprint, derivation, source paths
and exact SHA-256 values. Source paths are canonicalized when written. Retrieval rechecks readable
source bytes, with per-call deduplication and budgets. A modified/missing/unreadable source, expired
TTL, foreign workspace scope or absent derivation prevents default body reuse. Refresh a file index
explicitly with the current store hash and note revision; editing a source does not spawn model calls.

The file is ordinary workspace data, inspectable and editable with normal filesystem tools. Knowledge
operations use normal workspace read/write permission. Source validation requires allowed direct
workspace reads and respects protected resources; external reference roots are outside this version's
source scope. Writes serialize with engine file operations and use the existing conditional atomic
file mutation path; its guarantees against non-cooperating external writers are optimistic.

## Bounds

The store holds at most 64 notes and 128 KiB of JSON. A note body is at most 8192 UTF-8 bytes and its
derivation at most 2048 bytes. Each note has at most eight source files; a source read is bounded to
1 MiB and one operation to 8 MiB. Unverified notes are available for review rather than automatic
rule adoption. The implementation performs no automatic model extraction, whole-repository wiki
build, vector indexing or per-turn memory injection.
