import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native agent switching preserves ordered permissions over HTTP", () => {})
if (binary)
  test("native agent switching preserves ordered permissions over HTTP", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const bodies: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.text())
        const index = bodies.length - 1
        const delta =
          index % 2 === 0
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${index}`,
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "note.txt",
                        text: "allowed-by-exception",
                        expected_sha256: null,
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "done" }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: index % 2 === 0 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(
      policy,
      JSON.stringify({ mode: "workspace", rules: [{ tool: "*", path: "**", decision: "allow" }] }),
    )
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
        MIAO_ENGINE_POLICY: policy,
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
          formatter: false,
          lsp: false,
          agents: {
            reviewer: {
              system: "REVIEWER_SYSTEM_MARKER",
              steps: 8,
              request: { body: { temperature: 0.2 }, headers: { "x-agent-label": "reviewer" } },
              permissions: [
                { action: "*", resource: "*", effect: "deny" },
                { action: "read", resource: "*", effect: "allow" },
              ],
            },
            exception: {
              system: "EXCEPTION_SYSTEM_MARKER",
              permissions: [
                { action: "*", resource: "*", effect: "deny" },
                { action: "edit", resource: "note.txt", effect: "allow" },
              ],
            },
          },
        }),
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
      const body = { id: "ses_native_agent", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      expect(create.status).toBe(200)
      expect((await create.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })
      const agentPath = url + "/api/session/" + body.id + "/agent"
      expect((await fetch(agentPath, { method: "POST" })).status).toBe(401)
      const select = (agent: string) => fetch(agentPath, { method: "POST", headers, body: JSON.stringify({ agent }) })
      const selected = await select("reviewer")
      if (selected.status !== 204) throw new Error(`select failed: ${selected.status} ${await selected.text()}`)
      expect((await (await fetch(url + "/api/session/" + body.id, { headers })).json()).data.agent).toBe("reviewer")
      expect((await select("does-not-exist")).status).toBe(409)
      const prompt = (id: string) =>
        fetch(url + "/api/session/" + body.id + "/prompt", {
          method: "POST",
          headers,
          body: JSON.stringify({ id, prompt: { text: "write the file" } }),
        })
      expect((await prompt("msg_agent_one")).status).toBe(200)
      const waitFor = async (count: number) => {
        const deadline = Date.now() + 15000
        while (bodies.length < count && Date.now() < deadline) await Bun.sleep(20)
        expect(bodies.length).toBeGreaterThanOrEqual(count)
      }
      await waitFor(2)
      expect(bodies[0]).toContain("REVIEWER_SYSTEM_MARKER")
      expect(bodies[0]).not.toContain('"name":"write_file"')
      expect(bodies[0]).toContain('"temperature":0.2')
      expect(bodies[1]).toContain("permission denied")
      expect(await Bun.file(path.join(directory, "note.txt")).exists()).toBe(false)
      expect((await select("exception")).status).toBe(204)
      expect((await prompt("msg_agent_two")).status).toBe(200)
      await waitFor(4)
      expect(bodies[2]).toContain("EXCEPTION_SYSTEM_MARKER")
      expect(await Bun.file(path.join(directory, "note.txt")).text()).toBe("allowed-by-exception")
      expect((await (await fetch(url + "/api/session/" + body.id, { headers })).json()).data.agent).toBe("exception")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      await upstream.stop(true)
    }
  }, 70_000)
