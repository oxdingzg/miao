import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"

describe("tool argument budgets", () => {
  cliIt.serial(
    "stops oversized arguments before dispatch while preserving earlier completed writes",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", { command: "printf once > marker" }))
        yield* llm.push(reply().tool("bash", { command: "echo " + "x".repeat(1000) }))
        const result = yield* opencode.run("Bound input", {
          extraArgs: ["--dangerously-skip-permissions", "--title", "Input budget"],
          env: { MIAO_TOOL_INPUT_MAX_BYTES: "128" },
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Stopped unfinished tool arguments")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "marker")).text())).toBe("once")
        expect(yield* llm.calls).toBe(2)
      }),
    60_000,
  )

  cliIt.serial(
    "stops a stalled argument stream without waiting for its terminal frame",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().pendingTool("bash", { command: "echo never" }).hang())
        const result = yield* opencode.run("Bound generation time", {
          extraArgs: ["--dangerously-skip-permissions", "--title", "Input deadline"],
          env: { MIAO_TOOL_INPUT_TIMEOUT_MS: "50" },
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("exceeds 50ms")
        expect(yield* llm.calls).toBe(1)
      }),
    60_000,
  )
})
