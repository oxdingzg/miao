import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionTodo } from "@miao/core/session/todo"
import { it } from "./lib/effect"
const task = (id: string, status = "pending", depends_on?: string[]): SessionTodo.Info => ({
  id,
  content: `Task ${id}`,
  status,
  priority: "medium",
  ...(depends_on === undefined ? {} : { depends_on }),
})

describe("todo dependency graph", () => {
  it.effect("runs 7–9 while 4 waits, then unlocks 5 and 6 only after their prerequisites complete", () =>
    Effect.sync(() => {
      const todos = [
        task("1", "completed"),
        task("2", "completed"),
        task("3", "completed"),
        task("4", "waiting"),
        task("5", "pending", ["4"]),
        task("6", "pending", ["5"]),
        task("7"),
        task("8"),
        task("9"),
      ]
      expect(SessionTodo.validate(todos)).toBeUndefined()
      expect(SessionTodo.runnable(todos).map((item) => item.id)).toEqual(["7", "8", "9"])
      const after4 = todos.map((item) => (item.id === "4" ? { ...item, status: "completed" } : item))
      expect(SessionTodo.runnable(after4).map((item) => item.id)).toEqual(["5", "7", "8", "9"])
      const after5 = after4.map((item) => (item.id === "5" ? { ...item, status: "completed" } : item))
      expect(SessionTodo.runnable(after5).map((item) => item.id)).toEqual(["6", "7", "8", "9"])
    }),
  )

  it.effect("becomes idle with one waiting task and with only its not-started dependents", () =>
    Effect.sync(() => {
      expect(SessionTodo.runnable([task("4", "waiting")])).toEqual([])
      expect(
        SessionTodo.runnable([task("4", "waiting"), task("5", "pending", ["4"]), task("6", "pending", ["5"])]),
      ).toEqual([])
      expect(SessionTodo.runnable([task("4", "cancelled"), task("5", "pending", ["4"])])).toEqual([])
    }),
  )

  it.effect("rejects unknown, duplicate, and cyclic dependencies and premature execution", () =>
    Effect.sync(() => {
      expect(SessionTodo.validate([task("1"), task("1")])).toContain("Duplicate task ID")
      expect(SessionTodo.validate([task("1", "pending", ["missing"])])).toContain("Unknown dependency")
      expect(SessionTodo.validate([task("1", "pending", ["1"])])).toContain("Cyclic")
      expect(SessionTodo.validate([task("1", "pending", ["2"]), task("2", "pending", ["1"])])).toContain("Cyclic")
      expect(SessionTodo.validate([task("1"), task("2", "in_progress", ["1"])])).toContain("cannot be in_progress")
      expect(SessionTodo.validate([task("1"), task("2", "pending", ["1", "1"])])).toContain("Duplicate dependencies")
    }),
  )

  it.effect("does not infer dependencies from legacy list order", () =>
    Effect.sync(() => {
      const todos = [
        { content: "Waiting", status: "waiting", priority: "high" },
        { content: "Independent", status: "pending", priority: "low" },
      ]
      expect(SessionTodo.validate(todos)).toBeUndefined()
      expect(SessionTodo.runnable(todos)).toEqual([todos[1]])
    }),
  )
})
