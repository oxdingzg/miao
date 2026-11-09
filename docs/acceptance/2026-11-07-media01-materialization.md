# MEDIA-01 — attachment materialization, capability refusal, and the stdio frame budget

**Item:** MEDIA-01 · manage images, PDFs, URLs, and managed attachments (issue #1987)
**Tree:** `test/media01-materialization` @ `7157d9cb01` (this record's commit), parent `origin/main` at `4f4a9621bd` (0.3.54).
**Environment:** Linux x64 build host, `cargo test` run from `crates/miao-engine` with poppler and
ghostscript installed (the pdf suite's render test needs `ps2pdf`/`pdftoppm`). The media suite is
timing-sensitive: two earlier attempts on the same host ran while other builds saturated the box and
the suite's bounded waits Elapsed — including two pre-existing tests with their own 5 s timeouts. The
recorded run below is a quiet-machine run; expect spurious `Elapsed` failures under compile
contention, not behavioural ones.

## Criterion 1 — "Materialize local, remote, and managed URIs according to model capabilities while preserving permissions"

**Command:** `cargo test --test media capable_models_get_pdf_bytes_materialized_into_the_workspace_and_recover_them`
**Observed:** `1 passed; 0 failed`

Engine admission is bytes-first: the wire contract is
`Attachment { mime, data, metadata }` (`crates/miao-engine/src/protocol.rs:49`), so clients resolve
local and remote URIs into managed attachment bytes before admission and the engine-testable face of
this criterion is those managed bytes. The test pins that face end to end: a capable provider
receives the PDF inline as an Anthropic `document` part while the exact bytes are also materialized
under `.miao/attachments/<fingerprint>-spec.pdf` inside the confined workspace (the copy's path stays
under the workspace root, which is what "preserving permissions" means for tool reads), the durable
history keeps `mime`/`data`/`metadata` including the copy's path, and deleting the workspace copy and
re-admitting rebuilds it byte-identically on the next turn.

**Command:** `cargo test --test media capability_mismatch_refuses_media_consistently_and_keeps_bytes_recoverable`
**Observed:** `1 passed; 0 failed`

The capability split: a text-only provider gets placeholder notes on the wire instead of pixels or
document bytes, while the PDF is still materialized so the "read the file with tools" promise is
keepable, and a capable runtime reopened over the same durable session sends both media inline again.

## Criterion 2 — "Provide usable tool read paths for unsupported types or reject them consistently"

**Command:** `cargo test --test media capability_mismatch_refuses_media_consistently_and_keeps_bytes_recoverable`
**Observed:** `1 passed; 0 failed`

Refusal is consistent: the wire carries `[image attachment omitted: model does not support image
input: diagram.png]` and the PDF's "cannot receive application/pdf directly … read the file with
tools" note, no raw bytes leak to the wire, and the tool-read path still works because the PDF copy
exists in the workspace.

**Command:** `cargo test --test pdf`
**Observed:** `test result: ok. 3 passed; 0 failed; 0 ignored`

The read path itself: page-range selection parses `1-2,4` and rejects `0`/`2-1`/out-of-range pages,
and a real ghostscript-rendered PDF (built by the test via `ps2pdf`) reads its text pages through
`pdf::read` and renders the page that has no text layer to an image with page metadata — so the
model's fallback read of a refused PDF is a usable tool path, not a stub.

## Criterion 3 — "Validate size limits, content types, cancellation, and large stdio frames end-to-end"

**Command:** `cargo test --test media unsupported_media_is_rejected_before_any_durable_state`
**Observed:** `1 passed; 0 failed`

`application/zip` is rejected as an unsupported media type, PNG bytes mislabelled as
`application/pdf` are rejected with "PDF attachment has no PDF header" (content-type validated
against bytes), an 8 MiB+ attachment is rejected with "attachment data must be 1..8 MiB", non-UTF-8
text is rejected, a 9-attachment input is rejected on the count limit — and every rejection leaves
zero events and zero history, while the same identity admits cleanly once the media is valid.

**Command:** `cargo test --test media cancelling_a_media_turn_leaves_durable_attachments_and_the_workspace_copy_intact`
**Observed:** `1 passed; 0 failed`

The test waits for the materialized workspace copy to appear — materialization runs while the
provider request is built, just before `stream`, so the cancel then lands mid-turn by construction
against a provider blocked inside its stream — and after the cancellation the workspace copy and the
durable attachment are both intact, and the cancelled identity still reconciles an exact retry.

**Command:** `cargo test --test media large_admission_frames_survive_stdio_and_oversized_frames_are_refused_in_place`
**Observed:** `1 passed; 0 failed`

A ~1.2 MiB base64 PDF attachment rides one stdio admission frame to a real `miao-engine serve`
process and comes out the far side intact in the promoted `input.promoted` event; a 16 MiB frame is
refused in place with `request_too_large` and its request id recovered, the engine keeps serving
after the refusal, and it shuts down cleanly.

## Criterion 4 — "Link implementation PRs, offline or real-client acceptance records, and target versions, attaching quality, cost, and latency evidence for optimizations"

Implementation: #1456 materializes PDF attachments providers cannot carry inline, #1444 presents
inlined text attachments as file blocks, #1376 lands the pdf read path. Offline acceptance record:
this file, produced by the test-pinning commit on this tree. Target version: the dev tree after
0.3.54 — the release stamp is added by the roadmap convention when a release ships this tree.
Quality, cost and latency evidence: not applicable — this work pins existing behaviour and records
no optimization claim, so there is no measurement to attach.

## Regression coverage

**Command:** `cargo test --no-fail-fast --test media --test pdf`
**Observed:**

```
test result: ok. 11 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 9.69s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.45s
```

The one ignored test is the explicit ffmpeg-gated video workflow, which stays run-on-demand on a
build host with ffmpeg per `crates/miao-engine/docs/media-workflow.md`.
