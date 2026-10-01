export * as LSP from "./lsp"

import path from "path"
import { spawn } from "node:child_process"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { Location } from "./location"
import { FSUtil } from "./fs-util"
import { which } from "./util/which"
import { makeLocationNode } from "./effect/app-node"
import { LSPClient, type Diagnostic } from "./lsp/client"
import { LSPServer } from "./lsp/server"

export type { Diagnostic }

export interface Status {
  readonly id: string
  readonly extensions: ReadonlyArray<string>
  readonly connected: boolean
}

export interface Interface {
  readonly status: () => Effect.Effect<Status[]>
  /** Diagnostics indexed by file URI, as reported by every connected server. */
  readonly diagnostics: () => Effect.Effect<Record<string, ReadonlyArray<Diagnostic>>>
  /** Opens or refreshes a file in every matching server and waits briefly for diagnostics. */
  readonly touchFile: (file: string, mode?: "document" | "full") => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/LSP") {}

/**
 * A server that failed a startup request, most often because its process exited.
 * Language servers are advisory: one that dies must not fail the mutation that
 * touched the file, so this is a typed failure callers can ignore rather than a
 * defect, which would tear down the tool and every tool settled alongside it.
 */
export class ServerUnavailableError extends Schema.TaggedErrorClass<ServerUnavailableError>()(
  "LSP.ServerUnavailableError",
  { server: Schema.String, message: Schema.String },
) {}

type Resolved = {
  readonly id: string
  readonly command: ReadonlyArray<string>
  readonly extensions: ReadonlyArray<string>
  readonly environment?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}

const DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const FULL_WAIT_TIMEOUT_MS = 10_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service

    const entries = yield* config.entries()
    let configured: Config.Info["lsp"]
    for (const entry of entries) if (entry.type === "document" && entry.info.lsp !== undefined) configured = entry.info.lsp

    const servers = new Map<string, Resolved>()
    if (configured) {
      for (const server of LSPServer.servers)
        servers.set(server.id, {
          id: server.id,
          command: server.command,
          extensions: server.extensions,
          environment: server.environment,
          initialization: server.initialization,
        })
      if (configured !== true) {
        for (const [id, override] of Object.entries(configured)) {
          if (override.disabled === true) {
            servers.delete(id)
            continue
          }
          if (!("command" in override)) continue
          servers.set(id, {
            id,
            command: override.command,
            extensions: override.extensions ?? servers.get(id)?.extensions ?? [],
            environment: override.env,
            initialization: override.initialization,
          })
        }
      }
    }

    const clients = new Map<string, LSPClient.Connection>()
    const diagnosticsByURI = new Map<string, ReadonlyArray<Diagnostic>>()
    const waiters = new Map<string, (diagnostics: ReadonlyArray<Diagnostic>) => void>()

    const ensure = Effect.fnUntraced(function* (server: Resolved) {
      const existing = clients.get(server.id)
      if (existing) return existing
      const bin = which(server.command[0]!)
      if (!bin) return undefined
      const proc = spawn(bin, server.command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.assign({}, process.env, server.environment),
      })
      if (!proc.stdin || !proc.stdout) return undefined
      const connection = new LSPClient.Connection({
        stdin: proc.stdin,
        stdout: proc.stdout,
        kill: () => proc.kill(),
        onExit: (listener) => proc.on("exit", () => listener()),
      })
      connection.onNotification("textDocument/publishDiagnostics", (params) => {
        const payload = params as { readonly uri?: string; readonly diagnostics?: ReadonlyArray<Diagnostic> }
        if (typeof payload?.uri !== "string") return
        const items = payload.diagnostics ?? []
        diagnosticsByURI.set(payload.uri, items)
        waiters.get(payload.uri)?.(items)
      })
      // A server that exits mid-handshake rejects this request. `Effect.promise`
      // would turn that rejection into a defect, which no caller can ignore and
      // which fails every tool settled in the same batch, so the rejection is
      // typed and absorbed here: the touch simply finds no server to use.
      const initialized = yield* Effect.tryPromise({
        try: () =>
          connection.request("initialize", {
            processId: process.pid,
            rootUri: LSPClient.fileURI(location.directory),
            capabilities: {},
            initializationOptions: server.initialization,
          }),
        catch: (cause) =>
          new ServerUnavailableError({
            server: server.id,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(Effect.option)
      if (initialized._tag === "None") {
        // Drop the unusable connection so the child process does not outlive it
        // and the next touch can start a fresh one.
        connection.close()
        return undefined
      }
      connection.notify("initialized", {})
      clients.set(server.id, connection)
      return connection
    })

    const waitFor = (uri: string, timeoutMs: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(uri)
          resolve()
        }, timeoutMs)
        waiters.set(uri, () => {
          clearTimeout(timer)
          waiters.delete(uri)
          resolve()
        })
      })

    const touchFile = Effect.fn("LSP.touchFile")(function* (file: string, mode?: "document" | "full") {
      const extension = path.extname(file)
      const matching = [...servers.values()].filter((server) => server.extensions.includes(extension))
      if (matching.length === 0) return
      const text = (yield* fs.readFileStringSafe(file).pipe(Effect.orDie)) ?? ""
      const uri = LSPClient.fileURI(file)
      for (const server of matching) {
        const connection = yield* ensure(server)
        if (!connection) continue
        const wait = waitFor(uri, mode === "full" ? FULL_WAIT_TIMEOUT_MS : DOCUMENT_WAIT_TIMEOUT_MS)
        connection.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: LSPServer.languageOf(file), version: 1, text },
        })
        yield* Effect.promise(() => wait)
      }
    })

    return Service.of({
      status: () =>
        Effect.sync(() =>
          [...servers.values()].map((server) => ({
            id: server.id,
            extensions: server.extensions,
            connected: clients.has(server.id),
          })),
        ),
      diagnostics: () => Effect.sync(() => Object.fromEntries(diagnosticsByURI)),
      touchFile,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, FSUtil.node],
})
