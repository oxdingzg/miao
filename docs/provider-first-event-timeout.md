# Provider first-event deadline

The Session runner bounds a provider attempt that accepts a request but never
produces a canonical stream event. Set `MIAO_LLM_FIRST_BYTE_TIMEOUT_MS` to control
the deadline:

| Value                            | Behavior                            |
| -------------------------------- | ----------------------------------- |
| Unset or empty                   | 60,000 milliseconds                 |
| Non-negative finite number       | Configured deadline in milliseconds |
| `0`                              | Disable the first-event watchdog    |
| Invalid, negative, or non-finite | Use the 60,000 millisecond default  |

The clock starts when the provider stream is consumed. Its timer is cancelled as
soon as the first canonical event arrives, so healthy streams can complete
immediately and later generation or local tool execution can continue beyond
that deadline. An empty stream that has already completed does not wait for the
timer.

A silent attempt is interrupted with a retryable `Transport` / `Timeout` error.
The existing provider retry schedule applies while no durable visible answer or
tool call has been published. Its budget still bounds repeated silent attempts;
completed mutations are retained, and interruption does not trigger retry.

The first-event watchdog uses a fresh signal per subscription, including a
retried attempt. It closes the abandoned upstream stream before retry and keeps
normal stream completion, blackbox capture/replay, input promotion, and tool
settlement on their existing orchestration path.

`packages/core/test/session-first-byte-guard.test.ts` covers silence, immediate
completion, timer cancellation, disabled deadlines, and interruption cleanup.
Session runner regressions cover durable retry followed by a successful answer
and disabled-timeout interruption. The separate subagent silence regression
starts its stream first, then verifies its existing 15-minute no-output boundary.
