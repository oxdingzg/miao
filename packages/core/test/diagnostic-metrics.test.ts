import { expect, test } from "bun:test"
import { DiagnosticMetrics } from "../src/diagnostic-metrics"

test("diagnostic readers are sampled on demand and removed with their owning scope", () => {
  const reads = { count: 0 }
  const dispose = DiagnosticMetrics.register("test.reader", () => ({ count: ++reads.count }))
  expect(reads.count).toBe(0)
  expect(DiagnosticMetrics.snapshot()).toContainEqual({ name: "test.reader", value: { count: 1 } })
  dispose()
  expect(DiagnosticMetrics.snapshot().some((entry) => entry.name === "test.reader")).toBe(false)
  expect(reads.count).toBe(1)
})

test("a broken diagnostic reader does not fail a process sample", () => {
  const dispose = DiagnosticMetrics.register("test.broken", () => {
    throw new Error("unavailable")
  })
  try {
    expect(DiagnosticMetrics.snapshot()).toContainEqual({ name: "test.broken", value: null })
  } finally {
    dispose()
  }
})
