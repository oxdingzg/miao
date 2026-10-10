import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { providerProxy } from "@/blackbox/provider"
import { runEnginePrompt } from "@/engine/run"

const real = process.env.MIAO_ENGINE_BIN
const engineTest = real ? test : test.skip
const frames = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"recorded"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
]
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miao-blackbox-http-"))
  return {
    dir,
    file: path.join(dir, "bundle.json"),
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  }
}

test("HTTP recording preserves bytes/status, excludes credentials, and replays without upstream", async () => {
  await using fixtureFile = await fixture()
  let hits = 0
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      hits++
      expect(request.headers.get("authorization")).toBe("Bearer private-provider-token")
      return new Response(frames.join(""), {
        headers: { "content-type": "text/event-stream", "set-cookie": "private-cookie" },
      })
    },
  })
  const recorder = new BlackboxTape.Recorder(fixtureFile.file, { engine: "typescript", protocol: "openai-chat" })
  const record = await providerProxy({ recorder, upstream: upstream.url.toString() })
  const body = { model: "test-model", messages: [{ role: "user", content: "hello" }], stream: true }
  const request = (url: URL) =>
    fetch(new URL("/chat/completions", url), {
      method: "POST",
      headers: { authorization: "Bearer private-provider-token" },
      body: JSON.stringify(body),
    })
  try {
    const response = await request(record.server.url)
    expect(await response.text()).toBe(frames.join(""))
    const bundle = await BlackboxTape.load(fixtureFile.file)
    expect(bundle.interactions[0].outcome).toBe("complete")
    expect(await Bun.file(fixtureFile.file).text()).not.toContain("private-provider-token")
    expect(await Bun.file(fixtureFile.file).text()).not.toContain("private-cookie")
    await upstream.stop(true)
    const replay = new BlackboxTape.Replay(bundle)
    const offline = await providerProxy({ replay })
    try {
      expect(await (await request(offline.server.url)).text()).toBe(frames.join(""))
      replay.assertConsumed()
      expect(hits).toBe(1)
      expect(offline.failures).toHaveLength(0)
    } finally {
      await offline.server.stop(true)
    }
  } finally {
    await record.server.stop(true)
    await upstream.stop(true)
  }
})

test("a mismatched provider request gets no cassette response and fails the run", async () => {
  const replay = new BlackboxTape.Replay({
    format: "miao-blackbox",
    version: 1,
    metadata: {},
    trace: [],
    interactions: [
      {
        lane: "provider",
        ordinal: 0,
        request: { method: "POST", path: "/chat/completions", body: { model: "expected" } },
        frames: [
          { elapsedMs: 0, value: { type: "head", status: 200, headers: {} } },
          { elapsedMs: 1, value: { type: "bytes", base64: Buffer.from("must-not-deliver").toString("base64") } },
        ],
        outcome: "complete",
      },
    ],
  })
  const proxy = await providerProxy({ replay })
  try {
    const response = await fetch(new URL("/chat/completions", proxy.server.url), {
      method: "POST",
      body: JSON.stringify({ model: "changed" }),
    })
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain("must-not-deliver")
    expect(proxy.failures[0]).toBeInstanceOf(BlackboxTape.Mismatch)
    expect(() => replay.assertConsumed()).toThrow("mismatch")
  } finally {
    await proxy.server.stop(true)
  }
})

test("HTTP replay reproduces a stream failure after partial output", async () => {
  const replay = new BlackboxTape.Replay({
    format: "miao-blackbox",
    version: 1,
    metadata: {},
    trace: [],
    interactions: [
      {
        lane: "provider",
        ordinal: 0,
        request: { method: "POST", path: "/chat/completions", body: {} },
        frames: [
          { elapsedMs: 0, value: { type: "head", status: 200, headers: { "content-type": "text/event-stream" } } },
          { elapsedMs: 1, value: { type: "bytes", base64: Buffer.from(frames[0]).toString("base64") } },
        ],
        outcome: "error",
        endElapsedMs: 50,
      },
    ],
  })
  const proxy = await providerProxy({ replay, timing: true })
  try {
    const response = await fetch(new URL("/chat/completions", proxy.server.url), { method: "POST", body: "{}" })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(frames[0])
    await expect(reader.read()).rejects.toThrow()
    replay.assertConsumed()
  } finally {
    await proxy.server.stop(true)
  }
})

engineTest(
  "real Rust sidecar consumes a recorded provider tape offline and detects changed input",
  async () => {
    await using fixtureFile = await fixture()
    let hits = 0
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        hits++
        return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const recorder = new BlackboxTape.Recorder(fixtureFile.file, { engine: "rust", protocol: "openai-chat" })
    const record = await providerProxy({ recorder, upstream: upstream.url.toString() })
    const options = {
      binary: real!,
      workspace: fixtureFile.dir,
      model: "test-model",
      provider: "openai-chat",
      env: { OPENAI_API_KEY: "fixture-only" },
      prompt: "hello",
      timeoutMs: 15_000,
    }
    try {
      const first = await runEnginePrompt({
        ...options,
        blackbox: recorder,
        db: path.join(fixtureFile.dir, "record.db"),
        endpoint: new URL("/chat/completions", record.server.url).toString(),
      })
      expect(first.text).toBe("recorded")
      await upstream.stop(true)
      const bundle = await BlackboxTape.load(fixtureFile.file)
      const replay = new BlackboxTape.Replay(bundle)
      const offline = await providerProxy({ replay })
      try {
        const second = await runEnginePrompt({
          ...options,
          blackbox: replay,
          db: path.join(fixtureFile.dir, "replay.db"),
          endpoint: new URL("/chat/completions", offline.server.url).toString(),
        })
        expect(second.text).toBe(first.text)
        expect(hits).toBe(1)
        expect(offline.failures).toHaveLength(0)
        replay.assertConsumed()
      } finally {
        await offline.server.stop(true)
      }
      const mismatch = await providerProxy({ replay: new BlackboxTape.Replay(bundle) })
      try {
        await expect(
          runEnginePrompt({
            ...options,
            prompt: "different",
            db: path.join(fixtureFile.dir, "mismatch.db"),
            endpoint: new URL("/chat/completions", mismatch.server.url).toString(),
          }),
        ).rejects.toThrow()
        expect(mismatch.failures[0]).toBeInstanceOf(BlackboxTape.Mismatch)
      } finally {
        await mismatch.server.stop(true)
      }
    } finally {
      await record.server.stop(true)
      await upstream.stop(true)
    }
  },
  60_000,
)
