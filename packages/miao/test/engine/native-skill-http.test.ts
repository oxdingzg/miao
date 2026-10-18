import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native skills inject synthetic context without starting a provider turn", () => {})
if (binary)
  test("native skills inject synthetic context without starting a provider turn", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    await Bun.write(
      path.join(directory, ".miao/skills/fixture/SKILL.md"),
      "---\nname: fixture\ndescription: HTTP fixture\n---\nFIXTURE_SKILL_BODY\n",
    )
    const received: { path: string; authorization: string | null; body: string }[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.text(),
        })
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
        MIAO_ENGINE_ENDPOINT: `http://127.0.0.1:${upstream.port}/a`,
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        OPENAI_API_KEY: "A_TOKEN",
        ANTHROPIC_API_KEY: "B_TOKEN",
        MIAO_PURE: "1",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_TEST_HOME: path.join(tmp.path, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      let output = ""
      let url = ""
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
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
      const body = { id: "ses_native_skill", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      if (create.status !== 200) throw new Error(`create failed ${create.status}: ${await create.text()}`)
      expect(create.status).toBe(200)
      expect((await create.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })
      const sessionPath = url + "/api/session/" + body.id

      const missing = await fetch(sessionPath + "/skill", {
        method: "POST",
        headers,
        body: JSON.stringify({ skill: "missing", resume: false }),
      })
      expect(missing.status).toBe(404)
      const injected = await fetch(sessionPath + "/skill", {
        method: "POST",
        headers,
        body: JSON.stringify({ skill: "fixture", resume: false }),
      })
      if (injected.status !== 204) throw new Error(`${injected.status}: ${await injected.text()}`)
      expect(injected.status).toBe(204)
      expect(received).toHaveLength(0)
      const history = await (await fetch(sessionPath + "/history", { headers })).json()
      expect(JSON.stringify(history)).toContain("session.next.synthetic")
      expect(JSON.stringify(history)).toContain("FIXTURE_SKILL_BODY")
      expect(JSON.stringify(history)).not.toContain("session.next.prompt.admitted")
      const context = await fetch(sessionPath + "/context", { headers })
      expect(context.status).toBe(200)
      const projected = await context.json()
      expect(projected.data).toHaveLength(1)
      expect(projected.data[0].type).toBe("synthetic")
      expect(projected.data[0].text).toContain("FIXTURE_SKILL_BODY")
      const resumed = await fetch(sessionPath + "/skill", {
        method: "POST",
        headers,
        body: JSON.stringify({ skill: "fixture", resume: true }),
      })
      expect(resumed.status).toBe(204)
      await Bun.sleep(200)
      expect(received).toHaveLength(0)
      const prompt = await fetch(sessionPath + "/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_skill_followup", prompt: { text: "answer" } }),
      })
      expect(prompt.status).toBe(200)
      const deadline = Date.now() + 15000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(20)
      expect(received).toHaveLength(1)
      expect(received[0].body).toContain("FIXTURE_SKILL_BODY")
      expect(received[0].body).toContain("skill:fixture")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      await upstream.stop(true)
    }
  }, 70_000)
