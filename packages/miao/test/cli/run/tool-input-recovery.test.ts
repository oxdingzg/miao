import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"

describe("invalid tool arguments", () => {
  cliIt.serial(
    "corrects malformed arguments without repeating a completed file write",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", { command: "printf once >> marker" }))
        yield* llm.push(reply().pendingTool("bash", { command: "printf fixed > corrected" }).toolCalls())
        yield* llm.push(reply().tool("bash", { command: "printf fixed > corrected" }))
        yield* llm.text("RECOVERED")
        const result = yield* opencode.run("Perform the operations", {
          extraArgs: ["--dangerously-skip-permissions", "--title", "Input recovery"],
        })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("RECOVERED")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "marker")).text())).toBe("once")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "corrected")).text())).toBe("fixed")
        expect(yield* llm.calls).toBe(4)
      }),
    60_000,
  )

  cliIt.serial(
    "ends after two corrections when the provider keeps returning malformed arguments",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().pendingTool("bash", { command: "echo never" }).toolCalls())
        yield* llm.push(reply().pendingTool("bash", { command: "echo never" }).toolCalls())
        yield* llm.push(reply().pendingTool("bash", { command: "echo never" }).toolCalls())
        const result = yield* opencode.run("Bound corrections", {
          extraArgs: ["--dangerously-skip-permissions", "--title", "Input recovery"],
        })
        expect(result.exitCode).not.toBe(0)
        expect(yield* llm.calls).toBe(3)
      }),
    60_000,
  )
})
