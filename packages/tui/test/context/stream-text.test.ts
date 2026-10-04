import { expect, test } from "bun:test"
import { createStreamText } from "../../src/context/stream-text"

test("queued fragments catch up to an ahead snapshot without repeating it", () => {
  const stream = createStreamText()
  stream.start("session", "message", "part")
  let current = "你好Swissquote"
  for (const delta of ["你", "好", "Swiss", "quote"])
    current = stream.append("session", "message", "part", delta, current)!
  expect(current).toBe("你好Swissquote")
  expect(stream.append("session", "message", "part", "quote", current)).toBe("你好Swissquotequote")
})

test("fragments received before projection survive a behind snapshot", () => {
  const stream = createStreamText()
  stream.start("session", "message", "part")
  expect(stream.append("session", "message", "part", "你")).toBeUndefined()
  expect(stream.append("session", "message", "part", "好")).toBeUndefined()
  expect(stream.reconcile("session", "message", "part", "你")).toBe("你好")
  expect(stream.append("session", "message", "part", "🙂", "你好")).toBe("你好🙂")
})

test("a repeated start does not reset received text and real repeated words remain", () => {
  const stream = createStreamText()
  stream.start("session", "message", "part")
  expect(stream.append("session", "message", "part", "哈", "")).toBe("哈")
  stream.start("session", "message", "part")
  expect(stream.append("session", "message", "part", "哈", "哈")).toBe("哈哈")
})

test("clients that missed the start do not guess away legitimate repetition", () => {
  const stream = createStreamText()
  expect(stream.append("session", "message", "part", "Swiss", "Swiss")).toBe("SwissSwiss")
  expect(stream.append("session", "message", "part", "missing")).toBeUndefined()
})

test("settlement and scoped cleanup release only the targeted stream", () => {
  const stream = createStreamText()
  stream.start("session", "message", "text")
  stream.start("session", "other", "reasoning")
  stream.start("other-session", "message", "text")
  stream.append("session", "message", "text", "text")
  stream.append("session", "other", "reasoning", "reasoning")
  stream.append("other-session", "message", "text", "other")
  stream.end("session", "message", "text", "final", 12)
  expect(stream.reconcile("session", "message", "text", "finalfinal")).toBe("final")
  expect(stream.completed("session", "message", "text")).toBe(12)
  expect(stream.append("session", "message", "text", "late", "final")).toBe("final")
  stream.releaseEnded("session", "message")
  expect(stream.completed("session", "message", "text")).toBeUndefined()
  stream.clear("session", "message")
  expect(stream.reconcile("session", "other", "reasoning", "")).toBe("reasoning")
  stream.clear("session")
  expect(stream.reconcile("session", "other", "reasoning", "")).toBe("")
  expect(stream.reconcile("other-session", "message", "text", "")).toBe("other")
})
