import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const cli = path.join(import.meta.dir, "..", "..", "src", "engine", "baseline-summary-cli.ts")

function entry(outcome: string, elapsedMs: number, input: number | null, output: number | null, tools: number) {
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
        {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          cost: null,
        },
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
    "| rust | large-file | 1/2 | 1 | 0 | 2000 ms | 1.0 | 400 | 40 | unknown | unknown | 6000 | 6.0 | tool.error | empty-completion |",
  )
})

test("unknown usage and rejected evidence remain visible in the summary", async () => {
  await using tmp = await tmpdir()
  const passed = entry("passed", 1000, 100, 10, 2)
  const failed = entry("failed", 2000, null, 5, 1)
  await Bun.write(path.join(tmp.path, "passed.json"), JSON.stringify(passed))
  await Bun.write(path.join(tmp.path, "failed.json"), JSON.stringify(failed))
  const child = Bun.spawn(["bun", cli, tmp.path], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(stdout).toContain(
    "| rust | large-file | 1/2 | 1 | 0 | 1000 ms | 1.0 | unknown | 15 | unknown | unknown | 3000 |",
  )

  await Bun.write(
    path.join(tmp.path, "rejected.json"),
    JSON.stringify({
      sample: null,
      evidence: { ...passed.evidence, elapsedMs: 3000, attempts: [] },
    }),
  )
  const rejected = Bun.spawn(["bun", cli, tmp.path], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(rejected.stdout).text()
  expect(await rejected.exited).toBe(0)
  expect(output).toContain(
    "| rust | large-file | 1/3 | 1 | 1 | 2000 ms | 0.7 | unknown | unknown | unknown | unknown | 6000 |",
  )
})

test("CLI charges failures to verified completions and preserves small measured costs", async () => {
  await using tmp = await tmpdir()
  for (const [index, outcome] of ["passed", "failed"].entries()) {
    const run = entry(outcome, 1000, 10, 5, 0)
    await Bun.write(
      path.join(tmp.path, `${index}.json`),
      JSON.stringify({
        ...run,
        evidence: {
          ...run.evidence,
          attempts: [{ ...run.evidence.attempts[0], cost: 0.000001 }],
        },
      }),
    )
  }
  const child = Bun.spawn(["bun", cli, tmp.path], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(stdout).toContain("| 20 | 10 | 0.000002 | 0.000002 | 2000 |")
})
