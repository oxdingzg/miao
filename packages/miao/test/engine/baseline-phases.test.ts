import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const cli = path.join(import.meta.dir, "..", "..", "src", "engine", "baseline-phases-cli.ts")

function evidence(startedAtMs: number, admissionMs: number, firstOutput: number, terminal: number, verified: number, elapsedMs: number) {
  return {
    engine: "rust",
    revision: "a".repeat(40),
    task: "read-only",
    repetition: 0,
    terminal: "completed",
    error: null,
    receipts: [],
    attempts: [{ inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, cost: null }],
    phases: [
      { phase: "input.admitted", atMs: admissionMs, clock: "observed" },
      { phase: "first-output", atMs: firstOutput, clock: "observed" },
      { phase: "run.finished", atMs: terminal, clock: "observed" },
      { phase: "verified", atMs: verified, clock: "observed" },
    ],
    profile: {
      model: "fixture-model",
      modelParametersHash: "1".repeat(64),
      agentManifestHash: "2".repeat(64),
      permissionHash: "3".repeat(64),
      toolSurfaceHash: "4".repeat(64),
    },
    profileReceipts: 1,
    toolCalls: 2,
    textHash: "5".repeat(64),
    startedAtMs,
    admissionMs,
    elapsedMs,
  }
}

test("reports phase percentiles per engine and task from sweep evidence", async () => {
  await using tmp = await tmpdir()
  await Bun.write(
    path.join(tmp.path, "rust-read-only-0.json"),
    JSON.stringify({ evidence: evidence(1000, 1100, 1500, 3000, 3100, 2200) }),
  )
  await Bun.write(
    path.join(tmp.path, "rust-read-only-1.json"),
    JSON.stringify({ evidence: evidence(1000, 1000, 1400, 2000, 2100, 1200) }),
  )
  const child = Bun.spawn(["bun", cli, tmp.path, "--json"], { stdout: "pipe", stderr: "pipe" })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  const report = JSON.parse(stdout)
  expect(report.runs).toBe(2)
  expect(report.groups).toEqual([
    {
      engine: "rust",
      task: "read-only",
      runs: 2,
      firstOutputMs: { p50: 400, p95: 400, samples: 2 },
      outputToTerminalMs: { p50: 600, p95: 1500, samples: 2 },
      terminalToVerifiedMs: { p50: 100, p95: 100, samples: 2 },
      totalMs: { p50: 1200, p95: 2200, samples: 2 },
      attempts: 1,
      toolCalls: 2,
    },
  ])
})