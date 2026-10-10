# OpenAI Responses: Persistent Connection + Incremental Sending (V2)

## Status (2026-10-01)

Phase 0 measured; the plan is reordered by its result. **Step 1 (pooled WebSocket, full payload,
HTTP fallback) is implemented** in `packages/llm/src/route/transport/websocket-pool.ts` and
`OpenAIResponses.pooledTransport`, and is the default ChatGPT OAuth transport (`MIAO_RESPONSES_WS`,
default on for every channel; `=0` forces HTTP). Graduating it to default also hardens the connection
against mid-turn `ECONNRESET` on the HTTP SSE path, because the pool owns its socket and never reuses
one that errored or finished a turn. Incremental sending (`previous_response_id`) is deferred:
see "Phase 0 result". Codex citations refer to the sparse clone of `openai/codex` (`codex-rs/...`)
taken on 2026-10-01; miao citations refer to `main` at `3e489920e`.

### Phase 0 result

Standalone spike, ChatGPT backend, `gpt-6.1-sol` medium, `store: false`, a 7-call tool chain,
three variants interleaved in rotating order (small: 4 rounds, ~0.2-0.4k input tokens; large: 3
rounds, ~50k input tokens, 99% cached):

| Median per call          | small  | large  | large p75 |
| ------------------------ | ------ | ------ | --------- |
| HTTP, fresh request      | 3.28s  | 3.54s  | 5.03s     |
| WS, full payload         | 2.46s  | 2.83s  | 3.84s     |
| WS, incremental          | 2.45s  | 2.67s  | 2.77s     |

- The persistent socket is the win: 0.7-0.8s per call at any context size. That matches the gap to
  Codex measured above, so the "re-ingestion" explanation below was wrong for small context and
  overstated for large.
- Incremental sending adds ~0.16s median at ~50k tokens and trims the tail; nothing at small
  context. `previous_response_id` with `store: false` over the socket was accepted in all 42
  incremental calls.
- Opening a socket costs ~1s once per session (paid on the first turn).

Therefore: ship the pool first, measure it on real miao sessions, and treat incremental sending as
an optimisation for long contexts whose fallback complexity must earn its ~0.2s.

## Problem

Measured on the ChatGPT OAuth path (`gpt-6.1-sol`, medium reasoning, interleaved A/B runs):

| Per provider call        | ~3k-token context | ~67k-token context |
| ------------------------ | ----------------- | ------------------ |
| Codex CLI                | 3.10s             | 2.95s              |
| miao V2                  | 4.07s             | 5.22s              |
| miao V2 local overhead   | ~0.14s            | ~0.14s             |
| V1 WS (full payload) gain over V1 HTTP | ~0  | ~0.5s              |

Replaying miao's exact request body over HTTPS costs the same as miao minus local overhead, so the
remaining gap (~0.8s small, ~2.1s large) is in *how* the request is sent, not in what miao does
before sending. miao V2 sends one fresh HTTPS `POST /responses` per provider turn carrying the full
conversation with `store: false`. Codex keeps one Responses WebSocket open, sends only the new input
items with `previous_response_id`, prewarms, and replays a sticky-routing token. The gap grows with
context size, which is the signature of re-ingesting the whole transcript every call.

## How Codex does it (evidence)

All paths under `codex-rs/`.

1. **Connection lifetime spans turns; routing state does not.** `ModelClientSession` is created per
   Codex turn (`core/src/client.rs:11-21`, `:280-306`), but `new_session()` takes the cached
   `WebsocketSession` from the session-lifetime `ModelClient` (`:609-622`, `:637-651`) and `Drop`
   puts it back (`:1342-1346`). So the socket *and* the last request/response survive across turns.
   The `x-codex-turn-state` token is a fresh `OnceLock` per turn (`:620`) and "must not [be sent]
   between different turns" (`:296-306`).
2. **Cached state.** `WebsocketSession` holds `connection`, handshake `responses_headers`,
   `connection_key`, `last_request` (the full logical request), and `last_response_rx`
   (`:321-332`). `LastResponse` is `{ response_id, items_added }` (`:309-313`).
3. **Last response is armed only on success.** `map_response_events` collects every
   `OutputItemDone` and sends `LastResponse` only on `ResponseEvent::Completed` (`:2377-2530`,
   send at `:2454`). `get_last_response()` *takes* the receiver (`:1425-1433`), so any failed,
   interrupted or retried attempt leaves no continuation and the next send is full.
4. **Incremental rule.** `get_incremental_items` (`:1386-1423`):
   - every non-input request property must match (`responses_request_properties_match`,
     `:335-394`, exhaustive destructuring so new fields force a decision): `model`, `instructions`,
     `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`,
     `service_tier`, `prompt_cache_key`, `text`. Ignored: `stream_options`, `client_metadata`,
     `access_programs`.
   - `current.input` must start with `previous.input ++ last_response.items_added`, compared
     item-by-item (`:1401-1421`) with `response_items_equal_ignoring_internal_metadata`
     (`:396-414`), which rejects late tool-result metadata changes ("A delta cannot carry that
     update").
   - the delta is `current.input[previous.len + output.len ..]`; an empty `response_id` disables it
     (`:1442-1445`).
5. **Wire format.** `ResponseCreateWsRequest` is the HTTP body plus `previous_response_id` and
   `generate` (`codex-api/src/common.rs:334-360`). With a continuation, `input` is only the delta
   (`core/src/client.rs:2002-2024`). Item IDs that are not server-prefixed are stripped
   (`:1016-1026`). `last_request` always stores the full logical request (`:2093`).
6. **Connection reuse rules.** `websocket_connection` (`:1552-1620`) reconnects when handshake
   headers differ, when `ResponsesConnectionKey(provider, auth_revision)` differs (`:1566-1572`),
   when the socket is closed (`:1574`), or when auth ownership changed (which also clears turn
   state, `:1580-1584`). Reconnect calls `WebsocketSession::reset`, which drops `last_request`
   (`:417-428`), so a new socket always starts with a full request.
7. **Handshake headers.** `OpenAI-Beta: responses_websockets=2026-02-06` (`:175`, `:1327-1330`),
   session/thread headers (`:1318-1321`), routing hint, originator; permessage-deflate is enabled
   (`codex-api/src/endpoint/responses_websocket.rs:550-557`).
8. **Sticky routing.** `x-codex-turn-state` is captured from the WS handshake response headers
   (`responses_websocket.rs:534-541`) or a `response.metadata` event
   (`:766-769`, `codex-api/src/sse/responses.rs:210-218`), then replayed: inside the WS
   `client_metadata` (`core/src/client.rs:1965-1967`) and as an HTTP header (`:2336-2340`).
9. **Prewarm.** A v2-only `response.create` with `generate: false` and the full request; Codex waits
   for `Completed` so the first real request is incremental against the warmup response id
   (`:17-26`, `:2165-2222`, `:2023`). It runs at session startup and idle-thread resume
   (`core/src/session/startup_prewarm.rs:390`, `:434`) and the prewarmed session is handed to the
   first turn (`core/src/session/turn.rs:177-178`). `preconnect_websocket` does handshake only
   (`client.rs:1457`).
10. **Errors and fallback.** `previous_response_not_found` and `websocket_connection_limit_reached`
    ("60 minutes") map to `ApiError::Retryable` (`responses_websocket.rs:164-168`, `:621-655`);
    the retry is full because of (3). `426 Upgrade Required` returns `FallbackToHttp`
    (`client.rs:1929-1933`, also preconnect `:1513`). After the retry budget, `try_switch_fallback_transport` disables WS
    for the rest of the session (`core/src/responses_retry.rs:120-137`, `client.rs:654-672`,
    `:2285-2299`). Per-request idle timeout: `responses_websocket.rs:190-191`, `:693-694`.
11. **Telemetry.** Counter `WEBSOCKET_CONTINUATION_COUNT_METRIC` tagged `mode` (incremental/full),
    `reason` (`no_previous_request`, `restored_history`, reset reason, `other`), `phase`,
    `after_prewarm` (`client.rs:1968-1984`, `:2068-2081`).
12. **HTTP side note.** Codex zstd-compresses HTTP request bodies to the Codex backend
    (`client.rs:1623-1632`).

## Protocol: `store: false` vs connection-scoped state

Codex builds every request with `store: false` (`core/src/client.rs:1003`) and still sends
`previous_response_id` over the WS v2 beta (`:2021`). The HTTP request type has no
`previous_response_id` at all (`codex-api/src/common.rs:308-315` sets it to `None` when converting),
so Codex never continues over HTTP. Conclusions:

- With `store: false`, the prior response is **connection-scoped server state**, not persisted
  state. It exists only on the socket that produced it. Any reconnect loses it; Codex resets
  `last_request` on reconnect for exactly this reason.
- The server can still lose it on a live socket (eviction, backend move); it then answers
  `previous_response_not_found` and the client must resend the full request.
- miao keeps `store: false` (ZDR-friendly, matches Codex). We do not rely on server-stored responses
  and we never send `previous_response_id` over HTTP.
- `include: ["reasoning.encrypted_content"]` stays on (Codex `client.rs:965`,
  miao `openAIDefaultOptions`) so a full fallback request can always replay reasoning.

## Current miao state

- V2 route: `packages/core/src/session/runner/model.ts:167-205` builds `OpenAIResponses.route`
  (HTTP SSE). ChatGPT OAuth swaps the base URL to `https://chatgpt.com/backend-api/codex`, adds
  `ChatGPT-Account-Id`, forces `store: false` (`:189-201`).
- Request: `packages/core/src/session/runner/llm.ts:351-394` sets `session-id` = prompt cache key
  (header) and `providerOptions.openai.promptCacheKey`; history is reloaded every attempt
  (`:316-318`); one `llm.stream(request)` per attempt (`:444`); in-turn retries only before anything
  was published (`:509-532`); `session.turn` log has `ttftMs`, `turnMs`, local split (`:608-636`).
- Lowering: `packages/llm/src/protocols/openai-responses.ts:346-454`. The system prompt becomes a
  leading `role: system` input item; mid-history system updates are **merged into the preceding user
  item** (`:353-361`); store:false reasoning is replayed as `{type, summary, encrypted_content}`
  without IDs and dropped when it lacks encrypted content (`:446-453`).
- WebSocket today: `OpenAIResponses.webSocketRoute` (`:1004-1020`) on `WebSocketTransport.json`
  (`packages/llm/src/route/transport/websocket.ts:226-262`) opens a socket **per request** via
  `acquireRelease` and closes it after the stream. It sends no `OpenAI-Beta` header, has no
  continuation, and `WebSocketExecutor.Service` is not provided in core
  (`packages/core/src/effect/app-node-platform.ts` provides only `RequestExecutor` + `LLMClient`).
- V1: `packages/miao/src/plugin/openai/ws-pool.ts` pools one socket per session (15s connect, 5 min
  idle, 55 min max age, busy → HTTP, 5 failures → HTTP for the session), still full payload
  (`README.md` lists `previous_response_id` as next step). Proxy support via `ProxyEnv` in `ws.ts`.

## Proposed architecture

### Layering

The optimization lives **entirely below `llm.stream(request)`** in `packages/llm`. The runner keeps
building the full logical request from reloaded projected history on every provider turn; the
transport decides whether that request can be sent as a delta. The full request remains the source
of truth and is what the transport compares against, so losing transport state only costs latency.

New pieces (names indicative):

1. `ResponsesSocketPool` service in `packages/llm/src/route/transport/` (process-global; provided as
   a global node next to `llmClient` in `app-node-platform.ts`, alongside the first real
   `WebSocketExecutor.Service`). It owns `Map<ConnectionKey, Entry>`.
2. `OpenAIResponses.sessionSocketRoute`: same protocol, endpoint and auth as `route`, transport =
   pooled socket + continuation. Falls back to the HTTP transport internally (see Failure modes).
3. A typed OpenAI option carrying caller identity, e.g.
   `providerOptions.openai.continuation = { key: string, turn: string }`. `key` = Session ID (the
   pool must not infer it from headers as V1 did); `turn` = sticky-routing scope (below). Requests
   without `continuation` (title, summarize, compaction summaries, small model) use plain HTTP.
4. `fromCatalogModel` selects `sessionSocketRoute` only for `@ai-sdk/openai` when the flag is on.

Dependency direction stays Schema → Core/Protocol → Server: the pool is an `llm` route concern;
core only passes the option and provides the layer.

### Entry state

```
Entry {
  socket, connectionKey, handshakeHeaders, openedAt, lastUsedAt, busy
  last?: { request: FullBody, responseID: string, output: OutputItem[] }   // armed on completed only
  turnState?: { scope: string, token: string }
  fallback?: { until: number, reason }                                  // HTTP-only window
}
ConnectionKey = hash(baseURL, model route id, auth header value, ChatGPT-Account-Id)
```

### Lifecycle

- **Open lazily** on the first eligible request (or by prewarm). Connect timeout 15s.
- **Reuse** while `connectionKey` and handshake headers match and the socket is open; otherwise
  close, reset `last`, reconnect (Codex rule 6).
- **Idle timeout 5 min** (matches V1 and `WARM_WINDOW_MS` in `llm.ts:160`); pruned by a timer.
- **Max age 55 min**, rotated only at a request boundary (server limit is 60 min); a rotation sends a
  full request on the new socket.
- **Pool cap** (e.g. 32 entries, LRU) so many idle subagent Sessions cannot exhaust connections.
- **Scope**: closing the pool layer closes all sockets.

### Concurrency and V2 invariants

- `SessionRunCoordinator` serializes drains per Session, so at most one provider turn per Session is
  in flight. The entry still has a `busy` flag; a second concurrent request for the same key (should
  not happen) goes HTTP full, never queues.
- Different Sessions (including subagent child Sessions) get different entries and run concurrently.
- `SessionExecution` stays Session-ID based and process-global; no layer takes a Session ID — the key
  arrives per request.
- "One explicit `llm.stream(request)` per provider turn" holds: no in-memory tool loop, no skipped
  history reload. Tools still settle in the runner; the next provider turn reloads history, rebuilds
  the full request, and only then does the transport diff it.
- "Advisory wakes / no post-crash continuation" holds: the pool is advisory, never durable, and has
  no transcript identity. A process restart simply sends full.

## When an incremental request is safe

Compare in the **lowered OpenAI body** space (after `lowerMessages`/`lowerOptions`, before
encoding), mirroring Codex. Let `P = entry.last.request`, `O = entry.last.output` (raw
`response.output_item.done` items of the completed response), `C` = current full body.

Send `{ type: "response.create", ...C, previous_response_id: last.responseID, input: delta }` iff
all hold:

1. `entry.last` exists, was armed by `response.completed` on **this socket**, and is consumed now
   (taken, Codex rule 3). Retries therefore always go full.
2. `responseID` non-empty.
3. Properties equal (exhaustive, a new body field must be classified): `model`, `instructions`,
   `tools` (deep, order-sensitive), `tool_choice`, `store`, `reasoning`, `include`, `service_tier`,
   `prompt_cache_key`, `text`, `max_output_tokens`, `temperature`, `top_p`.
4. `C.input.length >= P.input.length + O.length`.
5. `C.input[0 .. P.len)` deep-equals `P.input` exactly.
6. `C.input[P.len .. P.len+O.len)` equals `O` under `canonical()`: a projection to model-visible
   fields only — message `{role, text parts}`, `function_call {call_id, name, arguments}`,
   `reasoning {encrypted_content, summary texts}`; ignores `id`, `status`, `annotations`,
   `logprobs`. miao's lowering is not lossless (IDs dropped, text parts joined, reasoning without
   encrypted content filtered, provider-executed tool calls skipped), so a mismatch here is
   expected occasionally and simply means full.
7. `delta = C.input[P.len + O.len ..]` is non-empty (an empty delta means a regenerate; send full).

On every send (full or delta) store `last = { request: C (full), ... }` pending completion.

### Fallback to full (same socket)

These fail the rule naturally and are recorded with an explicit `reason` tag:

| Cause | Breaks | Reason tag |
| --- | --- | --- |
| No prior completed response (first call, after retry, interrupt, failure) | 1 | `no_previous` |
| Reconnect / rotation / auth refresh / new socket | 1 | `new_connection` |
| Model, variant (reasoning effort, verbosity), service tier change | 3 | `properties` |
| Agent change (persona/system text, tool set, permissions) | 3 or 5 | `properties` / `prefix` |
| Tool-definition change (MCP reload, disabled tools, last step `tool_choice: none`) | 3 | `properties` |
| System-context epoch change (`SessionContextEpoch.prepare` rebuilt baseline) | 5 (system item) | `prefix` |
| Compaction (history replaced from `baselineSeq`) | 5 | `prefix` |
| `SessionPrune.toolResults` rewrote an older tool output | 5 | `prefix` |
| System update merged into the previous trailing user item (`openai-responses.ts:353-361`) | 5 | `prefix` |
| Revert / fork / edited history | 5 | `prefix` |
| Lowered output differs from server output | 6 | `output_mismatch` |

The runner does not need to signal any of these: the diff detects them. Optionally the runner may
pass `continuation.reset = true` after compaction to skip the comparison, but correctness must not
depend on it.

## Sticky routing (`x-codex-turn-state`)

ChatGPT backend only. Codex's "turn" is one user turn (prompt to final answer, many provider calls).
miao equivalent: the run of provider turns since the last promotion of user input. The runner sets
`continuation.turn` to the latest promoted input ID (or a drain-local counter bumped when
`promoted > 0`, `llm.ts:278-286`, the same boundary that resets the provider-turn allowance). The
pool clears `turnState` when `turn` changes, captures the token from the handshake response headers
or a `response.metadata` event, and replays it in `client_metadata["x-codex-turn-state"]` on WS and
as a header on HTTP fallback within the same scope. It is never replayed across scopes or after an
auth/account change. Bun's `WebSocket` exposes no upgrade response headers, so the
`response.metadata` event path is the primary capture on WS; verify the backend emits it.

## Prompt cache key and session headers

- Handshake headers carry the per-Session constants: `Authorization`, `ChatGPT-Account-Id`,
  `session-id` (prompt cache key), `X-Session-Id`, `x-session-affinity`, `x-parent-session-id`,
  `OpenAI-Beta: responses_websockets=2026-02-06`, originator.
- `prompt_cache_key` stays in every `response.create` body and is part of rule 3.
- Per-request values that HTTP sent as headers must move into `client_metadata` on WS. A change in
  any handshake header forces reconnect (Codex rule 6).
- The prompt cache still matters for full requests (first call, fallbacks); incremental requests
  avoid re-ingestion rather than replacing caching.

## Auth refresh

The OAuth access token is fixed at handshake. `ConnectionKey` includes the auth header value, so
the first request after `integrations.connection.resolve` yields a refreshed token reconnects and
sends full (about once per token lifetime). A handshake 401/403 surfaces as the existing HTTP auth
error so the existing refresh/retry path applies (see `4177b492c`: 403 is not retried). An open
socket whose token expires is kept until the next key mismatch; if the server closes it, the closed
check reconnects.

## API-key path (`api.openai.com`) vs ChatGPT path

- ChatGPT OAuth (`chatgpt.com/backend-api/codex`): primary target; Codex proves WS v2 +
  `previous_response_id` + `store: false` + turn state works there.
- API key: wire format is the same (`wss://api.openai.com/v1/responses`). Whether the public API
  honors the v2 beta and connection-scoped continuation with `store: false` must be probed live
  before enabling; ship disabled by default for API keys. No `x-codex-turn-state` on this path.
- OpenAI-compatible third parties and Azure: never use this route.

## Prewarm (phase 2)

1. **Preconnect**: handshake only when the TUI focuses a Session or the user starts typing. Cheap,
   no tokens; removes TLS + upgrade from the first call.
2. **`generate: false` prewarm** with the full current request after a cold start or reconnect of a
   large Session (e.g. on resume), so the first real call is incremental. Must not violate the
   runner model: it is issued by the pool from the last request it saw or from an explicit
   `llm.prewarm(request)` built by the runner from reloaded history, and it never produces visible
   output. Open: whether `generate: false` bills input tokens.

Prewarm is excluded from phase 1; measure phase 1 first.

## Failure modes and HTTP fallback

| Failure | Behavior |
| --- | --- |
| Upgrade refused / 426 / non-101 handshake | HTTP full for this request; key enters `fallback` for 10 min |
| Connect timeout (15s) or socket error before first event | HTTP full for this request (transparent, nothing published); count toward fallback |
| `previous_response_not_found` before first event | one transparent resend of the full body on the same socket, inside the same `llm.stream` call |
| `websocket_connection_limit_reached` | reconnect, resend full once |
| Socket closes or idle-times-out after events were emitted | fail as retryable `LLMError`; runner's existing rule (no retry once published) applies; entry reset |
| User interrupt mid-stream | close the socket (no reliable cancel frame known); entry reset; next call full on a new socket |
| N (=3) consecutive WS failures for a key | HTTP for that key until the entry is pruned (V1 behavior) |
| `response.failed` / `incomplete` | surfaced as today; `last` is not armed (only `completed` arms) |

Transparent fallback is legal only before any frame reached the runner; afterwards the error goes to
the runner's retry policy unchanged.

## Telemetry

Extend the `session.turn` log (`llm.ts:608`) and add a transport event from the pool:

- `transport`: `http` | `ws`; `connection`: `new` | `reused`; `connectMs`.
- `mode`: `incremental` | `full`; `reason` (table above); `afterPrewarm`.
- `inputItems` total vs `sentItems`; `sentBytes` (encoded message size).
- `sendMs` (encode + write), `ttftMs` (existing), `streamMs` (first event to terminal), `turnMs`.
- `fallback`: reason when WS → HTTP; `resend`: `previous_response_not_found` count.
- `cacheHitRatio` (existing) split by mode, to see whether incremental changes cached-token
  accounting.

## Testing strategy

1. **Unit, pure** (`packages/llm/test`): the incremental rule as a pure function
   `continuation(previous, output, current) -> { delta } | { reason }`. Cases: exact extension,
   empty delta, each property change, prefix mutation (system merge, prune, compaction), output
   canonicalization (IDs/status ignored, text split vs joined, reasoning without encrypted content),
   length underflow, empty response ID.
2. **Lowering round trip**: feed recorded `response.output_item.done` items through the runner's
   event publisher and `lowerMessages` and assert rule 6 holds for text, tool calls, parallel tool
   calls, reasoning — this is what decides the real incremental hit rate.
3. **Recorded WebSocket fixtures** using the existing `HttpRecorderInternal.makeWebSocketExecutor`
   (`packages/llm/test/recorded-websocket.ts`): multi-call cassettes asserting the second frame has
   `previous_response_id` and only the delta; `previous_response_not_found` → full resend;
   reconnect → full; turn-state capture and replay; interrupt closes the socket.
4. **Pool lifecycle** with a fake executor and `TestClock`: idle prune, max-age rotation, key change,
   busy → HTTP, fallback window.
5. **Core runner test** (`packages/core/test/session-runner.test.ts`): a tool-call loop over the
   pooled route produces identical durable events to the HTTP route.
6. **Live A/B benchmark** (manual, not CI): interleaved HTTP vs WS-full vs WS-incremental, small and
   large context, same prompts, ≥20 calls per arm, report median and p90 of ttft and turn time plus
   the incremental hit rate.

## Rollout

- Phase 0 (spike, before any production code): standalone Bun script that replays a recorded miao
  conversation on the ChatGPT path over WS v2 with and without `previous_response_id`, interleaved
  with HTTP. Go/no-go on measured gain.
- Phase 1a (done): pool + HTTP fallback, full payload, behind `MIAO_EXPERIMENTAL_RESPONSES_WS`
  (core `Flag`), default on for non-`latest` channels. ChatGPT OAuth only.
- Phase 1b: incremental rule + same-socket fallback, only if long-context sessions show it pays.
- Phase 2: preconnect/prewarm, API-key path after live probe.
- Phase 3 (done): default on for every channel as `MIAO_RESPONSES_WS` (legacy
  `MIAO_EXPERIMENTAL_RESPONSES_WS` still honoured); the flag stays as a kill switch. Graduated on
  connection-resilience grounds — the pool's own socket avoids the HTTP keep-alive staleness that
  surfaced as `ECONNRESET` mid-turn. Retire `webSocketRoute`'s per-request socket or make it use the
  pool.

## Expected benefit (honest)

Superseded by "Phase 0 result" above; kept as the pre-measurement estimate.

- Gap to close: ~0.8s/call small context, ~2.1s/call large context.
- Connection reuse alone (V1 data): ~0 small, ~0.5s large.
- Incremental sending removes re-upload and server re-ingestion of the whole transcript (including
  decrypting every replayed `encrypted_content` reasoning item). That plausibly explains most of the
  remaining large-context gap (~1.6s), giving an estimate of **~1.5-2s/call at ~67k tokens**.
- Small context: payload is ~12 KB, so incremental input cannot explain ~0.8s. Candidates are sticky
  routing (warm backend) and server-side continuation fast paths; expected gain **0-0.8s**, highly
  uncertain. Phase 0 must attribute this before we promise it.
- Hit rate matters: every compaction, epoch change, model switch, prune or output mismatch is a full
  call. If rule 6 mismatches often, the gain collapses to the V1 WS number.

## Open questions

1. Does the ChatGPT backend emit `x-codex-turn-state` in a `response.metadata` event, given that
   Bun's `WebSocket` hides upgrade response headers? If not, do we need a different WS client?
2. Does Bun's client `WebSocket` negotiate permessage-deflate and honor proxy settings like V1?
3. Does `api.openai.com` accept the v2 beta with `previous_response_id` and `store: false`?
4. Does `generate: false` prewarm bill input tokens, and does it help miao's usage pattern?
5. How long does the server keep a connection-scoped response on an idle socket (affects idle
   timeout choice beyond 5 min)?
6. Is there a cancel frame for an in-flight response, so interrupts can keep the socket?
7. Should `SessionPrune` and system-update merging be adjusted to be append-only, to raise the hit
   rate, or is full-on-change acceptable?
8. Is the turn-state scope "since last promoted user input" exactly equivalent to a Codex turn, or
   does the backend expect it to span steer promotions within one drain?
