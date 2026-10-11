import { expect, test } from "bun:test"
import { createServer } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runEnginePrompt } from "@/engine/run"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

async function endpoint(responses: Array<{ body: string; broken?: boolean }>) {
  const requests: unknown[] = []
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0)
    let replied = false
    socket.on("data", (chunk) => {
      if (replied) return
      bytes = Buffer.concat([bytes, chunk])
      const boundary = bytes.indexOf("\r\n\r\n")
      if (boundary < 0) return
      const header = bytes.subarray(0, boundary).toString()
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])
      if (!Number.isFinite(length) || bytes.length < boundary + 4 + length) return
      replied = true
      requests.push(JSON.parse(bytes.subarray(boundary + 4, boundary + 4 + length).toString()))
      const response = responses.shift()
      if (!response) {
        socket.end("HTTP/1.1 500 Unexpected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
      }
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(response.body) + (response.broken ? 128 : 0)}\r\nConnection: close\r\n\r\n${response.body}`,
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture address missing")
  return {
    url: `http://127.0.0.1:${address.port}/chat/completions`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

const partial = 'data: {"choices":[{"index":0,"delta":{"content":"PARTIAL"},"finish_reason":null}]}\n\n'
const complete = [
  'data: {"choices":[{"index":0,"delta":{"content":"RECOVERED"},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
].join("")

real(
  "host driver accepts a final success while retaining an intermediate provider failure",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "miao-engine-outcome-"))
    const peer = await endpoint([{ body: partial, broken: true }, { body: complete }])
    try {
      const result = await runEnginePrompt({
        binary: binary!,
        db: path.join(root, "engine.db"),
        workspace: root,
        model: "fixture",
        provider: "openai-chat",
        endpoint: peer.url,
        env: { OPENAI_API_KEY: "fixture" },
        prompt: "answer",
        timeoutMs: 30_000,
      })
      expect(result.text).toContain("PARTIAL")
      expect(result.text).toContain("RECOVERED")
      expect(result.events.filter((event) => event.kind === "provider.failed")).toHaveLength(1)
      expect(result.events.find((event) => event.kind === "run.finished")?.data).toMatchObject({ reason: "completed" })
      expect(peer.requests).toHaveLength(2)
    } finally {
      await peer.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

real(
  "host driver still rejects terminal failure after bounded transport continuations",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "miao-engine-outcome-"))
    const peer = await endpoint(Array.from({ length: 3 }, () => ({ body: partial, broken: true })))
    try {
      await expect(
        runEnginePrompt({
          binary: binary!,
          db: path.join(root, "engine.db"),
          workspace: root,
          model: "fixture",
          provider: "openai-chat",
          endpoint: peer.url,
          env: { OPENAI_API_KEY: "fixture" },
          prompt: "answer",
          timeoutMs: 30_000,
        }),
      ).rejects.toMatchObject({ code: "provider_failed" })
      expect(peer.requests).toHaveLength(3)
    } finally {
      await peer.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

real(
  "reused sessions scope outcomes to the admitted input and exact retries do not execute again",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "miao-engine-outcome-"))
    const peer = await endpoint([{ body: partial }, { body: complete }])
    const options = {
      binary: binary!,
      db: path.join(root, "engine.db"),
      workspace: root,
      model: "fixture",
      provider: "openai-chat",
      endpoint: peer.url,
      env: { OPENAI_API_KEY: "fixture" },
      session: "same-session",
      timeoutMs: 30_000,
    }
    try {
      await expect(runEnginePrompt({ ...options, inputId: "first", prompt: "first" })).rejects.toMatchObject({
        code: "provider_failed",
      })
      const next = await runEnginePrompt({ ...options, inputId: "second", prompt: "second" })
      expect(next.text).toBe("RECOVERED")
      expect(peer.requests).toHaveLength(2)
      const retry = await runEnginePrompt({ ...options, inputId: "second", prompt: "second" })
      expect(retry.text).toBe("RECOVERED")
      expect(peer.requests).toHaveLength(2)
    } finally {
      await peer.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

real(
  "an earlier recovered provider error does not misclassify a later tool correction failure",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "miao-engine-outcome-"))
    const peer = await endpoint([
      { body: partial, broken: true },
      ...Array.from({ length: 3 }, (_, index) => ({
        body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `invalid-${index}`, type: "function", function: { name: "read_file", arguments: "{" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      })),
    ])
    try {
      await expect(
        runEnginePrompt({
          binary: binary!,
          db: path.join(root, "engine.db"),
          workspace: root,
          model: "fixture",
          provider: "openai-chat",
          endpoint: peer.url,
          env: { OPENAI_API_KEY: "fixture" },
          prompt: "answer",
          timeoutMs: 30_000,
        }),
      ).rejects.toMatchObject({ code: "engine_run_failed" })
      expect(peer.requests).toHaveLength(4)
    } finally {
      await peer.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
