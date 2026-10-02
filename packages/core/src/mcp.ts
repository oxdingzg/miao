export * as MCP from "./mcp"

import { Client } from "@modelcontextprotocol/sdk/client"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ToolFailure } from "@miao/llm"
import { Resource, Status } from "@miao/schema/mcp"
import { Context, Effect, Exit, JsonSchema, Layer, Schema, Scope } from "effect"
import path from "node:path"
import { Config } from "./config"
import type { ConfigMCP } from "./config/mcp"
import { makeLocationNode } from "./effect/app-node"
import { InstallationVersion } from "./installation/version"
import { Location } from "./location"
import { PermissionV2 } from "./permission"
import { ToolRegistry } from "./tool/registry"
import { Tool } from "./tool/tool"
import type { AnyTool } from "./tool/tool"
import { Tools } from "./tool/tools"

export { Resource, Status }

export type Server = ConfigMCP.Local | ConfigMCP.Remote

const MAX_TOOL_NAME = 64
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const DEFAULT_TIMEOUT = 30_000

/**
 * Memory guard, not a content policy: a server must not be able to make us copy
 * an unbounded string. Images under this size are carried through and shrunk to
 * the configured image budget before they reach the model, so the ceiling only
 * has to sit above what shrinking could still rescue.
 */
export const MAX_RESULT_IMAGE_BASE64_BYTES = 32 * 1024 * 1024

/** Sanitize an MCP tool name into the canonical tool-name alphabet. */
export const toolName = (serverID: string, tool: string) =>
  `mcp__${serverID}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME)

/**
 * The V1 name of an MCP tool. V1 asked permission under this action, so rules a
 * user already wrote for it (for example `"github_*": "deny"`) must keep
 * deciding the same tool under V2.
 */
export const legacyToolName = (serverID: string, tool: string) =>
  `${serverID.replace(/[^A-Za-z0-9_-]/g, "_")}_${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`

type Connected = {
  readonly client: Client
  readonly tools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>
  readonly resources: ReadonlyArray<ResourceInfo>
}

type ResourceInfo = Awaited<ReturnType<Client["listResources"]>>["resources"][number]

export const resultContent = (result: { content?: ReadonlyArray<unknown> }): ReadonlyArray<Tool.Content> =>
  (result.content ?? []).flatMap((item): Tool.Content[] => {
    if (typeof item !== "object" || item === null) return []
    const part = item as Record<string, unknown>
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
    if (part.type === "image" && typeof part.data === "string") {
      if (part.data.length > MAX_RESULT_IMAGE_BASE64_BYTES)
        return [
          {
            type: "text",
            text: `[image result omitted: base64 payload of ${part.data.length} bytes exceeds ${MAX_RESULT_IMAGE_BASE64_BYTES} bytes]`,
          },
        ]
      return [{ type: "file", data: part.data, mime: typeof part.mimeType === "string" ? part.mimeType : "image/png" }]
    }
    if (part.type === "resource" && typeof part.text === "string") return [{ type: "text", text: part.text }]
    return []
  })

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly add: (name: string, server: Server) => Effect.Effect<Record<string, Status>, NotFoundError>
  readonly remove: (name: string) => Effect.Effect<Record<string, Status>>
  readonly resources: () => Effect.Effect<Record<string, Resource>>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/MCP") {}

function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label ?? `Operation timed out after ${ms}ms`)), ms)
    }),
  ])
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const MAX_LIST_PAGES = 1_000

// Mirror the V1 MCP catalog: only ask servers that advertise resources, and walk
// every page so a large catalog is not silently truncated.
async function listResources(client: Client, timeout?: number): Promise<ResourceInfo[]> {
  if (!client.getServerCapabilities()?.resources) return []
  const result: ResourceInfo[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await client.listResources(cursor === undefined ? undefined : { cursor }, { timeout })
    result.push(...listed.resources)
    if (listed.nextCursor === undefined) return result
    if (cursors.has(listed.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${listed.nextCursor}`)
    cursors.add(listed.nextCursor)
    cursor = listed.nextCursor
  }
  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

function connectLocal(server: ConfigMCP.Local, directory: string): Effect.Effect<{ status: Status; connected?: Connected }> {
  const [command, ...args] = server.command
  return Effect.gen(function* () {
    if (command === undefined)
      return { status: { status: "failed", error: "MCP local server has no command" } satisfies Status }
    const cwd = server.cwd ? path.resolve(directory, server.cwd) : undefined
    const transport = new StdioClientTransport({
      command,
      args,
      cwd,
      env: Object.assign({}, process.env, server.environment) as Record<string, string>,
      stderr: "ignore",
    })
    const client = new Client({ name: "miao", version: InstallationVersion }, { capabilities: {} })
    const outcome = yield* Effect.tryPromise({
      try: async () => {
        await withTimeout(client.connect(transport), server.timeout?.startup ?? DEFAULT_TIMEOUT)
        const listed = await client.listTools().catch(() => ({ tools: [] as Connected["tools"] }))
        const resources = await listResources(client, server.timeout?.request).catch(() => [] as ResourceInfo[])
        return { client, tools: listed.tools, resources } satisfies Connected
      },
      catch: (error) => error,
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (connected) => ({ ok: true as const, connected }),
      }),
    )
    if (outcome.ok) return { status: { status: "connected" } satisfies Status, connected: outcome.connected }
    yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    return { status: { status: "failed", error: message(outcome.error) } satisfies Status }
  })
}

function connectRemote(server: ConfigMCP.Remote): Effect.Effect<{ status: Status; connected?: Connected }> {
  return Effect.gen(function* () {
    const url = URL.canParse(server.url) ? new URL(server.url) : undefined
    if (!url) return { status: { status: "failed", error: `Invalid MCP URL "${server.url}"` } satisfies Status }
    const requestInit = server.headers ? { headers: server.headers } : undefined
    const transports = [
      { name: "StreamableHTTP", transport: new StreamableHTTPClientTransport(url, { requestInit }) },
      { name: "SSE", transport: new SSEClientTransport(url, { requestInit }) },
    ]
    let last: Status = { status: "failed", error: "Unknown error" }
    for (const { transport } of transports) {
      const client = new Client({ name: "miao", version: InstallationVersion }, { capabilities: {} })
      const outcome = yield* Effect.tryPromise({
        try: async () => {
          await withTimeout(client.connect(transport), server.timeout?.startup ?? DEFAULT_TIMEOUT)
          const listed = await client.listTools().catch(() => ({ tools: [] as Connected["tools"] }))
          const resources = await listResources(client, server.timeout?.request).catch(() => [] as ResourceInfo[])
          return { client, tools: listed.tools, resources } satisfies Connected
        },
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (connected) => ({ ok: true as const, connected }),
        }),
      )
      if (outcome.ok) return { status: { status: "connected" } satisfies Status, connected: outcome.connected }
      yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      last = classifyRemoteFailure(outcome.error)
      // An auth failure is terminal for this connection attempt: retrying the
      // fallback transport cannot succeed without credentials.
      if (last.status === "needs_auth" || last.status === "needs_client_registration") break
    }
    return { status: last }
  })
}

function classifyRemoteFailure(error: unknown): Status {
  const text = message(error)
  if (error instanceof UnauthorizedError || text.includes("OAuth")) {
    if (text.includes("registration") || text.includes("client_id"))
      return {
        status: "needs_client_registration",
        error: "Server does not support dynamic client registration. Please provide clientId in config.",
      }
    return { status: "needs_auth" }
  }
  return { status: "failed", error: text }
}

function connectServer(server: Server, directory: string) {
  return server.type === "local" ? connectLocal(server, directory) : connectRemote(server)
}

const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function buildTools(
  serverID: string,
  connected: Connected,
  permission: PermissionV2.Interface,
  registered: Set<string>,
): Record<string, AnyTool> {
  const registrations: Record<string, AnyTool> = {}
  for (const tool of [...connected.tools].toSorted((a, b) => compareNames(a.name, b.name))) {
    // Canonical names are registered in a deterministic order so a reconnect or a
    // server listing the same tool twice cannot change the advertised tool set.
    const name = toolName(serverID, tool.name)
    if (!NAME_PATTERN.test(name) || registered.has(name)) continue
    registered.add(name)
    const legacy = legacyToolName(serverID, tool.name)
    registrations[name] = Tool.makeExternal({
      description: tool.description ?? `MCP tool ${tool.name} from ${serverID}`,
      inputSchema: (tool.inputSchema as JsonSchema.JsonSchema | undefined) ?? { type: "object" },
      permissionAliases: [legacy],
      execute: (input, context) =>
        permission
          .assert({
            action: name,
            aliases: [legacy],
            resources: ["*"],
            save: ["*"],
            metadata: { server: serverID, tool: tool.name, input },
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          .pipe(
            Effect.catchTags({
              "PermissionV2.BlockedError": (error) =>
                Effect.fail(
                  new ToolFailure({
                    message: `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(error.rules)}`,
                  }),
                ),
              "PermissionV2.CorrectedError": (error) =>
                Effect.fail(
                  new ToolFailure({
                    message: `The user rejected permission to use this specific tool call with the following feedback: ${error.feedback}`,
                  }),
                ),
              "Session.NotFoundError": () =>
                Effect.fail(new ToolFailure({ message: `MCP call ${tool.name} failed: session not found` })),
            }),
            Effect.andThen(
              Effect.tryPromise({
                try: () => connected.client.callTool({ name: tool.name, arguments: input }),
                catch: (error) => new ToolFailure({ message: `MCP call ${tool.name} failed: ${String(error)}` }),
              }),
            ),
            Effect.map((result) => resultContent(result as { content?: ReadonlyArray<unknown> })),
          ),
    })
  }
  return registrations
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service

    const scope = yield* Scope.make()
    const servers = new Map<string, Server>()
    const statuses = new Map<string, Status>()
    const clients = new Map<string, Client>()
    const scopes = new Map<string, Scope.Closeable>()
    const toolNames = new Map<string, string[]>()
    const resourcesByServer = new Map<string, ReadonlyArray<ResourceInfo>>()
    const registered = new Set<string>()

    const entries = yield* config.entries()
    let info: ConfigMCP.Info | undefined
    for (const entry of entries) if (entry.type === "document" && entry.info.mcp !== undefined) info = entry.info.mcp
    for (const [name, server] of Object.entries(info?.servers ?? {})) servers.set(name, server)

    const closeServer = Effect.fnUntraced(function* (name: string, exit: Exit.Exit<unknown, unknown>) {
      const child = scopes.get(name)
      scopes.delete(name)
      const client = clients.get(name)
      clients.delete(name)
      for (const tool of toolNames.get(name) ?? []) registered.delete(tool)
      toolNames.delete(name)
      resourcesByServer.delete(name)
      if (child) yield* Scope.close(child, exit).pipe(Effect.ignore)
      if (client) yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const server = servers.get(name)
      if (server === undefined) return yield* new NotFoundError({ name })
      const result = yield* connectServer(server, location.directory)
      yield* closeServer(name, Exit.void)
      statuses.set(name, result.status)
      if (result.connected === undefined) return
      const registrations = buildTools(name, result.connected, permission, registered)
      if (Object.keys(registrations).length > 0) {
        const child = yield* Scope.fork(scope)
        yield* tools.register(registrations).pipe(Scope.provide(child), Effect.orDie)
        scopes.set(name, child)
        toolNames.set(name, Object.keys(registrations))
      }
      clients.set(name, result.connected.client)
      resourcesByServer.set(name, result.connected.resources)
    })

    for (const [name, server] of servers) {
      if (server.disabled === true) {
        statuses.set(name, { status: "disabled" })
        continue
      }
      const result = yield* connectServer(server, location.directory)
      statuses.set(name, result.status)
      if (result.connected === undefined) continue
      const registrations = buildTools(name, result.connected, permission, registered)
      if (Object.keys(registrations).length > 0) {
        const child = yield* Scope.fork(scope)
        yield* tools.register(registrations).pipe(Scope.provide(child), Effect.orDie)
        scopes.set(name, child)
        toolNames.set(name, Object.keys(registrations))
      }
      clients.set(name, result.connected.client)
      resourcesByServer.set(name, result.connected.resources)
    }

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        const names = [...clients.keys()]
        yield* Effect.forEach(names, (name) => closeServer(name, exit), { discard: true })
        yield* Scope.close(scope, exit).pipe(Effect.ignore)
      }),
    )

    const status = Effect.fn("MCP.status")(function* () {
      const result: Record<string, Status> = {}
      for (const name of servers.keys()) result[name] = statuses.get(name) ?? { status: "disabled" }
      return result
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      const result: Record<string, Resource> = {}
      for (const [serverID, listed] of resourcesByServer) {
        if (statuses.get(serverID)?.status !== "connected") continue
        // Escape the separator and escape marker so a server id containing `:`
        // cannot make the `server:uri` keys ambiguous, matching the V1 catalog.
        const escaped = serverID.replaceAll("%", "%25").replaceAll(":", "%3A")
        for (const resource of listed) {
          result[`${escaped}:${resource.uri}`] = {
            name: resource.name,
            uri: resource.uri,
            ...(resource.description !== undefined ? { description: resource.description } : {}),
            ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
            client: serverID,
          }
        }
      }
      return result
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      if (servers.get(name) === undefined) return yield* new NotFoundError({ name })
      yield* closeServer(name, Exit.void)
      statuses.set(name, { status: "disabled" })
    })

    const add = Effect.fn("MCP.add")(function* (name: string, server: Server) {
      servers.set(name, server)
      yield* connect(name)
      return yield* status()
    })

    const remove = Effect.fn("MCP.remove")(function* (name: string) {
      yield* closeServer(name, Exit.void)
      servers.delete(name)
      statuses.delete(name)
      return yield* status()
    })

    return Service.of({
      status,
      connect,
      disconnect,
      add,
      remove,
      resources,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, ToolRegistry.toolsNode, PermissionV2.node],
})
