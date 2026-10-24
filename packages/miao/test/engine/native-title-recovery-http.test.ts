import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "opening a retained native session repairs its title and manual rename updates the catalog",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const state = { repair: false, titleCalls: 0 }
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json()
        const title = JSON.stringify(body).includes("Generate a title for this conversation")
        if (title) state.titleCalls++
        if (title && !state.repair)
          return Response.json({ error: { message: "title service temporarily unavailable" } }, { status: 400 })
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: title ? "Recovered native title" : "Fixture task finished" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const database = path.join(tmp.path, "miao.db")
    const children: ReturnType<typeof Bun.spawn>[] = []
    const readers: Promise<string>[] = []
    const start = async () => {
      const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: path.join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          MIAO_DB: database,
          MIAO_ENGINE_BIN: binary,
          MIAO_ENGINE_PROVIDER: "openai-chat",
          MIAO_ENGINE_MODEL: "fixture",
          MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
          MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
          MIAO_ENGINE_POLICY: "",
          MIAO_ENGINE_CREDENTIAL_DB: "",
          MIAO_ENGINE_CREDENTIAL_ID: "",
          MIAO_ENGINE_MODEL_ROUTES: "",
          MIAO_ENGINE_MODEL_ROUTES_CONFIG: "",
          MIAO_PURE: "1",
          OPENAI_API_KEY: "fixture-only",
          MIAO_SERVER_USERNAME: "fixture",
          MIAO_SERVER_PASSWORD: "fixture-password",
          MIAO_CONFIG_CONTENT: JSON.stringify({
            model: "fixture/fixture",
            providers: {
              fixture: {
                name: "Fixture",
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: provider.url.href,
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
      children.push(child)
      readers.push(new Response(child.stderr).text())
      const reader = child.stdout.getReader()
      const output = { text: "", url: "" }
      while (!output.url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("native title server stopped before startup")
        output.text += new TextDecoder().decode(chunk.value)
        output.url = output.text.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      return { child, url: output.url }
    }
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": directory,
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const sid = `ses_title_repair_${crypto.randomUUID()}`
    const until = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 20_000
      while (Date.now() < end) {
        if (await check()) return
        await Bun.sleep(50)
      }
      throw new Error("title recovery deadline exceeded")
    }
    try {
      const first = await start()
      expect(
        (
          await fetch(first.url + "/api/session", {
            method: "POST",
            headers,
            body: JSON.stringify({ id: sid, location: { directory } }),
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await fetch(first.url + `/api/session/${sid}/rename`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title: "New session" }),
          })
        ).status,
      ).toBe(204)
      expect(
        (
          await fetch(first.url + `/api/session/${sid}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: `msg_${sid}`, prompt: { text: "Fix retained session titles" } }),
          })
        ).status,
      ).toBe(200)
      await until(async () => state.titleCalls > 0)
      first.child.kill()
      await first.child.exited
      state.repair = true
      const second = await start()
      await until(async () => {
        const response = await fetch(second.url + `/api/session/${sid}`, { headers })
        return (await response.json()).data.title === "Recovered native title"
      })
      expect(
        (
          await fetch(second.url + `/api/session/${sid}/rename`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title: "My retained title" }),
          })
        ).status,
      ).toBe(204)
      const info = await (await fetch(second.url + `/api/session/${sid}`, { headers })).json()
      expect(info.data.title).toBe("My retained title")
      const catalog = new Database(database, { readonly: true })
      try {
        expect(catalog.query<{ title: string }, [string]>("SELECT title FROM session WHERE id=?").get(sid)?.title).toBe(
          "My retained title",
        )
      } finally {
        catalog.close()
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
      await Promise.all(readers)
      provider.stop(true)
    }
  },
  60_000,
)
