import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// 3a acceptance: real project custom tools reach the native engine through the
// ADR-12 worker host. The model calls the worker-aliased tool, the workspace
// tool executes with its real result, a throwing tool surfaces as a tool
// failure without ending the conversation, and killing the worker host
// degrades only the worker capability while the session keeps running.
if (!binary) test.skip("native worker tools execute real project custom tools", () => {})
if (binary)
  test("native worker tools execute real project custom tools", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    const toolDir = path.join(directory, ".miao", "tool")
    await Bun.$`mkdir -p ${toolDir}`.quiet()
    await Bun.write(
      path.join(toolDir, "greet.ts"),
      `import { tool } from "@miao/plugin/tool"

export default tool({
  description: "Greet someone",
  args: { name: tool.schema.string() },
  async execute(args, context) {
    return \`hello \${args.name} from \${context.agent} in \${context.directory}\`
  },
})
`,
    )
    await Bun.write(
      path.join(toolDir, "boom.ts"),
      `import { tool } from "@miao/plugin/tool"

export default tool({
  description: "Always fails",
  args: {},
  async execute() {
    throw new Error("boom intended")
  },
})
`,
    )
    // The custom tool imports `@miao/plugin/tool`; a workspace project resolves
    // it through the repository's hoisted node_modules.
    await Bun.$`ln -s ${path.resolve(import.meta.dir, "../../../../node_modules")} ${path.join(directory, "node_modules")}`.quiet()

    // Worker tools are Access::External, so the engine's policy gates them; a
    // workspace-wide allow stands in for the external-tool approval a real
    // client grants.
    const policyFile = path.join(tmp.path, "policy.json")
    await Bun.write(
      policyFile,
      JSON.stringify({
        mode: "workspace",
        allow_process: true,
        allow_background: true,
        allow_subagents: true,
        allow_mcp: true,
        rules: [{ tool: "*", path: "**", decision: "allow" }],
      }),
    )

    // Odd provider requests open a turn with one worker tool call; even ones
    // settle the turn with final text.
    let requests = 0
    const callsForTurn = ["worker__greet", "worker__boom", "worker__greet"]
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json())
        requests += 1
        const turn = Math.floor((requests - 1) / 2)
        const delta = requests % 2 === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${requests}`,
                  type: "function",
                  function: {
                    name: callsForTurn[turn] ?? "worker__greet",
                    arguments: (callsForTurn[turn] ?? "worker__greet") === "worker__greet" ? '{"name":"world"}' : "{}",
                  },
                },
              ],
            }
          : { content: `turn ${turn + 1} settled` }
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: requests % 2 === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    var bodies: unknown[] = []
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary!,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture/fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        MIAO_ENGINE_WORKER: "1",
        MIAO_ENGINE_POLICY: policyFile,
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
              api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://127.0.0.1:1", settings: { apiKey: "fixture-only" } },
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
    const timer = setTimeout(() => child.kill(), 120_000)
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
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify({ id: "ses_g1_worker", location: { directory } }) })
      expect(create.status).toBe(200)

      const history = async () => {
        const response = await fetch(url + "/api/session/ses_g1_worker/history", { headers })
        return response.text()
      }
      const settle = async (marker: string) => {
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          const text = await history()
          if (text.includes(marker)) return text
          await Bun.sleep(100)
        }
        return await history()
      }

      // Turn 1: the worker-aliased custom tool executes with its real result.
      await fetch(url + "/api/session/ses_g1_worker/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_worker_1", prompt: { text: "greet the world" } }),
      })
      const first = await settle("turn 1 settled")
      // The bridge projects worker calls under the "custom" tool name.
      expect(first).toContain("session.next.tool.called")
      expect(first).toContain("hello world from worker")

      // Turn 2: a throwing tool surfaces as a tool failure; the turn still
      // settles.
      await fetch(url + "/api/session/ses_g1_worker/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_worker_2", prompt: { text: "use the failing tool" } }),
      })
      const second = await settle("turn 2 settled")
      // The throw becomes a worker error reply, which the engine turns into a
      // tool failure; the turn still settles.
      expect(second).toContain("session.next.tool.failed")

      // Turn 3: killing the worker host degrades only the worker capability —
      // the call fails as a tool failure and the session keeps running.
      Bun.spawnSync(["pkill", "-f", "engine/worker-host.ts"])
      await Bun.sleep(200)
      await fetch(url + "/api/session/ses_g1_worker/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_worker_3", prompt: { text: "greet again after the worker died" } }),
      })
      const third = await settle("turn 3 settled")
      expect(third).toMatch(/worker (closed|call failed|transport failed)/)
      expect(third).toContain("turn 3 settled")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
      try {
        const log = await Bun.file(path.join(tmp.path, "data", "miao", "log", "miao.log")).text()
        console.log("SERVER LOG worker-host lines:", log.split("\n").filter((line) => line.includes("worker-host")).slice(0, 4))
        console.log("SERVER LOG unavailable lines:", log.split("\n").filter((line) => line.includes("unavailable")).slice(0, 3).map((line) => line.slice(0, 300)))
      } catch {}
    }
  }, 150_000)
