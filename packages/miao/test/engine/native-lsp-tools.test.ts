import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// Minimal LSP stdio server: Content-Length framed JSON-RPC. Replies to
// initialize, answers every request with an empty result, and publishes a
// diagnostic for any document the client opens.
const lspServerScript = `const decoder = new TextDecoder()
let buffer = ""
const send = (message) => {
  const body = JSON.stringify(message)
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)
}
process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk, { stream: true })
  for (;;) {
    const marker = buffer.indexOf("\\r\\n\\r\\n")
    if (marker === -1) break
    const header = buffer.slice(0, marker)
    const length = Number(header.match(/Content-Length: (\\d+)/)?.[1] ?? 0)
    if (buffer.length < marker + 4 + length) return
    const body = buffer.slice(marker + 4, marker + 4 + length)
    buffer = buffer.slice(marker + 4 + length)
    let frame
    try { frame = JSON.parse(body) } catch { continue }
    if (frame.method === "initialize") {
      send({ jsonrpc: "2.0", id: frame.id, result: { capabilities: { textDocumentSync: 1 } } })
      continue
    }
    if (frame.method === "textDocument/didOpen") {
      const uri = frame.params.textDocument.uri
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: "fixture diagnostic", severity: 2 }] } })
      continue
    }
    if (frame.id !== undefined) {
      send({ jsonrpc: "2.0", id: frame.id, result: null })
    }
  }
})
`

// 3c acceptance: the global config's engine.lsp_config reaches the native
// engine (--lsp-config), the engine exposes the lsp_* tools, and diagnostics
// from the configured server surface in the transcript through a real client.
if (!binary) test.skip("engine.lsp_config drives native LSP diagnostics", () => {})
if (binary)
  test("engine.lsp_config drives native LSP diagnostics", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    const configDir = path.join(tmp.path, "config", "miao")
    await Bun.$`mkdir -p ${directory} ${configDir}`.quiet()
    await Bun.write(path.join(directory, "notes.txt"), "fixture document body\n")
    const lspServerPath = path.join(tmp.path, "lsp-server.ts")
    await Bun.write(lspServerPath, lspServerScript)
    const lspConfigPath = path.join(configDir, "lsp.json")
    await Bun.write(
      lspConfigPath,
      JSON.stringify([{ name: "fixture", argv: [process.execPath, lspServerPath], extensions: [".txt"] }]),
    )

    let requests = 0
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        await request.json()
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
                    function: { name: "lsp_diagnostics", arguments: JSON.stringify({ path: "notes.txt" }) },
                  },
                ],
              }
            : { content: "lsp turn settled" }
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
        MIAO_ENGINE_LSP_CONFIG: lspConfigPath,
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
          engine: { lsp_config: "lsp.json" },
          formatter: false,
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
        body: JSON.stringify({ id: "ses_g1_lsp", location: { directory } }),
      })
      expect(create.status).toBe(200)
      const prompt = await fetch(url + "/api/session/ses_g1_lsp/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_g1_lsp", prompt: { text: "show diagnostics for notes.txt" } }),
      })
      expect(prompt.status).toBe(200)
      const deadline = Date.now() + 30_000
      let history = ""
      while (Date.now() < deadline) {
        history = await (await fetch(url + "/api/session/ses_g1_lsp/history", { headers })).text()
        if (history.includes("lsp turn settled")) break
        await Bun.sleep(100)
      }
      // The configured LSP server's diagnostics surfaced through the engine's
      // lsp_diagnostics tool into the transcript.
      expect(history).toContain("fixture diagnostic")
      expect(history).toContain("session.next.tool.success")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  }, 120_000)
