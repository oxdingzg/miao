# Opt-in Responses WebSocket transport

HTTP/SSE remains the default. Enable WebSockets only after verifying the exact deployment's support:

```json
{
  "engine": {
    "responses_websocket_contract": {
      "model": "wire-model",
      "endpoint": "https://api.example/v1/responses",
      "authentication": "api",
      "mode": "full",
      "beta": true
    }
  }
}
```

The standalone option is `--responses-websocket-contract JSON`; the integrated environment override
is `MIAO_ENGINE_RESPONSES_WEBSOCKET_CONTRACT`. Model, normalized HTTP endpoint (including query) and
`api|subscription` authentication must match. The WebSocket endpoint uses the same path/query over
`ws|wss`. `beta:true` explicitly sends `OpenAI-Beta: responses_websockets=2026-02-06`; omit it for
verified deployments that do not need that header. Cache contracts are independently validated.
Raw continuation IDs, prewarm controls and unknown contract fields are rejected.

## Modes and state

- `full` reuses a Session connection while sending the full lowered input every turn.
- `delta` additionally permits `previous_response_id` and only appended items when a completed
  response has matching created/completed IDs and the next lowered history exactly extends the
  acknowledged input plus the accepted assistant output.

The acknowledged output must also map losslessly to native history: function argument bytes and
message/content boundaries must match. Compact completions with omitted outputs, reordered argument
serialization or changed message grouping keep using full requests on the reusable socket.

All actual non-input request parameters, ordered tools, system content and Context Epoch are checked.
Credential/account generation, endpoint, model, authentication and beta header bind the connection.
A role model with another model ID does not inherit the deployment assertion. History rewrites,
compaction/context changes and parameter changes send full history. A new connection or process
never inherits an old response ID; `store:false` is preserved.

Connections are Session-scoped and serialized per Session, with distinct Sessions able to progress
concurrently. Native forks inherit a cache-routing hint from their bounded persisted ancestry,
including after restart. This hint may improve placement for an identical prefix; it does not prove
a cache hit or authorize a continuation. The child retains its own WebSocket ownership identity,
connection and acknowledgement chain. Cyclic or more-than-64-hop ancestry uses the child's own hint.
There are at most 32 retained slots. Busy slots are not evicted; capacity overflow uses HTTP. Idle slots expire after 180 seconds when the pool is accessed. A delta proof retains at most
1 MiB of input/output items; larger histories still work through full requests. Clients outside an
engine Session use one-shot connections without continuation chains.

## Failures and observability

An unsupported/failed upgrade can fall back to the original full HTTP request. Authentication and
rate-limit handshake errors remain explicit. A suffix rejected by a recognized invalid-response-ID
error as the very first JSON frame can also rebuild over HTTP. After ambiguous delivery, partial
output, tool arguments, parse failure or cancellation, the socket and chain are discarded; the
transport does not silently resend that request over HTTP. A later retry rebuilds from local history.

WebSocket frames pass through the same Responses parser, tool-input/first-event watchdogs, idle
limits, cancellation, progress backpressure and normalized deltas as HTTP/SSE. Pretty-printed JSON
and control pings are handled without changing semantic deadlines. Per-message and cumulative
response budgets remain bounded. Request receipts hash the actual sent JSON frame, including the
suffix when one was sent; a shortened wire input does not by itself mean model context was compacted.

Progress includes `transport.websocket` with `reused`, `delta`, `json_sent_bytes` and
`json_received_bytes`. These count JSON payload bytes, not TCP/TLS/framing overhead or billed tokens.
Transport optimization is not evidence of cache or cost savings; evaluate usage, latency and task
success separately for API, subscription and compatible deployments.

The WebSocket connector currently has no proxy implementation. If an HTTP/HTTPS/ALL proxy environment
variable is set, requests stay on the HTTP client's configured routing rather than bypassing it.
Loopback socket tests require a child test environment without those proxy variables.
