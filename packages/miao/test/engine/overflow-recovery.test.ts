import { expect, test } from "bun:test"
import { overflows } from "@/engine/native-engine"

// The engine refuses an oversized request before the provider sees it, and the
// host is the only place that can close the turn and compact. A refusal the
// host does not recognise is terminal for that Session: retrying and switching
// models both send the same request again.
test("both overflow refusals reach the compaction recovery", () => {
  expect(overflows(new Error("invalid request: selected history exceeds budget"))).toBe(true)
  expect(overflows(new Error("invalid request: selected input including Session state exceeds budget"))).toBe(
    true,
  )
  expect(overflows(new Error("invalid request: input conflict"))).toBe(false)
  expect(overflows("selected history exceeds budget")).toBe(false)
})

// The endpoint's own refusal is the only overflow signal an engine without a
// configured context window ever produces. A Session that reaches it replayed
// the same 1.14M-token request on every continue because the host did not
// recognise the wording, so the provider's message must reach the same recovery.
test("the endpoint's own context refusal reaches the compaction recovery", () => {
  expect(
    overflows(
      new Error(
        "invalid request: provider HTTP 400: Upstream request failed: [invalid_request_error] This model's maximum context length is 1048576 tokens. However, you requested 1140636 tokens (1140636 in the messages, 0 in the completion). Please reduce the length of the messages or completion. (request_id: a20ae8ae-d33f-46c3-b1dc-fa95e34d9470)",
      ),
    ),
  ).toBe(true)
  expect(overflows(new Error("invalid request: context overflow: the request no longer fits"))).toBe(true)
  // Rate limits and quota refusals share the transport but not the remedy.
  expect(overflows(new Error("invalid request: provider HTTP 429: rate limit exceeded"))).toBe(false)
  expect(overflows(new Error("invalid request: provider HTTP 400: malformed tool schema"))).toBe(false)
})

// The engine no longer refuses an oversized input over its Session-state note:
// it sends the turn without the note. The host keeps matching the old refusal
// because the engine is installed separately, so a newer product can still be
// talking to one that emits it, and an unrecognised overflow is terminal.
test("the engine drops the state note instead of refusing the turn", async () => {
  const source = await Bun.file(new URL("../../../../crates/miao-engine/src/runtime.rs", import.meta.url)).text()
  expect(source.includes('"status":"skipped","reason":"input_budget"')).toBe(true)
  expect(source.includes("selected input including Session state exceeds budget")).toBe(false)
})
