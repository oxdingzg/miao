import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// The step accounting row of the product acceptance matrix: a real client
// subscribes to `/api/event` before prompting, and the native engine's billed
// turn reaches it as `session.next.step.ended` carrying the provider usage —
// then `session.get` reports the same turn through the lifetime projection.
if (!binary) test.skip("native stream settles the billed turn as session.next.step.ended", () => {})
if (binary)
  test("native stream settles the billed turn as session.next.step.ended", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        const chunks = [
          { id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "streamed-native-reply" }, finish_reason: null }] },
          {
            id: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 321, completion_tokens: 42, total_tokens: 363 },
          },
        ]
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary!,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture/fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        OPENAI_API_KEY: "fixture-only",
        MIAO_PURE: "1",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_TEST_HOME: path.join(tmp.path, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/fixture",
          providers: {
            fixture: {
              name: "Fixture",
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: "http://127.0.0.1:1",
                settings: { apiKey: "fixture-only" },
              },
              models: { fixture: { name: "Fixture" } },
            },
          },
          formatter: false,
          lsp: false,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      let output = ""
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
      let url = ""
      while (!url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`native HTTP server exited: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
        url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const body = { id: "ses_http_native_step", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      expect(create.status).toBe(200)

      // Subscribe before prompting, like a real client: no replayed history,
      // only live settlement.
      const stream = await fetch(url + "/api/event", { headers })
      expect(stream.headers.get("content-type")).toContain("text/event-stream")
      const settlements: { finish?: string; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }[] = []
      const pump = (async () => {
        const reader = stream.body!.getReader()
        let buffer = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value)
          for (const frame of buffer.split("\n\n").slice(0, -1)) {
            const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "))
            if (!line) continue
            const event = JSON.parse(line.slice(6)) as {
              type?: string
              data?: { sessionID?: string; finish?: string; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }
            }
            if (event.type === "session.next.step.ended" && event.data?.sessionID === body.id)
              settlements.push(event.data)
          }
          buffer = buffer.split("\n\n").at(-1)!
        }
      })()

      const prompt = await fetch(url + "/api/session/" + body.id + "/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_native_step", prompt: { text: "reply once" } }),
      })
      expect(prompt.status).toBe(200)

      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && settlements.length === 0) await Bun.sleep(50)
      expect(settlements.length).toBeGreaterThan(0)
      expect(settlements[0].finish).toBe("stop")
      // The provider-reported usage rides the settlement, not a zero.
      expect(settlements[0].tokens).toEqual({ input: 321, output: 42, reasoning: 0, cache: { read: 0, write: 0 } })

      const info = await fetch(url + "/api/session/" + body.id, { headers })
      expect(info.status).toBe(200)
      const projected = (await info.json()).data
      expect(projected.usage).toBeDefined()
      expect(projected.usage.models[0]).toMatchObject({ providerID: "fixture", id: "fixture", turns: 1 })
      expect(projected.usage.models[0].tokens).toEqual({
        input: 321,
        output: 42,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
      expect(projected.tokens).toEqual({
        input: 321,
        output: 42,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
      reader?.cancel().catch(() => {})
      await pump.catch(() => {})
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  }, 40_000)
