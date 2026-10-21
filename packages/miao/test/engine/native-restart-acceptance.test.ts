import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// P0-6 product acceptance: restarting the server keeps one durable native
// transcript and never replays a settled turn. The provider counts requests,
// so a replayed prompt or duplicated admission is visible even when the
// transcript itself looks fine.
test.skipIf(!binary)(
  "restarting the server preserves a native transcript without replay",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const bodies: { messages?: { role: string; content: unknown }[] }[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json())
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `answer ${bodies.length}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const env = {
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
    }
    const sessionID = "ses_restart_acceptance"
    const start = async () => {
      const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: path.join(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = new Response(child.stderr).text()
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ""
      while (!output.match(/miao server listening on (http:\/\/[^\s]+)/)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`server exited before listening: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
      }
      return { child, stderr, url: output.match(/miao server listening on (http:\/\/[^\s]+)/)![1]! }
    }
    const headers = {
      "x-opencode-directory": directory,
      "content-type": "application/json",
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const prompt = (url: string, id: string, text: string) =>
      fetch(url + `/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id, prompt: { text } }),
      })
    const answers = async (url: string) => {
      const listed = await fetch(url + `/api/session/${sessionID}/message`, { headers })
      const body = (await listed.json()) as { data?: { type: string; content?: { text?: string }[] }[] }
      return (body.data ?? [])
        .filter((message) => message.type === "assistant")
        .map((message) => (message.content ?? []).map((part) => part.text ?? "").join(""))
    }
    const wait = async (check: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (await check()) return
        await Bun.sleep(100)
      }
      throw new Error(`timed out waiting for ${label}`)
    }

    const first = await start()
    try {
      const created = await fetch(first.url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: sessionID, location: { directory } }),
      })
      expect(created.status).toBe(200)
      expect((await prompt(first.url, "msg_restart_1", "first turn")).status).toBe(200)
      await wait(async () => (await answers(first.url)).length === 1 && bodies.length === 1, "turn one")
      expect(await answers(first.url)).toEqual(["answer 1"])
    } finally {
      first.child.kill()
      await first.child.exited
      await first.stderr
    }

    const second = await start()
    try {
      expect((await prompt(second.url, "msg_restart_2", "second turn")).status).toBe(200)
      await wait(async () => (await answers(second.url)).length === 2 && bodies.length === 2, "turn two")
      // Restart adopted the durable transcript: turn one is still unique and the
      // second provider request carries the first answer as history, not as work
      // that was replayed after the restart.
      expect((await answers(second.url)).sort()).toEqual(["answer 1", "answer 2"])
      expect(bodies).toHaveLength(2)
      expect(JSON.stringify(bodies[1])).toContain("answer 1")
    } finally {
      second.child.kill()
      await second.child.exited
      await second.stderr
      provider.stop(true)
    }
  },
  120_000,
)
