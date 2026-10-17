import { expect, test } from "bun:test"
import path from "node:path"
import { EngineHttpClient } from "@/engine/http-client"
import { EngineSession } from "@/engine/session"
import { tmpdir } from "../fixture/fixture"

for (const url of [
  "https://127.0.0.1:1000/",
  "http://example.com:1000/",
  "http://127.0.0.1:1000/rpc",
  "http://user:password@127.0.0.1:1000/",
])
  test(`native HTTP refuses authority ${url}`, () => {
    expect(() => new EngineHttpClient({ url, token: "fixture" })).toThrow("loopback origin")
  })

test("a closed HTTP attachment rejects new requests", async () => {
  const client = new EngineHttpClient({ url: "http://127.0.0.1:1000/", token: "fixture" })
  await client.close()
  await expect(client.request("sessions")).rejects.toMatchObject({ code: "engine_closed" })
})

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "two native HTTP attachments share events and survive one window closing",
  async () => {
    await using tmp = await tmpdir()
    const requests: unknown[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        requests.push(await request.json())
        return new Response(
          [
            { choices: [{ index: 0, delta: { content: "HTTP_ENGINE_OK" } }] },
            {
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 2, completion_tokens: 1 },
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn(
      [
        binary!,
        "serve",
        "--db",
        path.join(tmp.path, "engine.db"),
        "--workspace",
        tmp.path,
        "--provider",
        "openai-chat",
        "--model",
        "fixture",
        "--endpoint",
        provider.url.href + "chat/completions",
        "--http",
        "127.0.0.1:0",
        "--http-token",
        "fixture-token",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENAI_API_KEY: "fixture-only" } },
    )
    const timer = setTimeout(() => child.kill(), 15_000)
    const reader = child.stderr.getReader()
    let first: EngineHttpClient | undefined
    let second: EngineHttpClient | undefined
    try {
      let stderr = ""
      let address = ""
      const decoder = new TextDecoder()
      while (!address) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`native HTTP engine exited: ${stderr}`)
        stderr += decoder.decode(chunk.value, { stream: true })
        address = stderr.match(/http listening on (127\.0\.0\.1:\d+)/)?.[1] ?? ""
      }
      const url = `http://${address}/`
      first = new EngineHttpClient({ url, token: "fixture-token" })
      second = new EngineHttpClient({ url, token: "fixture-token" })
      const denied = new EngineHttpClient({ url, token: "wrong" })
      await expect(denied.request("sessions")).rejects.toMatchObject({ code: "engine_http" })
      await denied.close()
      await first.request("initialize", { session_id: "ses_http_shared", title: "shared" })
      const projected: unknown[] = []
      const session = new EngineSession(second, (event) => projected.push(event))
      const done = Promise.withResolvers<void>()
      const observed: number[] = []
      second.onEvent((event) => {
        observed.push(event.seq)
        if (event.kind === "stop") done.resolve()
      })
      await session.watch("ses_http_shared")
      await first.admit({ session_id: "ses_http_shared", input_id: "msg_http_first", prompt: "reply" })
      await done.promise
      expect(projected.some((event) => JSON.stringify(event).includes("HTTP_ENGINE_OK"))).toBe(true)
      expect(observed).toEqual([...new Set(observed)].sort((a, b) => a - b))
      expect(requests).toHaveLength(1)
      await first.close()
      const snapshot = await second.request("snapshot", { session_id: "ses_http_shared" })
      expect(snapshot).toMatchObject({ session_id: "ses_http_shared", active_run: null })
      const history = await second.request("events", { session_id: "ses_http_shared", after: 0 })
      expect(JSON.stringify(history)).toContain("HTTP_ENGINE_OK")
    } finally {
      clearTimeout(timer)
      await first?.close()
      await second?.close()
      child.kill()
      await child.exited
      reader.releaseLock()
      provider.stop(true)
    }
  },
  20_000,
)
