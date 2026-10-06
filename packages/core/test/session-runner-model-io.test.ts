import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { SessionRunnerModelIo } from "@miao/core/session/runner/model-io"

const turn = {
  sessionID: "ses_model_io_test",
  model: { providerID: "zhipu", id: "glm-5.3" },
  request: { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], http: { headers: { Authorization: "Bearer secret" } } },
  events: [{ type: "text-delta", delta: "hello" }],
  settlement: { finish: "stop", cost: 0.01, tokens: { input: 1, output: 2 } },
  failed: false,
  durationMs: 120,
  ttftMs: 40,
} as const

describe("SessionRunnerModelIo", () => {
  it("is disabled unless MIAO_MODEL_IO is set", () => {
    delete process.env.MIAO_MODEL_IO
    expect(SessionRunnerModelIo.collector()).toBeUndefined()
  })

  it("writes one JSON line per turn with credentials stripped", async () => {
    process.env.MIAO_MODEL_IO = "1"
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "model-io-")), "data")
    await Effect.runPromise(SessionRunnerModelIo.write(dir)(turn))
    const lines = (await fs.readFile(path.join(dir, `model-io-${turn.sessionID}.jsonl`), "utf8")).trim().split("\n")
    expect(lines).toHaveLength(1)
    const line = JSON.parse(lines[0])
    expect(line).toMatchObject({ type: "turn", sessionID: turn.sessionID, failed: false, ttftMs: 40 })
    expect(line.request.http).toBeUndefined()
    expect(line.request.messages).toEqual([{ role: "user", content: "hi" }])
    expect(line.events).toEqual([{ type: "text-delta", delta: "hello" }])
    expect(line.settlement).toMatchObject({ finish: "stop", cost: 0.01 })
    delete process.env.MIAO_MODEL_IO
  })

  it("never fails the turn, even when the payload cannot serialize", async () => {
    process.env.MIAO_MODEL_IO = "1"
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "model-io-")), "data")
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await Effect.runPromise(
      SessionRunnerModelIo.write(dir)({ ...turn, request: circular, settlement: undefined, failed: true }),
    )
    await expect(fs.readFile(path.join(dir, `model-io-${turn.sessionID}.jsonl`), "utf8")).rejects.toThrow()
    delete process.env.MIAO_MODEL_IO
  })
})
