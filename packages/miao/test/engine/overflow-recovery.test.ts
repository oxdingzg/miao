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

// The Session-state refusal is the one the engine actually emits today, so the
// recovery must keep matching its exact wording.
test("the engine still emits the Session-state overflow the recovery matches", async () => {
  const source = await Bun.file(new URL("../../../../crates/miao-engine/src/runtime.rs", import.meta.url)).text()
  expect(source.includes('"selected input including Session state exceeds budget"')).toBe(true)
})
