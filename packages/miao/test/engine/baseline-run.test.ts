import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { runBaselineRust, runBaselineTs, startInterruptionProxy } from "@/engine/baseline-run"
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

async function run(
  root: string,
  task: string,
  steps: unknown[] | ((runRoot: string) => unknown[]),
  cancelSteps?: unknown[],
  timeoutMs = 5000,
  extras: { drifts?: Record<string, string> } = {},
) {
  const runRoot = path.join(root, `run-${task}-${Math.random().toString(36).slice(2)}`)
  const file = await script(root, typeof steps === "function" ? steps(runRoot) : steps, cancelSteps)
  return runBaselineRust({
    revision,
    binary: fake,
    root: runRoot,
    task,
    repetition: 0,
    model: "fixture-model",
    timeoutMs,
    env: { ENGINE_FAKE_SCRIPT: file },
    ...extras,
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

test("passes the interrupted-turn task when the stream broke and the artifact survived", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "stream-interruption", (runRoot) => [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 50, outputTokens: 20 } }),
    event(6, "message.committed", {
      role: "assistant",
      content: [{ type: "tool_use", id: "provider-call", name: "run_command", input: { command: "bun action.ts" } }],
    }),
    event(7, "tool.dispatched", { run_id: "run", call_id: "call", provider_id: "provider-call" }),
    event(8, "tool.completed", { call_id: "call", result: { output: "" }, is_error: false }),
    { writeFile: { path: path.join(runRoot, "workspace", "audit.log"), text: "once\n" } },
    event(9, "provider.failed", {
      run_id: "run",
      step: 1,
      message: "provider response transport failed; outcome is not replayable",
    }),
    event(10, "provider.recovery.continuation", { run_id: "run", step: 1 }),
    event(11, "provider.interrupted", { run_id: "run", step: 1, unexecuted_calls: 0 }),
    event(12, "usage", { run_id: "run", step: 1, usage: { inputTokens: 60, outputTokens: 4, partial: true } }),
    event(13, "message.committed", {
      role: "assistant",
      content: [{ type: "text", text: "the action ran once; the interrupted summary was recovered" }],
    }),
    event(14, "run.finished", { run_id: "run", reason: "completed" }),
    event(15, "stop", { run_id: "run" }),
  ])
  expect(result.rejection).toBeNull()
  expect(result.evidence.terminal).toBe("completed")
  expect(result.evidence.receipts).toEqual(["provider.interrupted"])
  expect(result.evidence.attempts).toHaveLength(2)
  expect(result.sample?.outcome).toBe("passed")
})

test("fails the interrupted-turn task without the transport interruption receipt", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "stream-interruption", (runRoot) => [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 50, outputTokens: 20 } }),
    event(6, "message.committed", {
      role: "assistant",
      content: [{ type: "tool_use", id: "provider-call", name: "run_command", input: { command: "bun action.ts" } }],
    }),
    event(7, "tool.dispatched", { run_id: "run", call_id: "call", provider_id: "provider-call" }),
    event(8, "tool.completed", { call_id: "call", result: { output: "" }, is_error: false }),
    { writeFile: { path: path.join(runRoot, "workspace", "audit.log"), text: "once\n" } },
    event(9, "message.committed", { role: "assistant", content: [{ type: "text", text: "ran once" }] }),
    event(10, "run.finished", { run_id: "run", reason: "completed" }),
    event(11, "stop", { run_id: "run" }),
  ])
  expect(result.sample?.outcome).toBe("failed")
  expect(result.assessment.artifactPass).toBe(true)
  expect(result.evidence.receipts).toEqual([])
})

test("truncates the second provider turn mid-body through the interruption proxy", async () => {
  const encoder = new TextEncoder()
  let requests = 0
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      requests += 1
      const first = requests === 1
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning"}}\n\n',
              ),
            )
            if (!first) await Bun.sleep(2_000)
            controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const proxy = await startInterruptionProxy(`http://127.0.0.1:${upstream.port}/responses`)
  const port = Number(new URL(proxy.endpoint).port)
  const call = async () => {
    const chunks: Uint8Array[] = []
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_socket, data) {
          chunks.push(new Uint8Array(data))
        },
        close() {},
        error() {},
      },
    })
    socket.write("POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}")
    await Bun.sleep(1_200)
    socket.end()
    return Buffer.concat(chunks).toString("latin1")
  }
  const first = await call()
  expect(first).toContain("response.completed")
  const second = await call()
  expect(second).toContain("output_item.done")
  expect(second).not.toContain("response.completed")
  proxy.stop()
  upstream.stop(true)
}, 15000)

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

test("rejects a run with no terminal outcome instead of inventing a verdict", async () => {
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
}, 15000)

test("writes the baseline permission policy with protected writes denied", async () => {
  await using tmp = await tmpdir()
  await run(tmp.path, "permission-denial", [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 10, outputTokens: 1 } }),
    event(6, "permission_denied", {
      run_id: "run",
      call_id: "call",
      tool: "write_file",
      resource: "protected/record.txt",
      reason: "policy",
    }),
    event(7, "run.finished", { run_id: "run", reason: "completed" }),
    event(8, "stop", { run_id: "run" }),
  ])
  const roots = (await readdir(tmp.path)).filter((name) => name.startsWith("run-permission-denial-"))
  expect(roots).toHaveLength(1)
  const policy = await Bun.file(path.join(tmp.path, roots[0], "policy.json")).json()
  expect(policy.rules).toEqual([
    { tool: "*", path: "protected/**", decision: "deny" },
    { tool: "*", path: "**", decision: "allow" },
  ])
  expect(policy.mode).toBe("workspace")
  expect(policy.allow_process).toBe(true)
})

test("continues a multi-input task on the same session for every follow-up", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "long-session", [
    ...base,
    event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 10, outputTokens: 1 } }),
    event(6, "message.committed", {
      role: "assistant",
      content: [{ type: "text", text: "LONG_SESSION_OK" }],
    }),
    event(7, "run.finished", { run_id: "run", reason: "completed" }),
    event(8, "stop", { run_id: "run" }),
  ])
  expect(result.sample).not.toBeNull()
  // One input plus four follow-ups, each replayed by the fake engine.
  expect(result.answer.match(/LONG_SESSION_OK/g)).toHaveLength(5)
  expect(result.evidence.attempts).toHaveLength(5)
})

test("injects the drift once the model's read of that path settles", async () => {
  await using tmp = await tmpdir()
  const drift = "export function add(a: number, b: number) {\n  return (a - b)\n}\n"
  await run(
    tmp.path,
    "small-edit",
    [
      ...base,
      event(4, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
      event(5, "usage", { run_id: "run", step: 0, usage: { inputTokens: 10, outputTokens: 1 } }),
      event(6, "message.committed", {
        role: "assistant",
        content: [{ type: "tool_use", id: "read-call", name: "read_file", input: { path: "src/add.ts" } }],
      }),
      event(7, "tool.dispatched", { run_id: "run", call_id: "c1", provider_id: "read-call" }),
      event(8, "tool.completed", { call_id: "c1", result: { text: "old" }, is_error: false }),
      event(9, "run.finished", { run_id: "run", reason: "completed" }),
      event(10, "stop", { run_id: "run" }),
    ],
    undefined,
    5000,
    { drifts: { "src/add.ts": drift } },
  )
  const roots = (await readdir(tmp.path)).filter((name) => name.startsWith("run-small-edit-"))
  expect(roots).toHaveLength(1)
  expect(await Bun.file(path.join(tmp.path, roots[0], "workspace", "src", "add.ts")).text()).toBe(drift)
})

test("records loop classification counts from the engine events", async () => {
  await using tmp = await tmpdir()
  const result = await run(tmp.path, "read-only", [
    ...base,
    event(4, "loop.continuation", { run_id: "run", admitted_seq: 9, reason: "empty-completion" }),
    event(5, "loop.stopped", { run_id: "run", reason: "empty-completion" }),
    event(6, "provider.request", { run_id: "run", step: 0, attempt: 1, profile: profile() }),
    event(7, "usage", { run_id: "run", step: 0, usage: { inputTokens: 10, outputTokens: 1 } }),
    event(8, "message.committed", {
      role: "assistant",
      content: [{ type: "text", text: "src/catalog.ts exports configureRelay with capacity 7" }],
    }),
    event(9, "run.finished", { run_id: "run", reason: "completed" }),
    event(10, "stop", { run_id: "run" }),
  ])
  expect(result.evidence.loops).toEqual({
    continuations: ["empty-completion"],
    stopped: ["empty-completion"],
  })
})

test("measures the TypeScript leg when the optional observations are absent", async () => {
  await using tmp = await tmpdir()
  const result = await runBaselineTs({
    revision,
    root: path.join(tmp.path, "typescript-leg"),
    task: "read-only",
    repetition: 0,
    model: "fixture-model",
    entry: path.join(import.meta.dir, "..", "fixture", "ts-run-fake.ts"),
  })
  expect(result.rejection).toBeNull()
  expect(result.sample?.outcome).toBe("passed")
  expect(result.sample?.receiptHash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.sample?.attempts).toEqual([expect.objectContaining({ inputTokens: 120, outputTokens: 12 })])
  // The TypeScript engine has no read batch and reports no provider-attempt
  // feed, so those observations stay absent rather than present and undefined:
  // the receipt hash canonicalizes this record as JSON, which has no undefined.
  expect(result.evidence.parallel).toBeUndefined()
  expect(result.evidence.context).toBeUndefined()
  expect(result.evidence.providerAttempts).toBeUndefined()
  expect(Object.keys(result.evidence)).not.toContain("parallel")
})
