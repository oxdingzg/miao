# Acceptance record — TOOL-02 renames, large files and edit Unicode

Item: `TOOL-02`. Tree: `1580c08bfe`. Commands ran on the Linux build host from
`crates/miao-engine`. This record closes the criteria
`2026-11-05-tool02-versioned-edits.md` left open: renames, large files and
Unicode in edits.

## Criterion — renames, large files and Unicode

| command | observed |
| --- | --- |
| `cargo test --test apply_patch` | `11 passed; 0 failed` — the rename family: `rename_moves_the_file_and_reports_the_destination` (update+rename lands at `docs/renamed.md`, the source is gone and the result reports the destination), `pure_rename_keeps_bytes_exactly`, `bom_and_crlf_survive_a_rename`, `occupied_rename_target_aborts_the_whole_patch`, `protected_move_target_is_denied_without_effects`, and `a_large_file_renames_without_touching_its_bytes` — a file at the 1 MiB per-file bound moves without its bytes being rewritten |
| `cargo test --lib file_mutation::tests::multi_byte` | `1 passed; 0 failed` — `multi_byte_text_survives_an_edit_byte_for_byte`: CJK text, combining characters and an emoji ZWJ sequence survive an anchored edit byte for byte |

`*** Move to:` under an `*** Update File:` header renames the file. The
destination is published with the no-clobber hard link used by Add and the
source is removed only afterwards, so an occupied target fails the whole patch
and restores it (`crates/miao-engine/src/patch.rs`). An earlier run of this
batch on `5d94c5224f` caught a real bug the new tests pin: a rename with hunks
linked the staged temp from the destination's directory, so the patch failed
with `NotFound` and left the source untouched; fixed in `1580c08bfe`, which is
the tree every command above ran on.

## Criterion — strict parse and the reference corpus, still holding

| command | observed |
| --- | --- |
| `cargo test --test differential` | `2 passed; 0 failed` — the 44-case corpus (including `move_file`, `pure_rename_no_hunks`, `move_to_same_file_rejected`, `bom_preserved`) matches the reference implementation or its recorded product contracts, and rejected patches leave the workspace unchanged |
| `cargo test --test edit_recovery`, `cargo test --test stale_edit` | `4 passed; 0 failed` and `1 passed; 0 failed` — criteria 1 and 2 of the 2026-11-05 record re-verified on this tree |

`patch_parsing_is_strict_and_bounded` (in the apply_patch suite above) still
refuses malformed input before any write, and a `*** Move to:` line anywhere
but directly under its Update header is rejected the same way. Deletions keep
the coverage they already had
(`patch_adds_updates_and_deletes_in_one_transaction`, criterion 2 of the
2026-11-05 record).

Result: criterion 3 of `2026-11-05-tool02-versioned-edits.md` is accepted in
full — renames, large files and edit Unicode join BOM/EOL preservation, with
deletions unchanged. TOOL-02 is accepted offline and, per the repository
convention, waits only for the release stamp.
