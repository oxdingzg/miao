# Acceptance record — CFG-02 configuration sources and scope

Item: `CFG-02`. Tree: `82d4e77eae` plus this record's commits. The shipped product is
one Rust binary; the commands below ran on the Linux build host from the crate
directories named in each entry.

This record accepts one of the two criteria that
`2026-11-04-config-ext-retry.md` left open and keeps the other open, explicitly.

## Criterion 1 — an unknown key is explained, never fatal

> Invalid or unknown configuration values produce an actionable error that names the
> source and the key, and the product never silently substitutes a default.

The product's typed decode drops a top-level key the schema does not know. That drop
is deliberate (forward compatibility: a key a newer product wrote must not make an
older binary refuse the document), so the criterion is met with a **warning
surface**, not an error:

- `crates/miao-engine/src/config_v1.rs` exports `known_top_level_keys()`: the union of
  the V1 keys that migrate and the V2 field set the normalized surface keeps.
- `crates/miao-engine/src/config_explain.rs` reports every top-level key outside that
  set in a `warnings` array with its source and, when the key is a plausible typo, the
  closest known key. It never fails the read.
- `miao debug config` (`crates/miao-cli/src/cli.rs`) is the human surface: it prints
  each source, each resolved leaf with the file that won it, and the warnings.
  `docs/cli.md` recorded this command as `rust-todo`; the guide already documented it.

| command | observed |
| --- | --- |
| `cd crates/miao-engine && cargo test --lib config_explain::` | `3 passed; 0 failed` (includes `an_unknown_key_is_reported_with_the_closest_known_key_and_never_fails`) |
| `cd crates/miao-engine && cargo test --test config_explain` | `7 passed; 0 failed` (includes `an_unknown_top_level_key_is_warned_about_without_failing_the_read`, a real `miao-engine config explain` process) |
| `cd crates/miao-cli && cargo test --test debug_config` | `1 passed; 0 failed` (a real `miao debug config` process exits 0, names the source, prints `model = "fixture/model"`, and prints ``warning  unknown top-level key `provvider` in …; did you mean `provider`?``) |
| `cd crates/miao-engine && cargo test --lib config_v1::` | `10 passed; 0 failed` |
| `cd crates/miao-engine && cargo test --test config_golden` | `6 passed; 0 failed` |

Result: **accepted**. An unknown key is named with its source and a suggested
correction, the read still succeeds, and the normalized document is unchanged —
which the golden fixtures confirm on the same tree.

## Criterion 2 — four configuration scopes, including a managed layer

> Configuration resolves across session, project, global and managed scopes, and the
> resolution is inspectable.

**Not accepted.** Session, project and global layers resolve and are inspectable
(`miao debug config` now prints the provenance of every leaf), but `config_scope.rs`
has no *managed* layer. Where an administrator's file lives per platform is a product
location decision that has not been made, and this record does not invent one. The
criterion therefore stays open on this item.
