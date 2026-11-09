# Acceptance record — INP-03 paste, file references, and real attachment payloads

Item: `INP-03`. Tree: `410c411d03` (branch `feat/inp03-paste-pdf-clipboard`, two
implementation commits: `88b6cbba0c` delivers the payload path and pins it,
`410c411d03` fixes the numbered paste marker's suffix parsing that the pins caught;
this record rides in a third commit on the same branch). The commands below are the
cargo invocations the pull request's CI workflow runs on ubuntu from `crates/miao-tui/`
on this recorded tree; the observed cells cite that run (#2784, CI run `42682837705`,
job `129381816369`). CI runs the whole tui suite; each row names the filter within it.

## Criterion 1 — bracketed paste, folding for long pastes, file paths, images, PDFs, and multiple attachments

| command | observed |
| --- | --- |
| `cargo test --test paste_payloads` | ok. 1 passed; 0 failed (CI run `42682837705`) |

Pinned by the end-to-end run in that suite:

- `a_pasted_block_and_file_paths_reach_the_engine_with_their_payloads` — the real
  binary in a PTY folds a four-line bracketed paste to `[Pasted ~4 lines]`, turns the
  pasted `shot.png` and `plan.pdf` paths into `[Image 1]` and `[File plan.pdf]`, and
  one admit frame carries the block's full text beside two attachments with their
  `mime`, `metadata.name`, and base64 of the raw bytes, byte-compared against the
  files on disk.

Unit pins already on the tree cover the folding thresholds and the path table:
`a_long_paste_collapses_to_one_placeholder_line`, `three_lines_collapse_but_two_do_not`,
`pasting_an_image_path_attaches_it`, `pasting_a_pdf_names_the_attachment`,
`pasting_an_svg_inlines_its_text`, `pasting_an_unknown_file_keeps_the_path`,
`images_become_numbered_markers_and_submit_with_the_prompt`.

## Criterion 2 — inline markers match actual payloads

| command | observed |
| --- | --- |
| `cargo test --locked --lib` | ok. 594 passed; 0 failed (same run) |

- `two_same_size_pastes_keep_distinct_markers_and_payloads` — the second paste of one
  size gets a ` #2` suffix; submit expands each marker to its own block, in place.
- `backspace_takes_the_numbered_paste_marker_and_drops_its_text` — the numbered marker
  deletes as one unit with exactly its own block; the freed sequence is reusable.
  **This pin caught the record's one defect**: `placeholder_kind` stripped the
  `" lines"` suffix before looking at the ` #N` that follows it, so a numbered marker
  never parsed and backspace at its edge fell through to character deletion;
  `410c411d03` moves the suffix off first and requires it to be numeric.
- `a_pasted_file_names_its_attachment_but_a_clipboard_image_does_not` — a file-backed
  attachment carries its name as `metadata` (the engine names the materialized copy
  after it, per the MEDIA-01 pins in #2746); a clipboard image carries none.

## Criterion 3 — raw bytes and source metadata across Windows clipboard access and failure retries

| command | observed |
| --- | --- |
| `cargo test --locked --lib` | ok (same run): `windows_read_retries_a_failed_script_until_it_runs`, `windows_read_stops_at_a_definitive_answer`, `windows_read_gives_up_after_the_bounded_attempts`, `parse_windows_image_accepts_only_canonical_base64`, `parse_windows_text_trims_only_the_console_newline` |

`windows_read` takes its script runner as a parameter, so the retry semantics —
bounded attempts, a definitive empty answer stopping the loop, raw stdout bytes kept
until parse — run on every platform's CI rather than only where a clipboard exists.
The mtty handoff (`read_host_image`) already served the source file's raw bytes; the
image bridge now refuses anything that is not canonical base64, and text trims
exactly one console newline so a newline the clipboard holds survives.

**Recorded open, not hidden:** the PowerShell bridge itself against a real Windows
clipboard was not driven for this record — the tui workflow's Windows leg runs
nightly or on manual dispatch only. The same parse and retry code runs there
unmodified.

## Criterion 4 — link the implementation PR, the acceptance records, and applicable versions

- Implementation: #2784, branch tip `410c411d03` (the diff-block tint work that had
  been swept into the WIP commit was split out to #2783).
- Acceptance record: this file, run on tree `410c411d03`; the engine half of the
  attachment path was pinned by MEDIA-01 in `2026-11-07-media01-materialization.md`.
- Versions: applies from the release that first ships the merged tree; stamped per
  the repository convention when that release cuts.

## Full-suite result

| command | observed |
| --- | --- |
| `cargo fmt --check` | ok (same run) |
| `cargo clippy --locked --all-targets -- -D warnings` | ok (same run) |
| `cargo test --locked --no-fail-fast -- --test-threads=1` | ok — the whole tui suite green in run `42682837705` (first round `42680052376`: 593 lib tests and every integration target including `paste_payloads` passed; the one failure was the suffix bug above) |

**Staying open** (carried in the issue, not claimed here): live client acceptance on
a real terminal against a real Windows clipboard session, and a product-level
multi-file attachment picker beyond pasted paths.
