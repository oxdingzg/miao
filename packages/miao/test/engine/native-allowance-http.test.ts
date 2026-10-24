import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary).each([undefined, 2])(
  "native tasks pass 25 tool turns by default and honor explicit agent steps (%s)",
  async (steps) => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        Bun.write(path.join(directory, `node-${index + 1}`), `evidence ${index + 1}`),
      ),
    )
    const state = { calls: 0 }
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json()
        if (body.tools?.length) state.calls++
        const tools = body.tools?.length && state.calls <= 26
        const delta = tools
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `read-${state.calls}`,
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: `node-${state.calls}` }),
                  },
                },
              ],
            }
          : { content: "completed-long-native-task" }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_POLICY: "",
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        OPENAI_API_KEY: "fixture-only",
        MIAO_PURE: "1",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/fixture",
          ...(steps === undefined ? {} : { agents: { build: { steps } } }),
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
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      const reader = child.stdout.getReader()
      const startup = { text: "", url: "" }
      while (!startup.url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`native server stopped: ${await stderr}`)
        startup.text += new TextDecoder().decode(chunk.value)
        startup.url = startup.text.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory,
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const sid = `ses_allowance_${crypto.randomUUID()}`
      const create = await fetch(startup.url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: sid, location: { directory } }),
      })
      expect(create.status).toBe(200)
      expect(
        (
          await fetch(startup.url + `/api/session/${sid}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: `msg_${sid}`, prompt: { text: "read the nodes" } }),
          })
        ).status,
      ).toBe(200)
      const deadline = Date.now() + 40_000
      const projection = { messages: [] as Array<{ type: string; text?: string; metadata?: Record<string, unknown> }> }
      while (Date.now() < deadline) {
        const response = await fetch(startup.url + `/api/session/${sid}/message`, { headers })
        projection.messages = (await response.json()).data
        const text = JSON.stringify(projection.messages)
        if (text.includes(steps === undefined ? "completed-long-native-task" : "notificationPause")) break
        await Bun.sleep(50)
      }
      expect(state.calls).toBe(steps ?? 27)
      if (steps === undefined) {
        expect(JSON.stringify(projection.messages)).toContain("completed-long-native-task")
        expect(projection.messages.some((message) => message.metadata?.notificationPause)).toBe(false)
      } else {
        expect(projection.messages.find((message) => message.metadata?.notificationPause)).toMatchObject({
          type: "synthetic",
          text: expect.stringContaining("provider turn allowance"),
        })
        // The warning must survive a fresh transcript replay, not only SSE delivery.
        const replay = await (await fetch(startup.url + `/api/session/${sid}/message`, { headers })).json()
        expect(replay.data).toEqual(projection.messages)
      }
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  },
  65_000,
)
