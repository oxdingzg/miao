import { expect, test } from "bun:test"
import { backgroundTasks } from "../../src/util/background"

test("disposing a TUI cancels pending reads without reporting refresh failures", async () => {
  const abort = new AbortController()
  const reports: string[] = []
  const background = backgroundTasks(abort.signal, (label, error) => reports.push(`${label}: ${error}`))
  const pending = background(
    "refresh failed",
    () =>
      new Promise((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }),
      ),
  )
  abort.abort()
  await pending
  await background("late refresh failed", async () => {
    throw new Error("must not start after disposal")
  })
  expect(reports).toEqual([])
})

test("a live TUI reports real failures concisely, including unexpected cancellation", async () => {
  const reports: string[] = []
  const background = backgroundTasks(new AbortController().signal, (label, error) => reports.push(`${label}: ${error}`))
  await background("catalog refresh failed", async () => {
    throw Object.assign(new Error("Transport", { cause: new Error("Connection refused") }), { reason: "Transport" })
  })
  await background("integration refresh failed", () => {
    throw new DOMException("The operation was aborted.", "AbortError")
  })
  expect(reports).toEqual([
    "catalog refresh failed: Transport: Connection refused",
    "integration refresh failed: The operation was aborted.",
  ])
})
