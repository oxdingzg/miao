import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { EngineClient } from "@/engine/client"
import { runEnginePrompt } from "@/engine/run"

const fake = path.join(import.meta.dir, "..", "fixture", "engine-fake.ts")
const realBinary = process.env.MIAO_ENGINE_BIN
const realTest = realBinary ? test : test.skip

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "miao-engine-"))

describe("engine host client", () => {
  test("drives one prompt: subscribe, admit, events, history", async () => {
    const root = await tmp()
    try {
      const result = await runEnginePrompt({
        binary: fake,
        db: path.join(root, "engine.db"),
        workspace: root,
        model: "test",
        provider: "openai-chat",
        prompt: "hi",
      })
      expect(result.text).toBe("echo:hi")
      expect(result.events.map((event) => event.kind)).toEqual(["run.started", "message.committed", "run.finished"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("maps an engine error reply to EngineError", async () => {
    const root = await tmp()
    const client = EngineClient.start({ binary: fake, db: path.join(root, "engine.db"), workspace: root, model: "test" })
    try {
      await expect(client.request("boom", {})).rejects.toMatchObject({ code: "boom", message: "kaboom" })
    } finally {
      await client.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

realTest("runs one prompt through the real engine against a mock endpoint", async () => {
  const root = await tmp()
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/chat/completions") return new Response("not found", { status: 404 })
      const frames = [
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`,
        `data: {"choices":[{"index":0,"delta":{"content":"hello from mock"},"finish_reason":null}]}\n\n`,
        `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":3,"total_tokens":4}}\n\n`,
        `data: [DONE]\n\n`,
      ].join("")
      return new Response(frames, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    const result = await runEnginePrompt({
      binary: realBinary!,
      db: path.join(root, "engine.db"),
      workspace: root,
      model: "test-model",
      provider: "openai-chat",
      endpoint: new URL("/chat/completions", server.url).toString(),
      env: { OPENAI_API_KEY: "test-key" },
      prompt: "say hello",
      timeoutMs: 60_000,
    })
    expect(result.text).toContain("hello from mock")
    // The run is isolated in its own database; nothing points at miao's.
    expect(await fs.stat(path.join(root, "engine.db")).catch(() => null)).not.toBeNull()
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})
