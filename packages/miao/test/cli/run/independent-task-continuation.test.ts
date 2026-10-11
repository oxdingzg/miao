import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"

const waiting = { id: "4", content: "CI run 123 is still running", status: "waiting", priority: "high" }
const dependent = { id: "5", content: "Release after CI", status: "pending", priority: "high", depends_on: ["4"] }
const ready = { id: "7", content: "Write independent audit result", status: "pending", priority: "medium" }

describe("independent task continuation", () => {
  cliIt.serial(
    "continues ready work after an early stop beside a waiting job without a new human prompt",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("goal", { objective: "Finish the authorized tasks", status: "active", autonomous: true }),
        )
        yield* llm.push(reply().tool("todowrite", { todos: [waiting, dependent, ready] }))
        yield* llm.text("CI is running")
        yield* llm.push(reply().tool("bash", { command: "printf once > audit" }))
        yield* llm.push(reply().tool("todowrite", { todos: [waiting, dependent, { ...ready, status: "completed" }] }))
        yield* llm.text("Independent audit complete; waiting for CI")
        const result = yield* opencode.run("Work autonomously on independent tasks", {
          extraArgs: ["--dangerously-skip-permissions", "--title", "Independent work"],
        })
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "audit")).text())).toBe("once")
        expect(result.stdout).toContain("Independent audit complete")
        expect(yield* llm.calls).toBe(6)
      }),
    60_000,
  )

  cliIt.serial(
    "becomes idle without another model request when all authorized tasks are waiting",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("goal", { objective: "Wait for CI", status: "active", autonomous: true }))
        yield* llm.push(reply().tool("todowrite", { todos: [waiting, dependent] }))
        yield* llm.text("Waiting for the existing CI notification")
        const result = yield* opencode.run("Continue autonomously when ready", {
          extraArgs: ["--dangerously-skip-permissions", "--title", "Only waiting tasks"],
        })
        opencode.expectExit(result, 0)
        expect(yield* llm.calls).toBe(3)
      }),
    60_000,
  )
})
