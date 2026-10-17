import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native session wait settles only once the engine's run has completed",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    // The upstream holds its answer so the engine's run stays in flight while
    // the waiter is observed; a wait that returned early would be a false idle.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let requests = 0
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        requests++
        await held
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "native-wait-answer" }, finish_reason: "stop" }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "product.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: new URL("fixture", provider.url).toString(),
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "native"),
        OPENAI_API_KEY: "fixture-only",
        MIAO_PURE: "1",
        MIAO_SERVER_PASSWORD: "",
        MIAO_SERVER_USERNAME: "",
        MIAO_TEST_HOME: tmp.path,
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    try {
      const url = await (async () => {
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("server startup timeout")), 20_000)
          })
          const result = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer))
          if (result.done) throw new Error(`server exited: ${output}`)
          output += decoder.decode(result.value)
          const match = output.match(/miao server listening on (http:\/\/\S+)/)
          if (match) return match[1]
        }
      })()
      const session = "ses_native_wait_http"
      const headers = { "content-type": "application/json", "x-opencode-directory": directory }
      const created = await fetch(`${url}/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: session, location: { directory } }),
      })
      expect(created.status).toBe(200)
      const admitted = await fetch(`${url}/api/session/${session}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_native_wait_input", prompt: { text: "native wait task" } }),
      })
      expect(admitted.status).toBe(200)
      for (let attempt = 0; attempt < 200 && requests === 0; attempt++) await Bun.sleep(20)
      expect(requests).toBe(1)
      let settled = false
      const waiting = fetch(`${url}/api/session/${session}/wait`, { method: "POST", headers }).then((response) => {
        settled = true
        return response
      })
      await Bun.sleep(500)
      expect(settled).toBe(false)
      release()
      expect((await waiting).status).toBe(204)
      // Wait returned after the engine settled the turn, so its committed
      // answer is already readable through the product projection.
      const context = await (await fetch(`${url}/api/session/${session}/context`, { headers })).json()
      expect(
        context.data.some(
          (message: { type: string; content?: { type: string; text?: string }[] }) =>
            message.type === "assistant" &&
            message.content?.some((part) => part.type === "text" && part.text === "native-wait-answer"),
        ),
      ).toBe(true)
      // A Session that already settled answers without another run.
      const again = await fetch(`${url}/api/session/${session}/wait`, { method: "POST", headers })
      expect(again.status).toBe(204)
      expect(requests).toBe(1)
    } finally {
      release()
      reader.releaseLock()
      child.kill()
      await child.exited
      provider.stop(true)
    }
  },
  30_000,
)
