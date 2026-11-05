# Acceptance record — TOOL-02 version-constrained edits and transactional patches

Item: `TOOL-02`. Tree: `80c316cad3`. Commands ran on the Linux build host from
`crates/miao-engine`. Every suite is Rust.

## Criterion 1 — an external modification is blocked, not overwritten

| test | what it pins |
| --- | --- |
| `stale_edit_rejection_carries_fingerprint_and_settles_as_error` (`cargo test --test stale_edit` → `1 passed`) | an edit whose fingerprint no longer matches the file is rejected and settles as a tool error, so the model sees the refusal instead of a silent overwrite |
| `a_stale_edit_rebases_onto_drifted_content`, `recovery_refuses_unanchored_and_ambiguous_drift`, `replace_all_and_the_ablation_switch_never_rebase`, `an_in_place_edit_is_unchanged` (`cargo test --test edit_recovery` → `4 passed`) | the recovery path either rebases onto drift it can anchor or refuses it; it never silently re-applies an ambiguous edit |

## Criterion 2 — a multi-file patch either lands whole or leaves nothing behind

`cargo test --test apply_patch` → `5 passed`:

- `context_mismatch_aborts_the_whole_patch_without_side_effects` — one hunk that does not
  match aborts every file in the patch;
- `patch_adds_updates_and_deletes_in_one_transaction` — adds, updates and deletes commit
  together;
- `patch_permission_is_a_single_capability_and_deny_has_no_effects` — a denied patch
  writes nothing;
- `patch_parsing_is_strict_and_bounded` — malformed input is refused before any write.

The implementation stages each file and publishes by rename (`crates/miao-engine/src/patch.rs`),
so a publish failure restores what was already staged.

## Criterion 3 — bytes preserved; large files, renames and deletions

Pinned: `bom_and_crlf_are_preserved_through_updates` keeps a byte-order mark and CRLF line
endings through an update.

**Not evidenced, and not claimed:**

- **Renames.** The `rename` calls in `patch.rs` stage-then-publish a file; there is no
  user-level rename operation in the patch grammar, so "supports renames" is not accepted.
- **Large files.** No case exercises a patch over a size-bounded large file.
- **Unicode.** No case in this batch asserts multi-byte content survives an edit; the
  chunk-boundary safety pinned in `output_guard` covers streaming, not edits.

Result: criteria 1 and 2 **accepted**; criterion 3 accepted only for BOM/EOL preservation,
with renames, large files and Unicode-in-edits left open.
