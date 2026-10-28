# Read-triggered instruction discovery

The native runner discovers nested repository instructions after a successful
`read_file`, at the next provider boundary. It does not scan every directory at
startup. Root and explicitly selected host sources retain their existing order.

## Durable admission and recovery

The prepared native reader attaches internal path metadata after argument
rewrites. Tool settlement removes this metadata from the model-facing result and
records `read: { location, path }` beside the successful `tool.completed` event in
the same SQLite transaction. Failed calls and external reference reads do not
activate workspace instruction sources. Diagnostic tool replay preserves the
recorded read provenance in the same Location, even if the original target file
has since been deleted. It does not execute that file read again. Instruction
files themselves are refreshed under the normal context policy, as root
instructions already are; replay requires matching instruction files.

Before a provider request, the runner reads committed observations after the
last `instructions_loaded` cursor. The cursor advances even when an unchanged
context reuses its epoch. A result committed before interruption is therefore
eligible at the next explicit continuation; this does not automatically resume
provider work after a crash.

Previously selected nested sources travel in the durable source receipts. A new
Runtime reconstructs them from the ledger, and forks inherit the sources selected
at their message checkpoint. Discovery does not mutate the Location-wide `Tools`
instance. Unrelated Sessions have independent observations. Receipts from another
Location are ignored, including journals retained through a move.

## Scope and authority

For each successfully read workspace file, discovery walks its canonical parent
directories up to, but excluding, the workspace root. Each directory selects the
first existing name: `AGENTS.md`, then `CLAUDE.md`, then `CONTEXT.md`.
`MIAO_DISABLE_CLAUDE_CODE_PROMPT` (or `MIAO_DISABLE_CLAUDE_CODE`) excludes `CLAUDE.md`;
`MIAO_DISABLE_PROJECT_CONFIG` disables nested discovery. Both recognize `1` and
case-insensitive `true`.

Sources load from outer to inner directories. Their prompt blocks identify the
instruction file and its directory scope; deeper files take precedence in their
scope. Source receipts retain the triggering read, Location, canonical policy
resource, content hash, and load/skip reason. A file already loaded through an
explicit host source is not injected again.

Every instruction read must pass both its named-path policy and canonical
resource policy. An `ask` decision is skipped; discovery never approves it or
opens an approval dialog. External read references do not authorize nested
instruction discovery, including instruction symlinks into an authorized
external reference. Disabling standalone root discovery for a host-selected
aggregate does not reintroduce the root file.

## Bounds and validation

Discovery retains at most 64 nested source paths per Session context. Instruction
files use the normal bounded `read_file` implementation. The existing 64 KiB
system-context and serialized-source budgets remain in force; oversized bodies
are skipped, and a source-budget omission receipt is included when space permits.
Instruction bodies are re-read at provider boundaries so changed or removed
files do not keep an obsolete body active.

`tests/context_read.rs` uses actual SQLite Stores, native file readers, Runtime
drains, and deterministic providers. It covers boundary timing, duplicate reads,
parallel settlement, Runtime/Store reopen, the commit-before-context-selection
cut, fork inheritance, Session/Location isolation, failed and denied reads,
external references/symlinks, and context budgets. The ledger-cut and foreign
Location cases construct durable journal fixtures; they do not claim an OS-level
crash or a live cross-machine migration drill.

The new receipt fields are additive Rust ledger metadata. No HTTP API or
generated SDK schema changes are required. This slice does not implement live
service reconfiguration or retire the TypeScript runner.
