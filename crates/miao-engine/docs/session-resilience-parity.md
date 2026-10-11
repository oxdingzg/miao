# Session resilience parity gate

These contracts apply to both execution backends. TypeScript implementations do not automatically change the Rust engine. Passing the original M0/M1 inventory or compilation alone does not establish parity with subsequently added Session behavior.

## Required cross-backend scenarios

| Contract                     | Required observable result                                                                                                                                                                                                                                                                                 | Current evidence anchor                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid local tool arguments | An unexecuted local call with invalid JSON may be corrected at most twice. A previously completed file write happens once. The final successful continuation is successful, while intermediate errors remain visible. Provider-executed calls and unknown side effects are not replayed.                   | TS #614; `packages/miao/test/cli/run/tool-input-recovery.test.ts`. Native Anthropic/Chat/Responses correction over durable history is covered by `tests/tool_input_recovery.rs`; actual cross-backend client parity remains pending.                                                                                |
| Argument generation budgets  | Bound unfinished arguments by UTF-8 bytes and elapsed generation time, including a stalled stream. Cancel before incomplete local dispatch. Preserve completed operations. Do not automatically replay a budget violation or apply the deadline to tool execution.                                         | TS #615; `packages/miao/test/cli/run/tool-input-budget.test.ts`. Native wire budgets: `src/tool_input.rs`, real HTTP watchdog regressions in `src/provider.rs`, and cumulative-frame regression in `tests/provider.rs`. Cross-backend recovery and actual-client parity remain pending.                             |
| Transport interruption       | A retryable abnormal close can resume over committed history within a bounded allowance. Partial output and completed tools remain observable; completed mutations are not repeated. Protocol/policy failures remain terminal.                                                                             | TS #590; provider and Session regressions. Native Anthropic/Chat partial-text continuation is covered by `tests/stream_continuation.rs`; finalized Responses/Gemini opaque receipt continuation is covered by `tests/opaque_continuation.rs`. Cross-backend actual-client parity remains pending.                   |
| Background completion        | A job completing after its Session becomes idle admits a durable completion notification, promotes it, and starts the next provider turn without a new human prompt. No lost wake or duplicate execution during completion/idle races.                                                                     | TS #610; actual compiled HTTP/model verification and `session-runner.test.ts`. Native atomic notification admission and existing-owner idle wake are covered by `tests/jobs.rs`; actual HTTP/TUI delivery and cross-backend parity remain pending.                                                                  |
| Dependency-ready work        | Stable task IDs and prerequisite edges survive reload. If 4 waits, 5 depends on 4, and 6 depends on 5, independent 7–9 remain runnable. Completing 4 unlocks only 5; completing 5 unlocks 6. Cancelling a prerequisite does not satisfy it. Invalid graphs are rejected without replacing prior state.     | TS proposal #618; `session-todo-dependencies.test.ts` and actual CLI continuation tests. Rust state/tool schema and dependency-ready context are covered by `crates/miao-engine/tests/state.rs`; native idle scheduling is covered by `goal_continuation.rs`; actual cross-backend client delivery remains pending. |
| Authorized idle continuation | Ready work continues within existing step, iteration, and no-progress limits only under explicit autonomous authorization or configured looping. A waiting-only graph, including its pending locked dependents, becomes idle without polling. Paused, blocked, or done goals stop autonomous continuation. | TS proposal #618; Core and actual CLI tests. Native runtime behavior is covered by `goal_continuation.rs`; actual product/client parity still requires verification.                                                                                                                                                |
| Client status projection     | A Session with ready unfinished work must not be represented as globally waiting merely because another task waits. Waiting-only dependency graphs, runnable tasks, completed work, and missing decisions remain distinguishable across transcript, sidebar, and terminal status reports.                  | TS #618 tests in `packages/tui/test/session-state*.test.*`. Both backend adapters must satisfy the same client contract.                                                                                                                                                                                            |

Issue and PR references above describe evidence or proposed changes, not an assertion that those changes are all published. Check the merged revision and actual executable under evaluation.

## Native dependency-state implementation slice

The native mutation parser and advertised tool schemas accept stable task IDs,
prerequisite edges, waiting/blocked states, and the recorded autonomous goal
flag. Graph validation happens before durable admission. State reload and fork
behavior retain dependency identity, and the provider receives the derived
runnable task set under the existing state-read permission.

Native idle-boundary continuation now durably admits an internal queued prompt
when an active explicitly autonomous goal has dependency-ready tasks. The same
owner continues after promotion; internal admissions do not refill the user-input
provider allowance. Waiting-only graphs, closed goals, denied state reads,
iteration limits, and no-progress limits stop continuation. Recording
`autonomous` does not independently grant permissions or change execution
ownership. Actual product/client-delivery parity remains a separate gate.

## Verification boundaries

- Use the same task graph, initial workspace, provider fixtures, and explicit side-effect oracle for both backends. Do not treat either implementation's accidental behavior as the specification.
- Include failures and attempted correction/continuation turns in usage, latency, and resource measurements. Unknown usage stays unknown.
- Verify native state admission and execution, not just an adapter that rewrites Rust output into an expected TypeScript shape.
- Keep Session execution ownership singular. A facade, external timer, background job, or notification must not introduce a second execution authority.
- Preserve exact retry identity, strict tape consumption, and unknown-side-effect handling. No live-I/O fallback or relaxed replay comparison may manufacture a passing result.
- Verify durable reload, provider turn boundaries, and real client delivery. Headless replay alone does not prove HTTP/TUI product readiness.

The default-backend switch remains gated on these scenarios, the existing ownership/protocol gates, fixed quality and efficiency measurements, and installation/rollback acceptance. Pending contracts must be recorded as gaps rather than marked complete from CI or a source-level resemblance.

## Native argument-budget implementation slice

The common SSE reader applies per-call UTF-8 byte and absolute generation-time
budgets before parser acceptance and local dispatch. Anthropic and Chat argument
deltas accumulate across frames; Responses deltas and authoritative final-only
arguments are checked, including compact completions. Gemini object arguments
are checked without relaxing its existing stricter reply limit.

Defaults are 1 MiB and 120 seconds, configured by `MIAO_TOOL_INPUT_MAX_BYTES`
and `MIAO_TOOL_INPUT_TIMEOUT_MS`; invalid or non-positive values use defaults.
The generation watchdog expires during silent sockets, unrelated pings, or
progress-channel backpressure. Finished calls release their generation deadline;
tool execution is outside this deadline. Violations fail without raw arguments
in the error and do not qualify for automatic transport retry. Already committed
operations remain in history. This slice does not add invalid-JSON correction or
claim actual cross-backend client parity.

## Native background-completion implementation slice

A job terminal transition and its stable-ID completion input are committed in
one transaction. The runtime then sends an advisory wake to the existing Session
coordinator, reusing normal steer promotion and singular execution ownership.
Successful, failed, cancelled, and unknown completions use the same path. The
notification contains the job ID and terminal state; stored output is read through
`job_status`, rather than copied into the prompt.

`tests/jobs.rs` verifies real subprocess execution followed by idle admission,
promotion, and a new provider drain without a second human input. Duplicate
terminal settlement admits no second notification. Turn cancellation stays
separate from job ownership, and shutdown joins owned jobs while preserving
pending notifications. Crash reconciliation still marks running effects unknown
without executing them again; it does not resume provider work automatically.
Actual HTTP/TUI client delivery remains a separate verification gate.

## Native invalid-argument correction implementation slice

A successfully terminated local tool call with syntactically invalid JSON is
projected with its original identity, an `invalid_json` marker, and explicitly
null unavailable input. Raw malformed arguments are not retained in the durable
call or error result. Invalid root shapes, stream truncation, hosted actions,
refusals, policy failures, and argument-budget violations remain terminal.

The runtime settles the invalid local call with a sanitized error without
permission checks, hooks, or tool dispatch, then reloads committed history for
at most two correction turns per admitted user-input allowance. Valid calls in
the same reply settle normally and are not automatically replayed. A third
invalid response settles its error but stops the run; a later successful answer
completes the run while intermediate errors remain visible. Provider-executed
and unregistered calls are not eligible for this correction path.

Durable history retains null plus the invalid-input marker. The selected model
request explicitly projects that failed call to an empty object because provider
wire schemas require object arguments; its paired error result explains that no
call was executed. This placeholder is never passed to a tool. It is an explicit
lossy error-history projection, not an argument equivalence rule for strict
cross-backend replay. Common-history parity still requires a declared mapping.

Real local HTTP fixtures cover all three wire adapters, two successive invalid
calls followed by valid recovery, a completed file write occurring once, exact
provider-turn/usage counts, no raw argument retention, and bounded changing call
identities. Actual product HTTP/TUI delivery remains a separate gate.

## Native validated partial-stream continuation slice

An actual response-body transport rejection can continue an Anthropic or Chat
turn when its parser has observed supported local text/call frames. The parser
returns retained text, known usage (unknown remains null), and the count of local
calls that were never dispatched. Raw unfinished arguments are discarded. This
explicit classification also survives routing metadata without switching models.

The Session records the failed attempt, commits retained partial assistant text,
and admits a stable internal steer for at most two continuation turns. Each turn
reloads committed history. Synthetic inputs do not refill the provider allowance;
external steers retain their normal boundary behavior and queued inputs stay
queued. Completed tool mutations remain committed and are not automatically
replayed. A third interruption preserves its partial evidence and stops.

A clean EOF without a complete protocol message, unsupported content, refusals,
argument-budget violations, cancellation, and unclassified/unknown provider
side effects are not eligible. Responses/Gemini finalized opaque receipt recovery is covered by the following
slice; unfinished or unknown opaque effects remain terminal. Recovery after process loss is not
automatic. The real HTTP regressions force reqwest body rejection below the
advertised Content-Length and distinguish it from clean EOF; they verify one
completed file write, no unfinished call dispatch, retained partial text,
continuation history, bounded failures, and unknown usage accounting.

Actual product/client delivery and strict cross-backend interrupted-history
mapping remain separate gates.

## Native finalized opaque receipt continuation slice

Responses continuation preserves only authoritative `response.output_item.done`
reasoning receipts and supported finalized message content, plus known pending
text deltas. A reasoning item still awaiting finalization, orphaned reasoning
progress, a non-completed finalized status, unknown sequenced checkpoints,
annotations on unfinished text, refusals, and hosted action items are not
classified as safe transport continuation. Unfinished local function calls are
counted but never dispatched or retained as executable history.

Gemini continuation preserves supported received text parts and non-empty
thought signatures exactly, with protocol/model-bound native capsules. Unsigned
thought parts, empty signatures, call-bound signatures without a completed local
call, and unsupported remote execution parts are terminal. Plain unfinished
local function calls are omitted without dispatch. Known partial usage remains
known and missing usage remains null; no successful-request metrics are invented.

`tests/opaque_continuation.rs` forces real response-body transport rejection and
checks the next wire request echoes the exact finalized Responses reasoning
object or Gemini signed parts. It also verifies the same model identity,
non-retention of unfinished arguments, no local dispatch, clean-EOF separation,
and the unsafe cases above. These are declared recovery boundaries, not alpha
renaming rules or proof of common-history/actual-client parity.
