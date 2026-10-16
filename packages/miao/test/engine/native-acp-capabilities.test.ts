import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Schema } from "effect"
import { Database } from "bun:sqlite"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { tmpdir } from "../fixture/fixture"
import { connectNativeACP } from "./acp-client-fixture"

const binary = process.env.MIAO_ENGINE_BIN

const mcpPeer = `
const log = process.argv[2]
for await (const line of console) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  if (request.method === "initialize") {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "echo/value", description: "fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] }
  } else if (request.method === "tools/call") {
    await Bun.write(log, JSON.stringify(request.params))
    result = { content: [{ type: "text", text: "MCP-ROUNDTRIP:" + request.params.arguments.value }], isError: false }
  } else throw new Error("unexpected MCP request: " + request.method)
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
}

`

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
      : request.method === "textDocument/hover" ? { contents: { kind: "markdown", value: "LSP-HOVER-ROUNDTRIP" } }
      : null
    send({ jsonrpc: "2.0", id: request.id, result })
  }
}
`

for (const capability of ["mcp", "lsp"] as const) {
  test.skipIf(!binary)(
    `native ACP SDK receives ${capability} tool results through a real host peer`,
    async () => {
      await using tmp = await tmpdir()
      const workspace = path.join(tmp.path, "workspace")
      await mkdir(workspace)
      await Bun.write(path.join(workspace, "sample.ts"), "const sample = 1\n")
      const record = path.join(tmp.path, "host-calls.json")
      const peer = path.join(tmp.path, "peer.ts")
      await Bun.write(peer, capability === "mcp" ? mcpPeer : lspPeer)
      const config = path.join(tmp.path, "host-config.json")
      await Bun.write(
        config,
        JSON.stringify([
          {
            name: "fixture",
            argv: [process.execPath, peer, record],
            ...(capability === "lsp" ? { extensions: ["ts"] } : {}),
          },
        ]),
      )
      await Bun.write(
        path.join(tmp.path, "policy.json"),
        JSON.stringify({
          mode: "workspace",
          allow_mcp: true,
          rules: [{ tool: "*", path: "**", decision: "allow" }],
        }),
      )
      const bodies: unknown[] = []
      const provider = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const body: unknown = await request.json()
          bodies.push(body)
          const frame =
            bodies.length === 1
              ? (() => {
                  const catalog = Schema.decodeUnknownSync(
                    Schema.Struct({
                      tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
                    }),
                  )(body)
                  const tool = catalog.tools.find((tool) =>
                    capability === "mcp"
                      ? tool.function.name.startsWith("mcp_fixture_")
                      : tool.function.name === "lsp_hover",
                  )
                  if (!tool) throw new Error(`missing ${capability} tool in catalog`)
                  return {
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
                                  capability === "mcp"
                                    ? { value: "sdk-value" }
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
                })()
              : { choices: [{ index: 0, delta: { content: "host capability completed" }, finish_reason: "stop" }] }
          return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      try {
        const updates: SessionNotification[] = []
        await using agent = await connectNativeACP(
          tmp.path,
          provider.url.toString(),
          {
            async requestPermission() {
              throw new Error("explicit host policy should grant this tool")
            },
            async sessionUpdate(update) {
              updates.push(update)
            },
          },
          { workspace, args: [capability === "mcp" ? "--mcp-config" : "--lsp-config", config] },
        )
        const session = await agent.connection.newSession({ cwd: workspace, mcpServers: [] })
        expect(
          (
            await agent.connection.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "use the declared host capability" }],
            })
          ).stopReason,
        ).toBe("end_turn")
        expect(bodies).toHaveLength(2)
        expect(JSON.stringify(bodies[1])).toContain(
          capability === "mcp" ? "MCP-ROUNDTRIP:sdk-value" : "LSP-HOVER-ROUNDTRIP",
        )
        expect(updates.some((event) => event.update.sessionUpdate === "tool_call")).toBe(true)
        expect(
          updates.some(
            (event) => event.update.sessionUpdate === "tool_call_update" && event.update.status === "completed",
          ),
        ).toBe(true)
        expect(
          updates.some(
            (event) =>
              event.update.sessionUpdate === "agent_message_chunk" &&
              event.update.content.type === "text" &&
              event.update.content.text === "host capability completed",
          ),
        ).toBe(true)
        if (capability === "mcp") {
          expect(await Bun.file(record).json()).toMatchObject({ name: "echo/value", arguments: { value: "sdk-value" } })
        } else {
          const calls = Schema.decodeUnknownSync(
            Schema.Array(Schema.Struct({ method: Schema.String, params: Schema.Unknown })),
          )(await Bun.file(record).json())
          expect(calls.map((call) => call.method)).toContain("textDocument/didOpen")
          expect(calls.find((call) => call.method === "textDocument/hover")?.params).toMatchObject({
            position: { line: 0, character: 0 },
          })
        }
      } finally {
        provider.stop(true)
      }
    },
    25_000,
  )
}

for (const cancel of [false, true]) {
  test.skipIf(!binary)(
    `native ACP SDK ${cancel ? "cancels a delegated child and recovers" : "returns delegated child results and lineage"}`,
    async () => {
      await using tmp = await tmpdir()
      await Bun.write(
        path.join(tmp.path, "policy.json"),
        JSON.stringify({
          mode: "workspace",
          allow_subagents: true,
          rules: [{ tool: "*", path: "**", decision: "allow" }],
        }),
      )
      const bodies: unknown[] = []
      const ready = Promise.withResolvers<void>()
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          bodies.push(await request.json())
          if (bodies.length === 2 && cancel) {
            ready.resolve()
            return new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "text/event-stream" } })
          }
          const frame =
            bodies.length === 1
              ? {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "delegation",
                            type: "function",
                            function: {
                              name: "task",
                              arguments: JSON.stringify({
                                prompt: "isolated child prompt",
                                session_id: "ses_sdk_child",
                              }),
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                }
              : {
                  choices: [
                    {
                      index: 0,
                      delta: { content: bodies.length === 2 ? "CHILD-ANSWER" : "PARENT-ANSWER" },
                      finish_reason: "stop",
                    },
                  ],
                }
          return new Response(
            `data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        const updates: SessionNotification[] = []
        await using agent = await connectNativeACP(tmp.path, provider.url.toString(), {
          async requestPermission() {
            throw new Error("task is explicitly allowed")
          },
          async sessionUpdate(update) {
            updates.push(update)
          },
        })
        const parent = await agent.connection.newSession({ cwd: tmp.path, mcpServers: [] })
        const pending = agent.connection.prompt({
          sessionId: parent.sessionId,
          prompt: [{ type: "text", text: "delegate this task" }],
        })
        if (cancel) {
          await ready.promise
          await agent.connection.cancel({ sessionId: parent.sessionId })
          expect((await pending).stopReason).toBe("cancelled")
          expect(bodies).toHaveLength(2)
          expect(
            (
              await agent.connection.prompt({
                sessionId: parent.sessionId,
                prompt: [{ type: "text", text: "recover parent" }],
              })
            ).stopReason,
          ).toBe("end_turn")
          expect(JSON.stringify(bodies[2])).toContain("recover parent")
        } else {
          expect((await pending).stopReason).toBe("end_turn")
          expect(JSON.stringify(bodies[1])).toContain("isolated child prompt")
          expect(JSON.stringify(bodies[1])).not.toContain("delegate this task")
          expect(JSON.stringify(bodies[2])).toContain("CHILD-ANSWER")
        }
        expect(bodies).toHaveLength(3)
        expect(
          updates.some(
            (event) =>
              event.update.sessionUpdate === "agent_message_chunk" &&
              event.update.content.type === "text" &&
              event.update.content.text === "PARENT-ANSWER",
          ),
        ).toBe(true)
        const db = new Database(path.join(tmp.path, "engine.db"), { readonly: true })
        try {
          expect(
            db.query("SELECT parent_session_id FROM engine_lineage WHERE session_id='ses_sdk_child'").get(),
          ).toEqual({ parent_session_id: parent.sessionId })
          const stop = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.String }))(
            db.query("SELECT data FROM engine_event WHERE session_id=? AND kind='subagent_stop'").get(parent.sessionId),
          )
          expect(JSON.parse(stop.data)).toMatchObject({
            subagent_id: "ses_sdk_child",
            reason: cancel ? "interrupted" : "completed",
          })
          if (!cancel) expect(JSON.parse(stop.data)).toMatchObject({ tokens: { input: 7, output: 3 }, turns: 1 })
        } finally {
          db.close()
        }
      } finally {
        provider.stop(true)
      }
    },
    25_000,
  )
}
