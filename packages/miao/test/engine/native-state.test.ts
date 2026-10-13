import { expect, test } from "bun:test"
import { nativeExecution, nativeTodos } from "@miao/server/native-state"

const run = "67bb9f66-f1f8-44c3-8418-e0f5e8d0ed61"

test("native execution returns the engine's actual UUID, not a TS process execution", () => {
  expect(nativeExecution({ active_run: run })).toEqual({ type: "running", executionID: run })
  expect(nativeExecution({ active_run: null })).toEqual({ type: "idle" })
  expect(() => nativeExecution({ active_run: "not-a-run-id" })).toThrow()
})

test("native todo reads preserve dependency/waiting states and reject malformed ledger values", () => {
  const todos = [
    { id: "build", content: "build", status: "waiting", priority: "high" },
    { id: "verify", content: "verify", status: "pending", priority: "high", depends_on: ["build"] },
  ]
  expect(nativeTodos({ state: { todos: { revision: 3, value: { todos } } } })).toEqual(todos)
  expect(nativeTodos({ state: { todos: null } })).toEqual([])
  expect(() => nativeTodos({ state: { todos: { value: { todos: [{ content: 123 }] } } } })).toThrow()
})
