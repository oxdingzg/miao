# Acceptance record — TUI-04 markdown, long-output, and media fallback rendering

Item: `TUI-04`. Tree: `6e82464349` (branch `test/tui04-render-fallbacks`, rebased on
`main` 2026-11-09; one commit pinning the fallback rendering contracts). The commands below are the cargo invocations the pull request's CI
workflow runs on ubuntu-24.04 from the crate directory on this recorded
tree; the observed cells cite that run, and a Linux build-host run
cross-checks them when the host is idle.

## Criterion 1 — keep code, tables, lists, links, and tool output readable

`a_narrow_transcript_keeps_markdown_media_and_folded_output_readable` renders a
transcript entry containing a markdown heading, a table, a list, a link, a fenced code
block, a `read_image` tool result, and a long `run_command` result at a narrow width,
then asserts the painted frame keeps every kind readable (folds the long output behind
the toggle, names the media instead of painting bytes, keeps the markdown structure).

| command | observed |
| --- | --- |
| `cargo test --lib a_narrow_transcript` | ok — `pane::tests::a_narrow_transcript_keeps_markdown_media_and_folded_output_readable` (CI run 42635672617) |

## Criterion 2 — collapse large output with expansion, and an understandable fallback for unknown content

The renderer is deliberately not a CommonMark parser, so the fallback path is the
contract: `unknown_content_passes_through_without_loss` pins that an HTML block, a
template expression, an autolink, and a tabbed line with wide characters each survive
character for character. The long-output collapse path is the same fold asserted in
criterion 1.

| command | observed |
| --- | --- |
| `cargo test --lib unknown_content_passes_through` | ok — `markdown::tests::unknown_content_passes_through_without_loss` (same run) |

## Criterion 3 — preserve results on narrow screens and without image support

`an_image_read_names_the_media_and_never_paints_its_bytes` pins the image-less
terminal fallback: a `read_image` result is announced by file name and its payload
bytes are never painted into the frame.

| command | observed |
| --- | --- |
| `cargo test --lib an_image_read_names` | ok — `tool::tests::an_image_read_names_the_media_and_never_paints_its_bytes` (same run) |

## Full-suite result

The three pins live beside the existing rendering suites, so the whole test set ran,
not only the new tests:

| command | observed |
| --- | --- |
| `CARGO_INCREMENTAL=0 cargo test --no-run --tests` | ok (CI run 42635672617) |
| `CARGO_INCREMENTAL=0 cargo test --tests` | ok — 21 suites ok on the tui job |

## Criterion 4 — link the implementation PR, the acceptance record, and applicable versions

- Implementation: #2765 (the branch tip was `41b4bf13bc` after one rebase; the
  record row and this file were its docs commit).
- Acceptance record: this file, run on tree `6e82464349`.
- Versions: applies from the release that first ships the merged tree; stamped per
  the repository convention when that release cuts.

**Recorded open, not hidden:** a real-client visual pass (a live TUI in tmux, SSH,
and an image-less terminal confirming the same fallbacks) is not covered by these
offline pins and stays open.
