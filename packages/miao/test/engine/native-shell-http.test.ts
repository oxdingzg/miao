import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary)
  test.skip("native operator shell preserves execution provenance, retry identity and fork history over HTTP", () => {})
if (binary)
  test("native operator shell preserves execution provenance, retry identity and fork history over HTTP", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(
      policy,
      JSON.stringify({ mode: "workspace", allow_process: true, rules: [{ tool: "*", path: "**", decision: "allow" }] }),
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
        MIAO_ENGINE_POLICY: policy,
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
      const body = { id: "ses_native_shell", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      if (create.status !== 200) throw new Error(`create failed ${create.status}: ${await create.text()}`)
      expect(create.status).toBe(200)
      expect((await create.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })
      const sessionPath = url + "/api/session/" + body.id

      const command = "printf shell-body; printf x >> marker; exit 7"
      const shell = () =>
        fetch(sessionPath + "/shell", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "evt_operator_http", command, resume: false }),
        })
      const response = await shell()
      if (response.status !== 204) throw new Error(`${response.status}: ${await response.text()}`)
      expect(response.status).toBe(204)
      expect(await Bun.file(path.join(directory, "marker")).text()).toBe("x")
      expect(received).toHaveLength(0)
      expect((await shell()).status).toBe(204)
      expect(await Bun.file(path.join(directory, "marker")).text()).toBe("x")
      const conflict = await fetch(sessionPath + "/shell", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "evt_operator_http", command: "printf changed", resume: false }),
      })
      expect(conflict.status).toBe(409)
      const context = await (await fetch(sessionPath + "/context", { headers })).json()
      expect(context.data).toHaveLength(1)
      expect(context.data[0]).toMatchObject({
        callID: "evt_operator_http",
        type: "shell",
        command,
        output: "shell-body",
        metadata: { origin: "operator", exitCode: 7 },
      })
      const history = await (await fetch(sessionPath + "/history", { headers })).json()
      expect(JSON.stringify(history)).toContain("session.next.shell.started")
      expect(JSON.stringify(history)).toContain("session.next.shell.ended")
      expect(JSON.stringify(history)).not.toContain("session.next.prompt.admitted")
      expect(JSON.stringify(history)).not.toContain("session.next.tool.input.started")
      const fork = await fetch(sessionPath + "/fork", {
        method: "POST",
        headers,
        body: JSON.stringify({ messageID: context.data[0].id }),
      })
      expect(fork.status).toBe(200)
      const childSession = await fork.json()
      const forked = await (await fetch(url + `/api/session/${childSession.data.id}/context`, { headers })).json()
      expect(forked.data).toHaveLength(1)
      expect(forked.data[0]).toMatchObject({
        type: "shell",
        output: "shell-body",
        metadata: { origin: "operator", exitCode: 7 },
      })
      const slow = fetch(sessionPath + "/shell", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "evt_running_shell",
          command: "touch slow-started; sleep 30; touch leaked",
          resume: false,
        }),
      })
      void slow.catch(() => undefined)
      const runningDeadline = Date.now() + 5000
      let running = false
      while (Date.now() < runningDeadline) {
        const view = await (await fetch(sessionPath + "/context", { headers })).json()
        running = view.data.some(
          (item: { type: string; callID?: string; time: { completed?: number } }) =>
            item.type === "shell" && item.callID === "evt_running_shell" && item.time.completed === undefined,
        )
        if (running && (await Bun.file(path.join(directory, "slow-started")).exists())) break
        await Bun.sleep(20)
      }
      expect(running).toBe(true)
      expect((await fetch(sessionPath + "/interrupt", { method: "POST", headers, body: "{}" })).status).toBe(204)
      expect((await slow).status).toBe(204)
      expect(await Bun.file(path.join(directory, "leaked")).exists()).toBe(false)
      expect(received).toHaveLength(0)
      const prompt = await fetch(sessionPath + "/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_shell_followup", prompt: { text: "answer" } }),
      })
      expect(prompt.status).toBe(200)
      const deadline = Date.now() + 15000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(20)
      expect(received).toHaveLength(1)
      expect(received[0].body).toContain("operator-shell")
      expect(received[0].body).toContain("shell-body")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      await upstream.stop(true)
    }
  }, 70_000)
