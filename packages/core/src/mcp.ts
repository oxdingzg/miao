export * as MCP from "./mcp"

import { Client } from "@modelcontextprotocol/sdk/client"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ToolFailure } from "@miao/llm"
import { Effect, JsonSchema, Layer } from "effect"
import { Config } from "./config"
import type { ConfigMCP } from "./config/mcp"
import { makeLocationNode } from "./effect/app-node"
import { ToolRegistry } from "./tool/registry"
import { Tool } from "./tool/tool"
import type { AnyTool } from "./tool/tool"
import { Tools } from "./tool/tools"

const MAX_TOOL_NAME = 64
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Sanitize an MCP tool name into the canonical tool-name alphabet. */
export const toolName = (serverID: string, tool: string) =>
  `mcp__${serverID}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME)

type Connected = {
  readonly client: Client
  readonly tools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>
}

const connect = (server: ConfigMCP.Local | ConfigMCP.Remote): Effect.Effect<Connected, unknown> =>
  Effect.gen(function* () {
    const client = new Client({ name: "miao", version: "1.0.0" }, { capabilities: {} })
    const transport =
      server.type === "local"
        ? new StdioClientTransport({
            command: server.command[0],
            args: server.command.slice(1),
            cwd: server.cwd,
            env: Object.assign({}, process.env, server.environment) as Record<string, string>,
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: server.headers ? { headers: server.headers } : undefined,
          })
    yield* Effect.tryPromise({ try: () => client.connect(transport), catch: (error) => error })
    const listed = yield* Effect.tryPromise({ try: () => client.listTools(), catch: (error) => error })
    return { client, tools: listed.tools }
  })

const resultContent = (result: { content?: ReadonlyArray<unknown> }): ReadonlyArray<Tool.Content> =>
  (result.content ?? []).flatMap((item): Tool.Content[] => {
    if (typeof item !== "object" || item === null) return []
    const part = item as Record<string, unknown>
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
    if (part.type === "image" && typeof part.data === "string")
      return [{ type: "file", data: part.data, mime: typeof part.mimeType === "string" ? part.mimeType : "image/png" }]
    if (part.type === "resource" && typeof part.text === "string") return [{ type: "text", text: part.text }]
    return []
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const tools = yield* Tools.Service

    const entries = yield* config.entries()
    let mcp: ConfigMCP.Info | undefined
    for (const entry of entries) if (entry.type === "document" && entry.info.mcp !== undefined) mcp = entry.info.mcp
    if (mcp?.servers === undefined) return

    // Canonical names are registered in a deterministic order so a reconnect or a
    // server listing the same tool twice cannot change the advertised tool set.
    const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    const registered = new Set<string>()
    for (const [serverID, server] of Object.entries(mcp.servers).toSorted(([a], [b]) => compareNames(a, b))) {
      if (server.disabled === true) continue
      const connected = yield* connect(server as ConfigMCP.Local | ConfigMCP.Remote).pipe(
        Effect.orElseSucceed(() => undefined as Connected | undefined),
      )
      if (connected === undefined) continue
      const registrations: Record<string, AnyTool> = {}
      for (const tool of [...connected.tools].toSorted((a, b) => compareNames(a.name, b.name))) {
        const name = toolName(serverID, tool.name)
        if (!NAME_PATTERN.test(name) || registered.has(name)) continue
        registered.add(name)
        registrations[name] = Tool.makeExternal({
          description: tool.description ?? `MCP tool ${tool.name} from ${serverID}`,
          inputSchema: (tool.inputSchema as JsonSchema.JsonSchema | undefined) ?? { type: "object" },
          execute: (input) =>
            Effect.tryPromise({
              try: () => connected.client.callTool({ name: tool.name, arguments: input }),
              catch: (error) => new ToolFailure({ message: `MCP call ${tool.name} failed: ${String(error)}` }),
            }).pipe(Effect.map((result) => resultContent(result as { content?: ReadonlyArray<unknown> }))),
        })
      }
      if (Object.keys(registrations).length > 0) yield* tools.register(registrations).pipe(Effect.orDie)
    }
  }),
)

export const node = makeLocationNode({
  name: "mcp/tools",
  layer,
  deps: [Config.node, ToolRegistry.toolsNode],
})
