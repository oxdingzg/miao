import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

if (!binary) test.skip("generated native policy activates product MCP tools", () => {})
if (binary)
  test("generated native policy activates product MCP tools", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    let calls = 0
    const mcpRequests: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 })
        const message = await request.json()
        mcpRequests.push(message.method)
        if (message.id === undefined) return new Response(null, { status: 202 })
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "echo",
                      description: "Echo text from the fixture MCP server",
                      inputSchema: {
                        type: "object",
                        properties: { text: { type: "string" } },
                        required: ["text"],
                        additionalProperties: false,
                      },
                    },
                  ],
                }
              : message.method === "tools/call"
                ? { content: [{ type: "text", text: `mcp echo ${message.params.arguments.text}` }] }
                : {}
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result },
          { headers: { "mcp-session-id": "fixture-session" } },
        )
      },
    })
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json()
        calls += 1
        const mcpTool = body.tools
          ?.map((tool: { function?: { name?: string } }) => tool.function?.name)
          .find((name: string | undefined) => name?.startsWith("mcp_fixture_echo"))
        const delta =
          calls === 1
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "mcp-call",
                    type: "function",
                    function: { name: mcpTool ?? "mcp_fixture_echo", arguments: JSON.stringify({ text: "hello" }) },
                  },
                ],
              }
            : { content: "mcp turn settled" }
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const mcpConfig = path.join(tmp.path, "mcp.json")
    await Bun.write(mcpConfig, JSON.stringify([{ name: "fixture", url: `${upstream.url}mcp`, headers: {} }]))
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture/fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        MIAO_ENGINE_MCP_CONFIG: mcpConfig,
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
      let output = ""
      const reader = child.stdout.getReader()
      let url = ""
      while (!url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`native HTTP server exited: ${await stderr} ${output}`)
        output += new TextDecoder().decode(chunk.value)
        url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const create = await fetch(url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "ses_native_mcp", location: { directory } }),
      })
      expect(create.status).toBe(200)
      const prompt = await fetch(url + "/api/session/ses_native_mcp/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_native_mcp", prompt: { text: "call the fixture MCP echo tool" } }),
      })
      expect(prompt.status).toBe(200)
      const deadline = Date.now() + 20_000
      let history = ""
      while (Date.now() < deadline) {
        history = await (await fetch(url + "/api/session/ses_native_mcp/history", { headers })).text()
        if (history.includes("mcp turn settled")) break
        await Bun.sleep(100)
      }
      expect(mcpRequests).toContain("initialize")
      expect(mcpRequests).toContain("tools/list")
      if (!mcpRequests.includes("tools/call")) throw new Error(`MCP tool call did not reach the server: ${history}`)
      expect(history).toContain("mcp echo hello")
      expect(history).toContain("mcp turn settled")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
      upstream.stop(true)
    }
  }, 90_000)
