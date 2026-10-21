import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// An explicit provider/endpoint engine exposes one primary route with no route
// id. Server-owned native Sessions must bind that primary by identity; before
// the fallback in ProductAgent.modelRoute every prompt failed admission with
// "Model is not in the native host route catalog", while the CLI path worked.
test.skipIf(!binary)(
  "a server-owned native Session runs on an explicit engine route",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const bodies: unknown[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json())
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "explicit route answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    const timer = setTimeout(() => child.kill(), 90_000)
    try {
      while (!output.match(/miao server listening on (http:\/\/[^\s]+)/)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`server exited before listening: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
      }
      const url = output.match(/miao server listening on (http:\/\/[^\s]+)/)![1]!
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const created = await fetch(url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "ses_explicit_route", location: { directory } }),
      })
      expect(created.status).toBe(200)
      const prompted = await fetch(url + "/api/session/ses_explicit_route/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_explicit_route", prompt: { text: "run on the explicit route" } }),
      })
      expect(prompted.status).toBe(200)
      const deadline = Date.now() + 30_000
      let reply = ""
      while (Date.now() < deadline && !reply) {
        const listed = await fetch(url + "/api/session/ses_explicit_route/message", { headers })
        const body = (await listed.json()) as { data?: { type: string; content?: { type: string; text?: string }[] }[] }
        reply =
          body.data
            ?.find((message) => message.type === "assistant")
            ?.content?.map((part) => part.text ?? "")
            .join("") ?? ""
        if (!reply) await Bun.sleep(100)
      }
      expect(reply).toContain("explicit route answer")
      expect(bodies).toHaveLength(1)
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  },
  120_000,
)
