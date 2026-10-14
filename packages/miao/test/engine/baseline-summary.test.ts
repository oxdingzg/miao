import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const cli = path.join(import.meta.dir, "..", "..", "src", "engine", "baseline-summary-cli.ts")

function entry(outcome: string, elapsedMs: number, input: number, output: number, tools: number) {
  return {
    sample: { outcome },
    evidence: {
      engine: "rust",
      revision: "a".repeat(40),
      task: "large-file",
      repetition: 0,
      terminal: "completed",
      error: null,
      receipts: ["tool.error"],
      attempts: [
        { inputTokens: input, outputTokens: output, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, cost: null },
      ],
      phases: [],
      profile: null,
      profileReceipts: 1,
      loops: { continuations: ["empty-completion"], stopped: [] },
      toolCalls: tools,
      textHash: "b".repeat(64),
      binarySha256: null,
      startedAtMs: 0,
      admissionMs: 0,
      elapsedMs,
    },
  }
}

test("summarizes a sweep into one row per engine and task", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "rust-large-file-0.json"), JSON.stringify(entry("passed", 2000, 100, 10, 5)))
  await Bun.write(path.join(tmp.path, "rust-large-file-1.json"), JSON.stringify(entry("failed", 4000, 300, 30, 7)))
  const child = Bun.spawn(["bun", cli, tmp.path], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  const row = stdout.split("\n").find((line) => line.startsWith("| rust | large-file |"))
  expect(row).toBe(
    "| rust | large-file | 1/2 | 2000 ms | 1.0 | 400 | 40 | 6.0 | tool.error | empty-completion |",
  )
})