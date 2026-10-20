import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
for (const writable of [false, true]) {
  if (!binary) test.skip(`native HTTP coding keeps writable=${writable} explicit`, () => {})
  if (binary)
    test(`native HTTP coding keeps writable=${writable} explicit`, async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "project")
      await Bun.$`mkdir -p ${directory}`.quiet()
      const policyFile = path.join(tmp.path, "policy.json")
      await Bun.write(policyFile, JSON.stringify({ mode: writable ? "workspace" : "read_only" }))
      let calls = 0
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          calls++
          const body = await request.json()
          const first = !body.messages.some((message: { role: string }) => message.role === "tool")
          const delta = first
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "write-call",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "native-output.txt",
                        text: "written by Rust",
                        expected_sha256: null,
                      }),
                    },
                  },
                ],
              }
            : { content: "completed-native-coding-turn" }
          return new Response(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
          MIAO_ENGINE_POLICY: policyFile,
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
            ...(writable ? { permissions: [{ action: "edit", resource: "*", effect: "ask" }] } : {}),
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
        const body = { id: "ses_http_native_birth", location: { directory } }
        const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
        expect(create.status).toBe(200)
        const created = await create.json()
        expect(calls).toBe(0)
        const prompt = await fetch(url + "/api/session/" + body.id + "/prompt", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "msg_native_coding", prompt: { text: "write the file" } }),
        })
        expect(prompt.status).toBe(200)
        if (writable) {
          const until = Date.now() + 10_000
          let requestID: string | undefined
          while (Date.now() < until) {
            const permission = await fetch(url + "/api/session/" + body.id + "/permission", { headers })
            if (!permission.ok) throw new Error(`native permission HTTP ${permission.status}`)
            const pending = await permission.json()
            requestID = pending.data[0]?.id
            if (requestID) break
            await Bun.sleep(50)
          }
          expect(requestID).toBeDefined()
          expect(await Bun.file(path.join(directory, "native-output.txt")).exists()).toBe(false)
          const approved = await fetch(url + "/api/session/" + body.id + "/permission/" + requestID + "/reply", {
            method: "POST",
            headers,
            body: JSON.stringify({ reply: "once" }),
          })
          expect(approved.status).toBe(204)
        }
        const deadline = Date.now() + 15_000
        let history = ""
        while (Date.now() < deadline) {
          const response = await fetch(url + "/api/session/" + body.id + "/history", { headers })
          if (!response.ok) throw new Error(`native history HTTP ${response.status}`)
          history = await response.text()
          if (history.includes("completed-native-coding-turn")) break
          await Bun.sleep(50)
        }
        expect(history).toContain("completed-native-coding-turn")
        expect(history).toContain("native-output.txt")
        const context = await fetch(url + "/api/session/" + body.id + "/context", { headers })
        expect(context.status).toBe(200)
        const transcript = await context.json()
        expect(JSON.stringify(transcript.data)).toContain("completed-native-coding-turn")
        const states = transcript.data.flatMap(
          (message: { content?: { type: string; state?: { status: string } }[] }) =>
            message.content?.filter((part) => part.type === "tool").map((part) => part.state?.status) ?? [],
        )
        expect(states).toContain(writable ? "completed" : "error")
        expect(calls).toBe(2)
        const writtenFile = Bun.file(path.join(directory, "native-output.txt"))
        expect(await writtenFile.exists()).toBe(writable)
        if (writable) expect(await writtenFile.text()).toBe("written by Rust")
      } finally {
        clearTimeout(timer)
        child.kill()
        await child.exited
        await stderr
        provider.stop(true)
      }
    }, 40_000)
}
