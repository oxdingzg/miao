# Acceptance record — TOOL-03 low-cost editing carriers and stale recovery

Item: `TOOL-03`. Tree: `e791239249` (branch `feat/issue1955`, five commits: `fb79bfdac6`
adds the unique explainable fuzzy target and the carrier ablation switches,
`b5c422ff93` exposes them as `--short-anchors`/`--batch-edit`,
`20488704cc` pins the carriers and recovery in `tests/edit_carriers.rs`,
`a4a252a050` corrects the readless-retry scenario,
`e791239249` drops clippy-rejected borrows). The commands below are the cargo
invocations the pull request's CI workflow runs on ubuntu-24.04 from the crate
directory on this recorded tree; the observed cells cite that run.

## Criterion 1 — ablate short anchors, batch editing, and rebase separately

Each carrier has its own switch beside `with_edit_recovery`:
`with_short_anchors` gates the `anchor`/`new_text` short spelling,
`with_batch_edit` hides the multi-file patch tool from the definitions and
rejects its calls, `with_edit_recovery` already gated the rebase. The switches
are reachable from the binary as `--short-anchors on|off` and
`--batch-edit on|off`, and the CLI whitelist guard keeps them accepted so the
ablation cannot silently become impossible to run.

| command | observed |
| --- | --- |
| `cargo test --test cli_options` | ok — `engine_flags_the_runtime_reads_are_accepted_options` passes with `--short-anchors off` and `--batch-edit off` among the accepted flags (CI run 42854193247) |
| `cargo test --test edit_carriers` | ok. 10 passed; 0 failed (CI run 42854193247) |

Pinned separately per carrier in that suite:

- `ablating_short_anchors_rejects_the_carrier_and_the_full_form_still_edits` —
  with the short spelling rejected, the full `old_string`/`new_string` form lands
  the same edit, so the ablation isolates the carrier and not the edit path.
- `ablating_batch_edit_hides_the_tool_and_rejects_its_calls` — `apply_patch`
  leaves the definitions and its call is refused while `edit_file` keeps working.
- `replace_all_and_the_ablation_switch_never_rebase` (existing `edit_recovery.rs`)
  and the recovery switch cover the rebase arm; `an_ablated_rebase_costs_a_reread_and_a_retry`
  measures what the ablation costs.

## Criterion 2 — fuzzy matches are unique and explainable, rejecting ambiguous targets

`edit_file`'s fallback matches a contiguous line window that equals the needle
up to per-line leading/trailing whitespace. One candidate applies with
`fuzzy: true` and a note naming the match line and the matching rule; more than
one candidate is refused naming every candidate line range and the
`replace_all` escape hatch; a digest mismatch never reaches the fuzzy path —
drift stays the recovery path's failure to refuse.

| command | observed |
| --- | --- |
| `cargo test --test edit_carriers` | ok — the three fuzzy scenarios below pass (same run) |
| `cargo test --lib file_mutation` | ok — the whitespace/drift/blank-needle unit tests pass (same run) |

- `a_unique_fuzzy_target_applies_and_explains_itself` — a tab-transcribed
  needle (not an exact substring) lands on the unique target; the result names
  line 2 and the whitespace-insensitive rule; the whole interaction stays at
  two provider turns, no re-read.
- `an_ambiguous_fuzzy_target_is_rejected_with_every_candidate` — two
  whitespace-insensitive candidates are refused with `lines 2, 5`, the refusal
  carries the current fingerprint for a readless retry, and the file is
  untouched.
- `an_exact_match_never_goes_fuzzy` — an exact match applies with no `fuzzy`
  field.
- `fuzzy_is_inapplicable_across_drift` and `fuzzy_regions_*` unit tests — the
  region scan, trailing-newline normalization, blank-needle rejection, and the
  drift boundary.

## Criterion 3 — account for failed re-read and retry costs

The cost accounting is turn-count pinned, in provider turns of the same
scripted scenario (read → external drift → stale edit):

- `rebasing_saves_the_reread_and_retry_turns` — recovery on: **2 turns**
  (read + rebased edit), `rebased: true` in the result.
- `an_ablated_rebase_costs_a_reread_and_a_retry` — recovery off: **4 turns**
  (read + failed edit + re-read + corrected edit).
- `a_stale_failure_hands_back_the_fingerprint_for_a_readless_retry` — the
  stale payload carries `current_sha256`, so a corrected retry needs
  **3 turns** and no re-read turn. This is the cheap-retry strategy the
  accounting keeps enabled: the fuzzy-ambiguous refusal joins the same
  payload, so one corrected call can succeed after a rejection.
- `batch_edit_lands_three_files_in_one_call` — **1 provider turn** for three
  files where the per-file path would need three calls;
  `the_short_anchor_carrier_edits_and_costs_fewer_bytes` pins the carrier's
  wire payload strictly below the full form for identical content.

| command | observed |
| --- | --- |
| `cargo test --test edit_carriers` | ok — the turn-count assertions above pass (same run) |

## Criterion 4 — link the implementation PRs, acceptance records, and versions

- Implementation: #2834 (this pull request; branch `feat/issue1955`).
- Acceptance record: this file, run on tree `e791239249`, CI run 42854193247.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

**Recorded open, not hidden:** the issue's real-client leg — quality, cost, and
latency evidence from live model runs comparing the carriers and the recovery
switch (the experiment adoption gate) — is not measured here. The offline
record pins the mechanism, the ablation switches, and the deterministic turn
costs; the live evidence needs real clients and stays open on #1955.
