# Native client acceptance — 2026-10-16

This pass uses the published v0.2.13 macOS arm64 engine and a local,
deterministic OpenAI-compatible provider. No paid model calls are involved.
Product-shell probes use the TypeScript shell with the client-event fan-out
fix in #910. The ACP probes use the independent `@agentclientprotocol/sdk`
0.21.0 client, connected to the executable's `acp` stdio entry point.

## Observed outcomes

| Boundary | Scenario | Result and oracle |
| --- | --- | --- |
| Attached full TUI | Grant once | Pending permission dialog renders. Enter grants once, the engine writes the requested file, and the transcript renders the tool and result. |
| Attached full TUI | Reject | Esc rejects the pending permission. No file is created; the native ledger contains no `tool.dispatched`; the next provider request carries the rejected tool result. |
| Attached full TUI | Cancel and continue | Esc cancels a provider call held open by the fixture. No replacement provider request occurs, and a new prompt in the same Session reaches the provider and renders its answer. |
| Independent ACP SDK | Grant once | SDK decodes `session/request_permission`, selects the advertised allow-once option, receives streamed answer updates and `end_turn`. File contents and one dispatched native tool are checked. |
| Independent ACP SDK | Reject once | SDK selects the advertised reject-once option. The turn settles, no file exists and the ledger has zero tool dispatches. |
| Independent ACP SDK | Cancel and continue | Provider receipt is the readiness signal. SDK sends `session/cancel`, receives `cancelled`, observes no replacement request, and completes another prompt. |
| Independent ACP SDK | Replace process and resume | A new engine process opens the same ledger. `session/resume` emits no old assistant answer. The next provider request retains the prior prompt and answer, plus the new prompt. |

The SDK cases are executable in
`packages/miao/test/engine/native-acp-sdk.test.ts`. From `packages/miao`, run:

```sh
MIAO_ENGINE_BIN=/absolute/path/to/miao-engine bun test test/engine/native-acp-sdk.test.ts
```

The engine workflow runs these cases against the source-built executable on
Linux and macOS, so the binary-gated cases are not silently skipped in that
verification lane. The local results against the published binary were three
passing cases with 22 assertions.

## Usage evidence correction

Message-level usage is already projected by the native journal translator and
transcript reducer. The existing `native-history-http.test.ts` passes against
the published v0.2.13 engine and checks assistant input/output tokens, history
paging and absence of TypeScript shadow message rows. An earlier observation
of zero Session-level totals must not be read as a failure of that message
projection. #911 connects GET Session lifetime tokens to the engine's existing
usage report and tests two billed turns including cache-read totals.

## Remaining gates

- The independent SDK verifies a real external protocol consumer; it is not an
  acceptance run inside a third-party editor UI. That UI integration remains
  open.
- These SDK probes do not measure slow-client memory bounds or prove cursor
  replay after a backlog overflow. Existing crate backpressure tests remain
  separate evidence for those mechanisms.
- Provider failure rendering, full product reconnect/replay and the complete
  usage/cache/TTFT presentation matrix still need product acceptance.
- Neither this pass nor #911 supplies native pricing or fabricates product
  model identities. Lifetime per-model usage remains distinct from the token
  totals the engine can report today.
