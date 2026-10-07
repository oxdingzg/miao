export * as LSP from "./lsp"

import path from "path"
import { spawn } from "node:child_process"
import { Context, Effect, Layer, Option, Schema, Scope } from "effect"
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

/** A language-server cursor location. Both numbers are zero-based, as LSP defines them. */
export interface LocationInput {
  readonly file: string
  readonly line: number
  readonly character: number
}

export interface Interface {
  readonly status: () => Effect.Effect<Status[]>
  /** Diagnostics indexed by file URI, as reported by every connected server. */
  readonly diagnostics: () => Effect.Effect<Record<string, ReadonlyArray<Diagnostic>>>
  /** Opens or refreshes a file in every matching server and waits briefly for diagnostics. */
  readonly touchFile: (file: string, mode?: "document" | "full") => Effect.Effect<void>
  /** Starts a background {@link touchFile} for a file that was only read; returns immediately. */
  readonly warm: (file: string, mode?: "document" | "full") => Effect.Effect<void>
  /** Whether any configured server advertises the file's extension. */
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly definition: (input: LocationInput) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly references: (input: LocationInput) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly hover: (input: LocationInput) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly documentSymbol: (file: string) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly workspaceSymbol: (
    file: string,
    query: string,
  ) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly implementation: (input: LocationInput) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly prepareCallHierarchy: (
    input: LocationInput,
  ) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly incomingCalls: (input: LocationInput) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
  readonly outgoingCalls: (input: LocationInput) => Effect.Effect<ReadonlyArray<unknown>, RequestUnavailableError>
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

/**
 * Every server that matched a navigation request was unavailable, exited, or
 * timed out. Distinguishing this from a legitimate empty result lets a caller
 * report "no language server answered" instead of the misleading "no results".
 */
export class RequestUnavailableError extends Schema.TaggedErrorClass<RequestUnavailableError>()(
  "LSP.RequestUnavailableError",
  { operation: Schema.String, servers: Schema.Array(Schema.String) },
) {
  override get message() {
    const tried = this.servers.length > 0 ? this.servers.join(", ") : "no matching server"
    return `No language server answered ${this.operation} (tried ${tried}).`
  }
}

type Resolved = {
  readonly id: string
  readonly command: ReadonlyArray<string>
  readonly extensions: ReadonlyArray<string>
  readonly environment?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}

const DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const FULL_WAIT_TIMEOUT_MS = 10_000
/** Upper bound on a single language-server request, so a hung server cannot pin a tool. */
const REQUEST_TIMEOUT_MS = 10_000
/** Symbol kinds V1 reported for `workspaceSymbol`, and how many each server may return. */
const WORKSPACE_SYMBOL_KINDS = new Set([5, 6, 10, 11, 12, 13, 14, 23])
const WORKSPACE_SYMBOL_LIMIT = 10

const isWorkspaceSymbol = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const kind = (value as { readonly kind?: unknown }).kind
  return typeof kind === "number" && WORKSPACE_SYMBOL_KINDS.has(kind)
}

/** Flattens one result per server into the single list V1 reported, dropping empty entries. */
const flatten = (results: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  results.flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item) => item !== null && item !== undefined)
      : value === null || value === undefined
        ? []
        : [value],
  )

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const scope = yield* Scope.Scope

    const entries = yield* config.entries()
    let configured: Config.Info["lsp"]
    for (const entry of entries)
      if (entry.type === "document" && entry.info.lsp !== undefined) configured = entry.info.lsp

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
    /** Per server+document open state, so a re-touch becomes a change instead of a duplicate open. */
    const opened = new Map<string, number>()

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
          connection.request(
            "initialize",
            {
              processId: process.pid,
              rootUri: LSPClient.fileURI(location.directory),
              capabilities: {},
              initializationOptions: server.initialization,
            },
            { timeoutMs: REQUEST_TIMEOUT_MS },
          ),
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

    /**
     * Opens the document on a connection, or sends the updated text when it is
     * already open. Read before notifying so the server sees current content.
     */
    const openDocument = Effect.fnUntraced(function* (
      server: Resolved,
      connection: LSPClient.Connection,
      file: string,
    ) {
      const uri = LSPClient.fileURI(file)
      const key = `${server.id}\u0000${uri}`
      const version = (opened.get(key) ?? 0) + 1
      opened.set(key, version)
      const text = (yield* fs.readFileStringSafe(file).pipe(Effect.orDie)) ?? ""
      if (version === 1)
        connection.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: LSPServer.languageOf(file), version, text },
        })
      else
        connection.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        })
      return uri
    })

    /** Every matching connection for a file with its document opened, plus ids that failed to start. */
    const connectionsFor = Effect.fnUntraced(function* (file: string) {
      const extension = path.extname(file)
      const live: Array<{
        readonly serverID: string
        readonly connection: LSPClient.Connection
        readonly uri: string
      }> = []
      const failed: string[] = []
      for (const server of servers.values()) {
        if (!server.extensions.includes(extension)) continue
        const connection = yield* ensure(server)
        if (!connection) {
          failed.push(server.id)
          continue
        }
        live.push({ serverID: server.id, connection, uri: yield* openDocument(server, connection, file) })
      }
      return { live, failed }
    })

    // A server rejection or timeout is absorbed into `None` here; the caller
    // decides whether the aggregate is a partial success or a surfaced failure.
    const requestValue = (connection: LSPClient.Connection, method: string, params: unknown) =>
      Effect.tryPromise({
        try: () => connection.request(method, params, { timeoutMs: REQUEST_TIMEOUT_MS }),
        catch: (cause) => cause,
      }).pipe(Effect.option)

    /**
     * Runs one request across every matching server. A server that answers —
     * even with an empty list — counts as success; only when nothing answers
     * does the aggregate fail, so a partial success still returns its results.
     */
    const runOnFile = Effect.fnUntraced(function* (file: string, method: string, params: (uri: string) => unknown) {
      const { live, failed } = yield* connectionsFor(file)
      const failures = [...failed]
      const results: unknown[] = []
      let answered = 0
      for (const item of live) {
        const value = yield* requestValue(item.connection, method, params(item.uri))
        if (Option.isNone(value)) {
          failures.push(item.serverID)
          continue
        }
        answered++
        results.push(value.value)
      }
      if (answered === 0) return yield* new RequestUnavailableError({ operation: method, servers: failures })
      return flatten(results)
    })

    const locationRequest = (method: string) =>
      Effect.fn(`LSP.${method}`)(function* (input: LocationInput) {
        return yield* runOnFile(input.file, method, (uri) => ({
          textDocument: { uri },
          position: { line: input.line, character: input.character },
        }))
      })

    const touchFile = Effect.fn("LSP.touchFile")(function* (file: string, mode?: "document" | "full") {
      const extension = path.extname(file)
      const matching = [...servers.values()].filter((server) => server.extensions.includes(extension))
      if (matching.length === 0) return
      const uri = LSPClient.fileURI(file)
      for (const server of matching) {
        const connection = yield* ensure(server)
        if (!connection) continue
        // Register the waiter before opening so diagnostics published during the
        // open are not missed, then wait for the server to report on this file.
        const wait = waitFor(uri, mode === "full" ? FULL_WAIT_TIMEOUT_MS : DOCUMENT_WAIT_TIMEOUT_MS)
        yield* openDocument(server, connection, file)
        yield* Effect.promise(() => wait)
      }
    })

    // Fire-and-forget warm-up for a file a tool merely read: primes the
    // connection and its diagnostics so a follow-up edit's synchronous touch is
    // already served. Runs in the LSP node's own scope, so it never outlives
    // the location and never fails the reader that started it.
    const warm = (file: string, mode?: "document" | "full") =>
      touchFile(file, mode).pipe(Effect.ignoreCause, Effect.forkIn(scope), Effect.asVoid)

    const definition = locationRequest("textDocument/definition")
    const references = locationRequest("textDocument/references")
    const hover = locationRequest("textDocument/hover")
    const implementation = locationRequest("textDocument/implementation")
    const prepareCallHierarchy = locationRequest("textDocument/prepareCallHierarchy")

    const callHierarchy = Effect.fnUntraced(function* (input: LocationInput, direction: string) {
      const { live, failed } = yield* connectionsFor(input.file)
      const failures = [...failed]
      const results: unknown[] = []
      let answered = 0
      for (const item of live) {
        const prepared = yield* requestValue(item.connection, "textDocument/prepareCallHierarchy", {
          textDocument: { uri: item.uri },
          position: { line: input.line, character: input.character },
        })
        if (Option.isNone(prepared)) {
          failures.push(item.serverID)
          continue
        }
        const items: ReadonlyArray<unknown> = Array.isArray(prepared.value) ? prepared.value : []
        const first = items.find((entry) => entry !== null && entry !== undefined)
        // An empty prepare result is a legitimate "no call hierarchy" answer.
        if (first === undefined) {
          answered++
          continue
        }
        const calls = yield* requestValue(item.connection, direction, { item: first })
        if (Option.isNone(calls)) {
          failures.push(item.serverID)
          continue
        }
        answered++
        results.push(calls.value)
      }
      if (answered === 0) return yield* new RequestUnavailableError({ operation: direction, servers: failures })
      return flatten(results)
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
      warm,
      hasClients: Effect.fn("LSP.hasClients")(function* (file: string) {
        const extension = path.extname(file)
        return [...servers.values()].some((server) => server.extensions.includes(extension))
      }),
      definition,
      references,
      hover,
      documentSymbol: Effect.fn("LSP.documentSymbol")(function* (file: string) {
        return yield* runOnFile(file, "textDocument/documentSymbol", (uri) => ({ textDocument: { uri } }))
      }),
      workspaceSymbol: Effect.fn("LSP.workspaceSymbol")(function* (file: string, query: string) {
        // Mirror V1: start the file's matching server, then query every
        // connected server so symbols from other open projects still surface.
        const { live, failed } = yield* connectionsFor(file)
        const target = new Map<string, LSPClient.Connection>()
        for (const item of live) target.set(item.serverID, item.connection)
        for (const [id, connection] of clients) if (!target.has(id)) target.set(id, connection)
        const failures = [...failed]
        const results: unknown[] = []
        let answered = 0
        for (const [id, connection] of target) {
          const value = yield* requestValue(connection, "workspace/symbol", { query })
          if (Option.isNone(value)) {
            failures.push(id)
            continue
          }
          answered++
          const symbols: ReadonlyArray<unknown> = Array.isArray(value.value) ? value.value : []
          results.push(...symbols.filter(isWorkspaceSymbol).slice(0, WORKSPACE_SYMBOL_LIMIT))
        }
        if (answered === 0)
          return yield* new RequestUnavailableError({ operation: "workspace/symbol", servers: failures })
        return results
      }),
      implementation,
      prepareCallHierarchy,
      incomingCalls: (input) => callHierarchy(input, "callHierarchy/incomingCalls"),
      outgoingCalls: (input) => callHierarchy(input, "callHierarchy/outgoingCalls"),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, FSUtil.node],
})
