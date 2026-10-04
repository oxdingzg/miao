# Repetitive provider output: investigation and protection

[简体中文](provider-output-repetition.zh.md)

## Findings — 2026-10-04

A local session using `opencode-go/deepseek-v4.1-flash`, variant `default`, repeatedly emitted short
step markers such as `Emit.` and `edit.` before eventually making a structured tool call.

Read-only inspection of the session projection, durable events, and turn logs found:

- Eight visibly repetitive turns in the affected session. One contained 437 repeated marker
  lines. The repeated text exists in both projected assistant content and a durable
  `session.next.text.ended` event; it is not solely a terminal-presentation artifact.
- These turns ended with `tool-calls` and completed tools. This differs from malformed XML/DSML
  tool calls that never execute, and from a runner repeatedly dispatching after `finish=stop`.
- The affected session had 63 turns in the inspected interval, with provider-reported
  `input + cache.read` ranging from 276,517 to 372,283 tokens.
- Concurrent sessions on the same provider, model, and variant remained usable. Two had larger
  reported inputs: 34 turns at 542,622–570,030 tokens, and 78 turns at 402,187–514,485 tokens.
  A fourth had 41 turns at 8,492–62,998 tokens.

Length alone therefore does not explain the failure. Session-specific history, generation
behavior, request parameters, and gateway routing remain possible contributors. A model's own
claim that it has "degenerated" is not diagnostic evidence.

No historical provider-wire archive was found in the default archive directory. Durable records
identify the abnormal output before rendering, but cannot fully distinguish upstream generation
from protocol-decoding behavior. This is an application-side mitigation, not a proven fix to the
provider's underlying model or routing.

Related upstream reports: [#44962](https://github.com/anomalyco/opencode/issues/44962),
[#43146](https://github.com/anomalyco/opencode/issues/43146),
[#52763](https://github.com/anomalyco/opencode/issues/52763). They were open at investigation time.

## Protection

`packages/core/src/session/runner/output-guard.ts` guards each provider attempt before events reach
the durable publisher or local tool dispatcher. Text and reasoning blocks are tracked separately;
state is created per stream subscription, not shared between Sessions or windows.

The initial detector is deliberately conservative:

- Inspect a rolling window of 64 short, nonempty prose lines, ignoring blank separators.
- Require at most six distinct lines, with the two most frequent accounting for at least 58.
- Skip fenced code and reset across long lines, JSON, tables, lists, and non-prose content.
- Bound retained state to 16 content blocks, 64 lines per block, and 160 UTF-16 units per line.
- Do not inspect tool arguments. This is separate from repeated-tool-call limits.

When detection fires, the stream fails with a non-retryable `InvalidProviderOutput` error and a
visible message beginning `Stopped repetitive text output` or `Stopped repetitive reasoning output`.
The runner retains already-published output, settles previously started tools, and does not
replay the provider turn automatically. Tool calls after the detected loop are not dispatched.
The warning log `session.output.repetition` records the channel and window size, not transcript text.

Before a later explicit continuation, provider-facing history neutralizes repetitive assistant
text/reasoning (including recognizable historical loops). Durable messages remain intact, and
recorded tool calls/results remain in context so completed side effects are not hidden.

## Verification and limits

A local-only replay corpus contained 263 text/reasoning parts from four concurrent sessions:

- Affected session: 7 severe loops detected in 55 parts. The eighth, shorter episode did not meet
  the conservative threshold.
- Three comparison sessions: 208 parts, no detections.

This checks the observed corpus, not every possible legitimate output. Intentionally repeating
unfenced short prose at this frequency may also trigger the guard. Repetition without line breaks,
long repeated paragraphs, and short loops below the threshold are outside this initial detector.

Regressions cover text/reasoning, chunk boundaries, Unicode/CRLF, code/list/table exemptions,
stream finalization, per-part/per-subscription isolation, no automatic retry, completed-tool
settlement, and provider-context neutralization while preserving durable history.

This change does not enable raw provider-wire capture retrospectively or replace the installed
release binary. Where available, opt-in `MIAO_LLM_WIRE_ARCHIVE` captures future wire evidence;
it cannot reconstruct earlier responses. No credentials, local raw transcripts, or machine
addresses are included here.
