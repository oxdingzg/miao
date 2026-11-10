# Acceptance record — INP-03 paste, file references, and attachment payloads

Item: `INP-03`. Tree: the head of `feat/inp03-paste-pdf-clipboard` (PR #2781's
successor; the paste/attachment path lands through PR #2784, squash
`da2bb188fb` on `main`). The commands below are the cargo invocations the pull
request's CI workflow runs on ubuntu-24.04 from the crate directory on this
recorded tree; the observed cells cite that run (run 42682837705, tui + cli
legs green, all jobs terminal).

## Criterion — deliver paste, file references, and real attachment payloads

The composer's paste markers, file references, and attachment payloads hold
together end to end: a long paste collapses to one placeholder line, a pasted
file name attaches while a clipboard image does not falsely attach, a refused
prompt restores its attachments, backspace across a paste marker drops the
marker's text, and a pasted path is a prompt rather than a command.

Pinned tests (all `ok` in run 42682837705, tui leg):

- `editor::tests::a_long_paste_collapses_to_one_placeholder_line`
- `editor::tests::a_pasted_file_names_its_attachment_but_a_clipboard_image_does_not`
- `editor::tests::a_refused_prompt_restores_its_attachments`
- `editor::tests::a_short_paste_is_inserted_as_typed`
- `editor::tests::backspace_takes_a_paste_marker_and_drops_its_text`
- `commands::tests::a_pasted_path_is_a_prompt_not_a_command`
- `app::tests::a_paste_on_the_landing_screen_reaches_the_prompt`
- `app::tests::a_pasted_key_reaches_the_provider_prompt_instead_of_the_composer`
- `app::tests::an_image_pasted_on_the_landing_screen_rides_into_the_new_session`
- `app::tests::saved_permissions_ignore_closed_dialog_results_and_keep_paste_out_of_the_prompt`

| command | observed |
| --- | --- |
| `cargo test --lib` (tui leg, run 42682837705) | ok |
| `cargo test --tests` (cli leg, same run) | ok |

The PR also closes the remaining acceptance gaps named in its body:
bracketed-paste folding pins, PDF/named attachments, and Windows clipboard
retry semantics.

## Criterion 4 — link the implementation PR, acceptance records, and target versions

- Implementation: #2784, squash `da2bb188fb` on `main`.
- Acceptance record: this file.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

**Recorded open, not hidden:** real-client paste flows across terminal
emulators (bracketed-paste behaviour differences, Windows console paste keys)
stay open; the offline pins cover the editor/dialog semantics only.
