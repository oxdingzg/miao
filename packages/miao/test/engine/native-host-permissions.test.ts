import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native Session routes expose and answer host-owned permissions",
  async () => {
    if (!binary) throw new Error("native engine required")
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "workspace")
    const destination = path.join(tmp.path, "destination")
    await Bun.$`mkdir -p ${directory} ${destination}`.quiet()
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(policy, JSON.stringify({ rules: [{ tool: "*", path: "**", decision: "allow" }] }))
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages?: Array<{ role: string }> }
        if (body.messages?.some((message) => message.role === "tool"))
          return new Response(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Permission rejected." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "move-call", type: "function", function: { name: "switch_workspace", arguments: JSON.stringify({ directory: destination }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_POLICY: policy,
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        OPENAI_API_KEY: "fixture-only",
        MIAO_PURE: "1",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_TEST_HOME: path.join(tmp.path, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/fixture",
          permission: { "*": "allow", external_directory: "ask" },
          formatter: false,
          lsp: false,
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
        }),
      },
    })
    let errors = ""
    const stderr = (async () => {
      const reader = child.stderr.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        errors += new TextDecoder().decode(chunk.value)
      }
      return errors
    })()
    const deadline = setTimeout(() => child.kill(), 40_000)
    try {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ""
      let url = ""
      while (!url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`server exited: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
        url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const session = "ses_pending_host_callback"
      const created = await fetch(`${url}/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: session, location: { directory } }),
      })
      expect(created.status).toBe(200)
      const events: Array<{
        type: string
        data: { sessionID?: string; requestID?: string; id?: string; reply?: string }
      }> = []
      const subscription = new AbortController()
      const stream = await fetch(`${url}/api/event`, { headers, signal: subscription.signal })
      const pump = (async () => {
        if (!stream.body) throw new Error("missing event stream")
        let buffer = ""
        const reader = stream.body.getReader()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          const frames = buffer.split("\n\n")
          buffer = frames.pop() ?? ""
          for (const frame of frames) {
            const line = frame.split("\n").find((line) => line.startsWith("data: "))
            if (!line) continue
            events.push(JSON.parse(line.slice(6)))
          }
        }
      })().catch(() => {})
      const admitted = await fetch(`${url}/api/session/${session}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_pending_host_callback", prompt: { text: "switch workspace" } }),
      })
      expect(admitted.status).toBe(200)
      const asked = Date.now() + 15_000
      while (
        !events.some((event) => event.type === "permission.v2.asked" && event.data.sessionID === session) &&
        Date.now() < asked
      )
        await Bun.sleep(20)
      const request = events.find((event) => event.type === "permission.v2.asked" && event.data.sessionID === session)
      expect(request).toBeDefined()
      const global = await fetch(`${url}/api/permission/request`, { headers }).then((response) => response.json())
      const listed = await fetch(`${url}/api/session/${session}/permission`, { headers }).then((response) =>
        response.json(),
      )
      expect(global.data.some((pending: { id: string }) => pending.id === request?.data.id)).toBe(true)
      const other = await fetch(`${url}/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "ses_other_host_callback", location: { directory } }),
      })
      expect(other.status).toBe(200)
      const foreign = `${url}/api/session/ses_other_host_callback/permission/${request?.data.id}`
      expect((await fetch(foreign, { headers })).status).toBe(404)
      expect(
        (await fetch(`${foreign}/reply`, { method: "POST", headers, body: JSON.stringify({ reply: "reject" }) }))
          .status,
      ).toBe(404)
      const hidden = await fetch(`${url}/api/session/ses_other_host_callback/permission`, { headers }).then(
        (response) => response.json(),
      )
      expect(hidden.data).toHaveLength(0)
      expect(listed.data.some((pending: { id: string }) => pending.id === request?.data.id)).toBe(true)
      const get = await fetch(`${url}/api/session/${session}/permission/${request?.data.id}`, { headers })
      expect(get.status).toBe(200)
      const reply = await fetch(`${url}/api/session/${session}/permission/${request?.data.id}/reply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reply: "reject" }),
      })
      expect(reply.status).toBe(204)
      const settled = Date.now() + 5_000
      const replied = () =>
        events.find((event) => event.type === "permission.v2.replied" && event.data.requestID === request?.data.id)
      while (!replied() && Date.now() < settled) await Bun.sleep(20)
      subscription.abort()
      await pump
      expect(replied()?.data.reply).toBe("reject")
      const remaining = await fetch(`${url}/api/session/${session}/permission`, { headers }).then((response) =>
        response.json(),
      )
      expect(remaining.data).toHaveLength(0)
      expect((await fetch(`${url}/api/session/${session}/permission/${request?.data.id}`, { headers })).status).toBe(
        404,
      )
    } finally {
      clearTimeout(deadline)
      child.kill()
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2_000).then(() => false)])
      if (!exited) child.kill("SIGKILL")
      await child.exited
      provider.stop(true)
    }
  },
  50_000,
)
