import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runBaselineRust } from "@/engine/baseline-run"
import { baselineContract } from "@/engine/baseline"
import { tmpdir } from "../fixture/fixture"

const fake = path.join(import.meta.dir, "..", "fixture", "engine-fake.ts")
const revision = "a".repeat(40)
const hash = (char: string) => char.repeat(64)

const profile = (toolSurfaceHash = hash("4")) => ({
  coverage: "runtime-and-wire",
  model: "fixture-model",
  modelParametersHash: hash("1"),
  agentManifestHash: hash("2"),
  permissionHash: hash("3"),
  toolSurfaceHash,
})

const event = (seq: number, kind: string, data: unknown) => ({
  event: { session_id: "$SESSION", seq, kind, data },
})

const base = [
  event(1, "input.admitted", { input_id: "$INPUT_ID", delivery: "steer" }),
  event(2, "input.promoted", { input_id: "$INPUT_ID", prompt: "$PROMPT", checkpoint: "checkpoint" }),
  event(3, "run.started", { run_id: "run" }),
]

async function script(root: string, steps: unknown[], cancelSteps?: unknown[]) {
  const file = path.join(root, "script.json")
  await Bun.write(file, JSON.stringify({ steps, cancelSteps }))
  return file
}

async function run(root: string, task: string, steps: unknown[], cancelSteps?: unknown[], timeoutMs = 5000) {
  const file = await script(root, steps, cancelSteps)
  return runBaselineRust({
    revision,
    binary: fake,
    root: path.join(root, `run-${task}-${Math.random().toString(36).slice(2)}`),
    task,
    repetition: 0,
    model: "fixture-model",
    timeoutMs,
    env: { ENGINE_FAKE_SCRIPT: file },
  })
}

test("produces a passing sample with attempt usage, profile, and receipts from scripted events", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "read-only", [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(5, "usage", {
      run_id: "run",
      step: 0,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 10,
        reasoningTokens: 7,
      },
    }),
    event(6, "message.committed", {
      role: "assistant",
      content: [{ type: "text", text: "src/catalog.ts exports configureRelay with capacity 7" }],
    }),
    event(7, "run.finished", { run_id: "run", reason: "completed" }),
    event(8, "stop", { run_id: "run" }),
  ])
  expect(result.rejection).toBeNull()
  expect(result.sample).toMatchObject({
    task: "read-only",
    engine: "rust",
    repetition: 0,
    suiteHash: baselineContract().suiteHash,
    outcome: "passed",
    revision,
    attempts: [{ inputTokens: 120, outputTokens: 30, cost: null }],
  })
  expect(result.sample!.profile.model).toBe("fixture-model")
  expect(result.evidence.attempts[0]).toMatchObject({
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    reasoningTokens: 7,
  })
  expect(result.evidence.receipts).toEqual([])
  expect(result.evidence.terminal).toBe("completed")
  expect(result.evidence.phases.some((phase) => phase.phase === "run.finished")).toBe(true)
  expect(result.evidence.elapsedMs).toBeGreaterThanOrEqual(0)
})

test("records a tool error receipt and the recovered answer", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "tool-error", [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 40, outputTokens: 9 } }),
    event(6, "tool.completed", { call_id: "call", result: { error: "missing.txt" }, is_error: true }),
    event(7, "message.committed", {
      role: "assistant",
      content: [{ type: "text", text: "recovered via alternate.txt: RECOVERY_TOKEN_83" }],
    }),
    event(8, "run.finished", { run_id: "run", reason: "completed" }),
    event(9, "stop", { run_id: "run" }),
  ])
  expect(result.sample?.outcome).toBe("passed")
  expect(result.evidence.receipts).toEqual(["tool.error"])
  expect(result.assessment.artifactPass).toBe(true)
})

test("requires a durable permission denial instead of an unchanged file", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "permission-denial", [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 30, outputTokens: 12 } }),
    event(6, "permission_denied", {
      run_id: "run",
      call_id: "call",
      tool: "write_file",
      resource: "protected/record.txt",
      reason: "policy",
    }),
    event(7, "message.committed", {
      role: "assistant",
      content: [{ type: "text", text: "the write was denied by policy and the file is preserved" }],
    }),
    event(8, "run.finished", { run_id: "run", reason: "completed" }),
    event(9, "stop", { run_id: "run" }),
  ])
  expect(result.sample?.outcome).toBe("passed")
  expect(result.evidence.receipts).toEqual(["permission.denied"])
})

test("interrupts the action turn only on host cancellation and keeps the interrupted evidence", async () => {
  await using tmp = await tmpdir()
  const result = await run(
    tmp.path,
    "stream-interruption",
    [
      ...base,
      event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
      event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 50, outputTokens: 20 } }),
      event(6, "message.committed", {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "provider-call",
            name: "run_command",
            input: { command: "bun action.ts" },
          },
        ],
      }),
      event(7, "tool.dispatched", { run_id: "run", call_id: "call", provider_id: "provider-call" }),
      event(8, "tool.completed", { call_id: "call", result: { output: "" }, is_error: false }),
      { progress: { session_id: "$SESSION", run_id: "run", kind: "provider.delta", data: { kind: "text.delta", text: "o" } } },
    ],
    [
      event(9, "provider.interrupted", { run_id: "run", step: 1, unexecuted_calls: [] }),
      event(10, "usage", { run_id: "run", step: 1, usage: { inputTokens: 60, outputTokens: 4, partial: true } }),
      event(11, "run.finished", { run_id: "run", reason: "interrupted" }),
      event(12, "stop", { run_id: "run" }),
    ],
  )
  expect(result.evidence.terminal).toBe("interrupted")
  expect(result.evidence.receipts).toEqual(["provider.interrupted"])
  expect(result.evidence.attempts).toHaveLength(2)
  expect(result.sample?.outcome).toBe("failed")
})

test("rejects samples whose provider receipts disagree on the effective profile", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "read-only", [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile(hash("4")) }),
    event(5, "provider.request", { run_id: "run", step: 0, attempt: 2, profile: profile(hash("5")) }),
    event(6, "usage", { run_id: "run", step: 0, usage: { inputTokens: 10, outputTokens: 1 } }),
    event(7, "run.finished", { run_id: "run", reason: "completed" }),
    event(8, "stop", { run_id: "run" }),
  ])
  expect(result.sample).toBeNull()
  expect(result.rejection).toBe("missing effective profile fingerprint from provider receipts")
})

test(
  "rejects a run with no terminal outcome instead of inventing a verdict",
  async () => {
    await using tmp = await tmpdir()
    const result = await run(
      tmp.path,
      "read-only",
      [
        ...base,
        event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
        event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 10, outputTokens: 1 } }),
        { delayMs: 4000 },
      ],
      undefined,
      600,
    )
    expect(result.sample).toBeNull()
    expect(result.rejection).toContain("no terminal outcome")
  },
  15000,
)