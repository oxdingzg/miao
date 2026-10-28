import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { baselineContract } from "@/engine/baseline"
import { summarizeBaseline, type BaselineSample } from "@/engine/baseline-report"

function sample(engine: BaselineSample["engine"], task: string, repetition = 0): BaselineSample {
  const contract = baselineContract()
  const frozen = contract.tasks.find((item) => item.id === task)
  if (!frozen) throw new Error("unknown fixture")
  return {
    task,
    engine,
    repetition,
    suiteHash: contract.suiteHash,
    taskHash: frozen.taskHash,
    profile: {
      model: "fixture-model",
      modelParametersHash: "a".repeat(64),
      agentManifestHash: "b".repeat(64),
      permissionHash: "c".repeat(64),
      toolSurfaceHash: "d".repeat(64),
    },
    revision: "e".repeat(40),
    artifactHash: "f".repeat(64),
    receiptHash: "0".repeat(64),
    outcome: "passed",
    elapsedMs: 100,
    attempts: [{ inputTokens: 10, outputTokens: 5, cost: 0.1 }],
  }
}

test("all-attempt totals include failed runs and unsuccessful attempts before recovered success", () => {
  const recovered = {
    ...sample("rust", "small-edit"),
    attempts: [
      { inputTokens: 20, outputTokens: 3, cost: 0.2 },
      { inputTokens: 10, outputTokens: 5, cost: 0.1 },
    ],
  }
  const failed = { ...sample("rust", "small-edit", 1), outcome: "failed" as const, elapsedMs: 1000 }
  const report = summarizeBaseline([recovered, failed])
  expect(report.groups[1]).toMatchObject({
    runs: 2,
    passed: 1,
    failed: 1,
    attempts: 3,
    inputTokens: 40,
    outputTokens: 13,
    successfulAttemptTokens: 38,
    totalElapsedMs: 1100,
    perCompletedTask: { inputTokens: 40, outputTokens: 13, elapsedMs: 1100 },
    p50ElapsedMs: 100,
    p95ElapsedMs: 1000,
  })
  expect(report.groups[1].cost).toBeCloseTo(0.4)
  expect(report.groups[1].perCompletedTask.cost).toBeCloseTo(0.4)
  expect(report.defaultSwitchEligible).toBe(false)
})

test("missing usage stays unknown instead of lowering costs or denominators to zero", () => {
  const input = sample("rust", "tool-error")
  input.attempts.unshift({ inputTokens: null, outputTokens: null, cost: null })
  expect(summarizeBaseline([input]).groups[1]).toMatchObject({
    attempts: 2,
    inputTokens: null,
    outputTokens: null,
    cost: null,
    successfulAttemptTokens: null,
  })
  expect(summarizeBaseline([]).groups[0]).toMatchObject({
    runs: 0,
    inputTokens: null,
    p50ElapsedMs: null,
    p95ElapsedMs: null,
  })
})

test("only balanced verified full-suite pairs with matching effective profiles are comparable", () => {
  const paired = baselineContract().tasks.flatMap((task) => [sample("typescript", task.id), sample("rust", task.id)])
  expect(summarizeBaseline(paired).fullSuiteComparable).toBe(true)
  expect(summarizeBaseline(paired.slice(1)).fullSuiteComparable).toBe(false)
  expect(
    summarizeBaseline([...paired, sample("typescript", "read-only", 1), sample("rust", "read-only", 1)])
      .fullSuiteComparable,
  ).toBe(false)
  for (const key of [
    "model",
    "modelParametersHash",
    "agentManifestHash",
    "permissionHash",
    "toolSurfaceHash",
  ] as const) {
    const changed = structuredClone(paired)
    changed[1].profile[key] = key === "model" ? "other-model" : "9".repeat(64)
    expect(summarizeBaseline(changed).fullSuiteComparable).toBe(false)
  }
  const unverified = structuredClone(paired)
  unverified[1].outcome = "unverified"
  expect(summarizeBaseline(unverified).fullSuiteComparable).toBe(false)
})

test("duplicates, foreign fixtures, missing provenance, and invalid accounting cannot yield a report", () => {
  const item = sample("typescript", "read-only")
  expect(() => summarizeBaseline([item, item])).toThrow("Duplicate")
  expect(() => summarizeBaseline([{ ...item, taskHash: "1".repeat(64) }])).toThrow("contract mismatch")
  expect(() => summarizeBaseline([{ ...item, receiptHash: "" }])).toThrow("provenance")
  expect(() => summarizeBaseline([{ ...item, attempts: [] }])).toThrow("execution accounting")
  expect(() => summarizeBaseline([{ ...item, elapsedMs: Number.NaN }])).toThrow("execution accounting")
  expect(() => summarizeBaseline([{ ...item, attempts: [{ inputTokens: -1, outputTokens: 0, cost: 0 }] }])).toThrow(
    "attempt accounting",
  )
})

test("report CLI emits unknown incomplete coverage with a nonzero verdict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miao-baseline-report-"))
  try {
    const file = path.join(root, "samples.json")
    await Bun.write(file, "[]")
    const child = Bun.spawn(["bun", "src/engine/baseline-report-cli.ts", file], {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(1)
    expect(JSON.parse(output)).toMatchObject({
      fullSuiteComparable: false,
      defaultSwitchEligible: false,
      groups: [
        { runs: 0, inputTokens: null },
        { runs: 0, inputTokens: null },
      ],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("completion rates charge failed and unverified attempts to verified successes", () => {
  const report = summarizeBaseline([
    sample("rust", "read-only"),
    sample("rust", "read-only", 1),
    { ...sample("rust", "read-only", 2), outcome: "failed" },
    { ...sample("rust", "read-only", 3), outcome: "unverified", elapsedMs: 700 },
  ])
  expect(report.groups[1]).toMatchObject({
    runs: 4,
    passed: 2,
    failed: 1,
    unverified: 1,
    attempts: 4,
    totalElapsedMs: 1000,
    perCompletedTask: { inputTokens: 20, outputTokens: 10, cost: 0.2, elapsedMs: 500 },
  })
  expect(report.fullSuiteComparable).toBe(false)
  expect(report.defaultSwitchEligible).toBe(false)
})

test("unknown dimensions stay independent and zero completions have no per-completion rate", () => {
  const passed = sample("rust", "read-only")
  passed.attempts[0] = { inputTokens: null, outputTokens: 0, cost: 0 }
  expect(summarizeBaseline([passed]).groups[1].perCompletedTask).toEqual({
    inputTokens: null,
    outputTokens: 0,
    cost: 0,
    elapsedMs: 100,
  })
  const failed = { ...sample("rust", "read-only"), outcome: "failed" as const }
  expect(summarizeBaseline([failed]).groups[1]).toMatchObject({
    cost: 0.1,
    perCompletedTask: { inputTokens: null, outputTokens: null, cost: null, elapsedMs: null },
  })
  expect(summarizeBaseline([]).groups[1].perCompletedTask).toEqual({
    inputTokens: null,
    outputTokens: null,
    cost: null,
    elapsedMs: null,
  })
})
