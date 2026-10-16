import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Schema } from "effect"
import { EngineClient, type EngineEvent } from "@/engine/client"
import { engineSettings, nativeEngineOptions } from "@/engine/native-engine"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

const lspPeer = `
const log = process.argv[2]
const seen = []
let buffer = Buffer.alloc(0)
function send(result) {
  const body = JSON.stringify(result)
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body)
}
for await (const chunk of process.stdin) {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const boundary = buffer.indexOf("\\r\\n\\r\\n")
    if (boundary < 0) break
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, boundary).toString())
    if (!match) throw new Error("missing frame length")
    const size = Number(match[1])
    if (buffer.length < boundary + 4 + size) break
    const request = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + size).toString())
    buffer = buffer.subarray(boundary + 4 + size)
    seen.push({ method: request.method, params: request.params })
    await Bun.write(log, JSON.stringify(seen))
    if (request.id === undefined) continue
    const result = request.method === "initialize" ? { capabilities: { hoverProvider: true, textDocumentSync: 1 } }
      : request.method === "textDocument/hover" ? { contents: { kind: "markdown", value: "LSP-PRODUCT" } }
      : null
    send({ jsonrpc: "2.0", id: request.id, result })
  }
}
`

// This goes through product config and EngineClient rather than passing native
// flags directly to the independent ACP fixture.
for (const entry of [
  { capability: "mcp", source: "file" },
  { capability: "mcp", source: "shared" },
  { capability: "lsp", source: "file" },
] as const)
  test.skipIf(!binary)(
    `global product ${entry.capability} ${entry.source} configuration reaches the real native owner`,
    async () => {
      await using tmp = await tmpdir()
      const workspace = path.join(tmp.path, "workspace")
      await mkdir(workspace)
      const peer = path.join(tmp.path, "peer.ts")
      const record = path.join(tmp.path, "peer-calls.json")
      await Bun.write(path.join(workspace, "sample.ts"), "const sample = 1\n")
      await Bun.write(
        peer,
        entry.capability === "lsp"
          ? lspPeer
          : `
for await (const line of console) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
    ? { tools: [{ name: "echo/value", description: "fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] }
    : request.method === "tools/call"
    ? { content: [{ type: "text", text: "MCP-PRODUCT:" + request.params.arguments.value }], isError: false }
    : {}
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
}
`,
      )
      await Bun.write(
        path.join(tmp.path, "mcp.json"),
        JSON.stringify([
          {
            name: "fixture",
            argv: [process.execPath, peer, record],
            ...(entry.capability === "lsp" ? { extensions: ["ts"] } : {}),
          },
        ]),
      )
      await Bun.write(
        path.join(tmp.path, "miao.json"),
        JSON.stringify(
          entry.source === "file"
            ? { engine: { model: "fixture", [`${entry.capability}_config`]: "mcp.json" } }
            : {
                engine: { model: "fixture" },
                mcp: { servers: { fixture: { type: "local", command: [process.execPath, peer] } } },
              },
        ),
      )
      const policy = path.join(tmp.path, "policy.json")
      await Bun.write(
        policy,
        JSON.stringify({ mode: "workspace", allow_mcp: true, rules: [{ tool: "*", path: "**", decision: "allow" }] }),
      )
      const bodies: unknown[] = []
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body: unknown = await request.json()
          bodies.push(body)
          const catalog =
            bodies.length === 1
              ? Schema.decodeUnknownSync(
                  Schema.Struct({
                    tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
                  }),
                )(body)
              : undefined
          const tool = catalog?.tools.find((item) =>
            entry.capability === "mcp"
              ? item.function.name.startsWith("mcp_fixture_")
              : item.function.name === "lsp_hover",
          )
          if (catalog && !tool) throw new Error("product did not attach its configured MCP server")
          const frame = tool
            ? {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "host_call",
                          type: "function",
                          function: {
                            name: tool.function.name,
                            arguments: JSON.stringify(
                              entry.capability === "mcp"
                                ? { value: "host-wire" }
                                : { path: "sample.ts", line: 0, character: 0 },
                            ),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }
            : { choices: [{ index: 0, delta: { content: "product host completed" }, finish_reason: "stop" }] }
          return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      const options = nativeEngineOptions(
        {
          MIAO_ENGINE_BIN: binary,
          MIAO_ENGINE_PROVIDER: "openai-chat",
          MIAO_ENGINE_ENDPOINT: provider.url.toString(),
          MIAO_ENGINE_POLICY: policy,
        },
        await engineSettings(tmp.path),
      )
      if (!options) throw new Error("native binary must produce options")
      const client = EngineClient.start({
        ...options,
        db: path.join(tmp.path, "engine.db"),
        workspace,
        env: { OPENAI_API_KEY: "fixture" },
      })
      try {
        const completed = Promise.withResolvers<EngineEvent>()
        client.onEvent((event) => {
          if (event.kind === "run.finished" || event.kind === "run.failed") completed.resolve(event)
        })
        await client.admit({ session_id: "s", input_id: "i", prompt: "use the configured host" })
        await client.subscribe("s")
        expect((await completed.promise).kind).toBe("run.finished")
        expect(bodies.length).toBe(2)
        const continuation = Schema.decodeUnknownSync(
          Schema.Struct({
            messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
          }),
        )(bodies[1])
        expect(JSON.stringify(continuation.messages.findLast((message) => message.role === "tool")?.content)).toContain(
          entry.capability === "mcp" ? "MCP-PRODUCT:host-wire" : "LSP-PRODUCT",
        )
        if (entry.capability === "lsp") {
          const calls = await Bun.file(record).text()
          expect(calls).toContain("textDocument/didOpen")
          expect(calls).toContain("textDocument/hover")
          expect(calls).toContain("const sample = 1")
        }
        expect(JSON.stringify(await client.history("s", false))).toContain("product host completed")
      } finally {
        await client.close()
        provider.stop(true)
      }
    },
    20_000,
  )
