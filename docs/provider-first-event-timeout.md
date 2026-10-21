# Provider stream watchdogs

A provider attempt can fail to produce a canonical stream event for three
different reasons, and a single deadline cannot separate them: the peer never
answers, it answers but stops sending bytes, or it keeps the socket warm while
the model takes a long time to produce its first token. The Session runner
tracks those phases independently.

| Phase            | Clock starts             | Default                                     | Environment variable              |
| ---------------- | ------------------------ | ------------------------------------------- | --------------------------------- |
| Response headers | Attempt dispatch         | 180,000 ms + 1 s per 32 KiB of request body | `MIAO_LLM_FIRST_BYTE_TIMEOUT_MS`  |
| Response bytes   | Last header or body byte | 180,000 ms                                  | `MIAO_LLM_STREAM_IDLE_TIMEOUT_MS` |
| Canonical event  | Last parsed event        | 300,000 ms                                  | `MIAO_LLM_EVENT_IDLE_TIMEOUT_MS`  |

The byte clock includes protocol keep-alives, so a provider that pings while
it is thinking is not mistaken for a dead connection. The event clock is
independent: keep-alive traffic can hold the byte clock open, but a stream that
never yields a canonical event still fails. A parsed event resets both clocks
and moves the attempt out of the header phase.

The header phase is the only one widened by request size, because large
prompts spend longer in gateways before response headers appear. The allowance
is capped at 30 minutes in addition to the base deadline.

Set any variable to `0` to disable that phase. The legacy single pre-event deadline remains for callers that cannot report
transport activity (blackbox replay and direct `LLM.stream` users): it uses
`MIAO_LLM_FIRST_BYTE_TIMEOUT_MS` and is cancelled by the first canonical event.
Subagent drains keep it too, because their silence is owned by the 15-minute
subagent boundary rather than the idle watchdogs.

A silent attempt is abandoned with a retryable `Transport` / `Timeout` error.
The HTTP pool is marked stale at the same moment, so the replay opens a fresh
connection instead of writing into the keep-alive socket the silent attempt may
have been stuck on. The existing provider retry schedule applies while no
durable visible answer or tool call has been published; completed mutations are
retained, and interruption does not trigger retry.

The runner creates one activity tracker per provider turn and resets its phase
on every subscription, so a retried attempt is judged on its own connection
rather than inheriting the first attempt's progress or silence.

`packages/core/test/session-first-byte-guard.test.ts` covers each phase, the
request-size allowance, retry re-subscription, connection-pool retirement,
immediate completion, and interruption cleanup.
`packages/llm/test/stream-activity.test.ts` covers the transport signals that
feed the watchdogs.
