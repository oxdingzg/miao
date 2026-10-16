import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// Minimal MCP stdio server: JSON-RPC initialize / tools/list / tools/call.
const mcpServerScript = `const reader = require("node:readline").createInterface({ input: process.stdin, terminal: false })
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
reader.on("line", (line) => {
  if (!line.trim()) return
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.method === "initialize") {
    send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture-mcp", version: "1.0.0" } } })
    return
  }
  if (frame.method === "tools/list") {
    send({ jsonrpc: "2.0", id: frame.id, result: { tools: [{ name: "echo", description: "Echo the input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } })
    return
  }
  if (frame.method === "tools/call") {
    const text = frame.params?.arguments?.text ?? "(none)"
    send({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: "mcp echo ok: " + text }] } })
  }
})
`

// The engine aliases MCP tools as mcp_<server[:12]>_<slug[:14]>_<sha256[:32]>.
const mcpAlias = (server: string, tool: string) => {
  const slug = tool
    .slice(0, 14)
    .replace(/[^a-zA-Z0-9]/g, "_")
  const suffix = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 32)
  return `mcp_${server.slice(0, 12)}_${slug}_${suffix}`
}

// 3b acceptance: the product config's local MCP servers reach the native
// engine through --mcp-config (the layer synthesizes it plus the allow_mcp
// authority), and the model executes an MCP tool through the product server.
if (!binary) test.skip("product-configured MCP servers execute through the native engine", () => {})
if (binary)
  test("product-configured MCP servers execute through the native engine", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const mcpServerPath = path.join(tmp.path, "mcp-server.ts")
    await Bun.write(mcpServerPath, mcpServerScript)
    const bodies: unknown[] = []
    let requests = 0
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json())
        requests += 1
        const delta =
          requests % 2 === 1
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${requests}`,
                    type: "function",
                    function: { name: mcpAlias("fixture", "echo"), arguments: '{"text":"through the engine"}' },
                  },
                ],
              }
            : { content: "mcp turn settled" }
        const stop = requests % 2 === 1 ? "tool_calls" : "stop"
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: stop }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
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
          mcp: { servers: { fixture: { type: "local", command: [process.execPath, mcpServerPath] } } },
          formatter: false,
          lsp: false,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 90_000)
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
      const create = await fetch(url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "ses_g1_mcp", location: { directory } }),
      })
      expect(create.status).toBe(200)
      const prompt = await fetch(url + "/api/session/ses_g1_mcp/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_g1_mcp", prompt: { text: "use the echo tool" } }),
      })
      expect(prompt.status).toBe(200)
      const deadline = Date.now() + 30_000
      let history = ""
      while (Date.now() < deadline) {
        history = await (await fetch(url + "/api/session/ses_g1_mcp/history", { headers })).text()
        if (history.includes("mcp turn settled")) break
        await Bun.sleep(100)
      }
      // The MCP tool executed and its result content reached the transcript.
      expect(history).toContain("mcp echo ok: through the engine")
      expect(history).toContain("session.next.tool.success")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  }, 120_000)
