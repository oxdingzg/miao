import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native context/history hydrate without TS message writes and keep pagination IDs stable",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    let calls = 0
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "native-history-answer" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const database = path.join(tmp.path, "product.db")
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: database,
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: new URL("fixture", provider.url).toString(),
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
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "native"),
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
      const session = "ses_native_history_http"
      const headers = { "content-type": "application/json", "x-opencode-directory": directory }
      const created = await fetch(`${url}/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: session, location: { directory } }),
      })
      expect(created.status).toBe(200)
      const input = { id: "msg_native_history_input", prompt: { text: "native history task" } }
      const admitted = await fetch(`${url}/api/session/${session}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, resume: false }),
      })
      expect(admitted.status).toBe(200)
      expect((await (await fetch(`${url}/api/session/${session}/context`, { headers })).json()).data).toEqual([])
      const resumed = await fetch(`${url}/api/session/${session}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, resume: true }),
      })
      expect(resumed.status).toBe(200)
      let context: {
        id: string
        type: string
        text?: string
        content?: { type: string; text?: string }[]
        tokens?: { input: number; output: number }
      }[] = []
      for (let attempt = 0; attempt < 200; attempt++) {
        const response = await fetch(`${url}/api/session/${session}/context`, { headers })
        expect(response.status).toBe(200)
        context = (await response.json()).data
        if (context.some((message) => message.type === "assistant" && message.tokens?.output === 5)) break
        await Bun.sleep(20)
      }
      expect(context.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(context[0].id).toBe(input.id)
      expect(context[0].text).toBe(input.prompt.text)
      expect(context[1].content?.some((part) => part.type === "text" && part.text === "native-history-answer")).toBe(
        true,
      )
      expect(context[1].tokens).toMatchObject({ input: 10, output: 5 })
      const first = await (await fetch(`${url}/api/session/${session}/message?limit=1&order=asc`, { headers })).json()
      expect(first.data.map((message: { id: string }) => message.id)).toEqual([context[0].id])
      const second = await (
        await fetch(`${url}/api/session/${session}/message?limit=1&cursor=${encodeURIComponent(first.cursor.next)}`, {
          headers,
        })
      ).json()
      expect(second.data.map((message: { id: string }) => message.id)).toEqual([context[1].id])
      const previous = await (
        await fetch(
          `${url}/api/session/${session}/message?limit=1&cursor=${encodeURIComponent(second.cursor.previous)}`,
          { headers },
        )
      ).json()
      expect(previous.data.map((message: { id: string }) => message.id)).toEqual([context[0].id])
      const descending = await (
        await fetch(`${url}/api/session/${session}/message?limit=1&order=desc`, { headers })
      ).json()
      expect(descending.data[0].id).toBe(context[1].id)
      const invalid = Buffer.from(JSON.stringify({ id: "msg_absent", order: "asc", direction: "next" })).toString(
        "base64url",
      )
      expect((await fetch(`${url}/api/session/${session}/message?cursor=${invalid}`, { headers })).status).toBe(400)
      expect(
        (await fetch(`${url}/api/session/${session}/message?cursor=${first.cursor.next}&order=asc`, { headers }))
          .status,
      ).toBe(400)
      // The native engine owns the messages. Serving both APIs must never create
      // a shadow execution/history authority in the product database.
      const db = new Database(database, { readonly: true })
      try {
        const count = db.query("SELECT count(*) AS total FROM session_message WHERE session_id = ?").get(session)
        expect(count).toEqual({ total: 0 })
      } finally {
        db.close()
      }
      expect(calls).toBe(1)
    } finally {
      reader.releaseLock()
      child.kill()
      await child.exited
      provider.stop(true)
    }
  },
  30_000,
)
