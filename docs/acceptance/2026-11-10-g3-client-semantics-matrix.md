# Acceptance record — G3: real-client semantics matrix (refresh)

Item: REL-04 gate G3 (`specs/rust-retirement-gates.md`): each supported client
keeps its delivery, approval, question, change and error-recovery semantics.
This record refreshes the per-client evidence on the current tree — the
2026-10-24 records predate the pure-Rust product entry. Tree: `0df016375c`
plus the G1/G2 records already on main. Verification ran 2026-11-10 on the
macOS build host (`stable-aarch64-apple-darwin`, debug profile); every suite
below drives the real engine over its real transport, with the provider
stubbed at the wire boundary.

## ACP clients (Zed and other Agent Client Protocol hosts)

`crates/miao-engine/tests/acp_client_matrix.rs` — **4 passed / 0 failed**:

- reconnect resumes the same Session without replaying old output
- a provider failure settles and the Session accepts a later prompt
  (error recovery)
- cancellation settles a stalled provider and allows continuation
- a slow stdio reader still receives the complete answer once (delivery)

`crates/miao-engine/tests/acp.rs` — **7 passed / 0 failed**: the protocol
frame level (session lifecycle, mode selection, wire shapes).

## HTTP / web clients

- `crates/miao-engine/tests/full_http.rs` — **1 passed / 0 failed**: both
  wire adapters (OpenAI and Anthropic shapes) drive real HTTP tool dispatch
  and durable continuation.
- `crates/miao-engine/tests/http_sse.rs` — **2 passed / 0 failed**: `/events`
  requires the bearer token; committed events stream with a durable cursor
  (a reconnecting window resumes where it stopped).
- `crates/miao-engine/tests/http_leases.rs` — **5 passed / 0 failed**:
  multi-window attach leases, unauthenticated clients cannot keep an idle
  engine alive, running work outlives every UI lease, idle shutdown closes
  existing event streams, an unowned durable run does not pin the runtime.
- G2's record (2026-11-10) pins the plane's explicit rejections: unauthorized,
  unsupported protocol, untyped body, unknown feature — each a named code, no
  silent degradation.

## Headless run client

- `docs/experiments/2026-11-10-g7-glm-flash/` (G7 record, merged): ten real
  prompts through `miao run --format json` against glm-5.3-flash — **10/10
  cells passed**, including the interrupt-and-resume task (delivery + error
  recovery) and the contradiction task whose correct outcome is a refusal.
- `crates/miao-engine/tests/input_status.rs`, `input_cancel_cycle.rs`,
  `input_edit.rs` cover the durable-input semantics the run client drives
  (steer, cancel, edit-before-promotion).

## Approvals and questions (every interactive client)

- `crates/miao-engine/tests/approval.rs` — **13 passed / 0 failed** (1
  ignored): the approval round-trip under timeouts, denials and allowances.
- `crates/miao-engine/tests/approval_lifetime.rs` — **3 passed / 0 failed**:
  an approval cannot outlive the request it answered.
- Headless denial is pinned separately: a headless run denies precisely and
  lets the model report the refusal instead of hanging
  (`crates/miao-cli/src/cli.rs`, the `approval.requested` branch).

## Totals for this round

35 passed / 0 failed across the seven suites, plus the G7 real-model run
already merged. No suite was skipped; the one ignored approval test is a
timing-sensitive case the suite marks explicitly.

## What this record does not claim

The desktop window (Electron/Tauri shells) is the deferred APP phase — the
leases/SSE/rpc planes it consumes are covered here at the transport level. A
manual click-through of the graphical shells is not part of this record.
