import { expect, test } from "bun:test"
import { createInputLatency } from "../src/context/input-latency"

test("input timing pairs handler receipt, state update and output submission without retaining text", () => {
  const latency = createInputLatency()
  latency.received(10)
  expect(latency.updated(17)).toBe(true)
  expect(latency.submitted(30)).toBe(true)
  const value = latency.snapshot()
  expect(value).toMatchObject({
    receipts: 1,
    updates: 1,
    submissions: 1,
    last: { receivedAt: 10, updatedAt: 17, submittedAt: 30 },
  })
  expect(value.handlerToState).toMatchObject({ count: 1, maxMs: 7 })
  expect(value.handlerToOutput).toMatchObject({ count: 1, maxMs: 20 })
  expect(latency.snapshot().handlerToOutput).toMatchObject({ count: 0, meanMs: null, maxMs: null })
})

test("coalesced edits measure the oldest edited input in the submitted frame", () => {
  const latency = createInputLatency()
  latency.received(10)
  latency.updated(12)
  latency.received(15)
  latency.updated(18)
  latency.submitted(25)
  expect(latency.snapshot()).toMatchObject({
    receipts: 2,
    updates: 2,
    submissions: 1,
    coalesced: 1,
    handlerToOutput: { count: 1, maxMs: 15 },
  })
})

test("a receipt without an edit is not reported as a displayed input", () => {
  const latency = createInputLatency()
  latency.received(10)
  expect(latency.submitted(15)).toBe(false)
  latency.received(20)
  latency.updated(25)
  latency.submitted(30)
  expect(latency.snapshot().handlerToOutput).toMatchObject({ count: 1, maxMs: 10 })
})
