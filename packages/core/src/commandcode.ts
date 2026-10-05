export * as CommandCode from "./commandcode"

import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { Deferred, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { IntegrationOAuthMethodRegistration } from "@miao/plugin/v2/effect/integration"
import { Credential } from "./credential"
import { Integration } from "./integration"

export const API = "https://api.commandcode.ai"
export const STUDIO = "https://commandcode.ai"
export const methodID = Integration.MethodID.make("oauth")
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

const User = Schema.Struct({
  success: Schema.Boolean,
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    userName: Schema.String,
  }),
})

const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      context_length: Schema.optional(Schema.Number),
    }),
  ),
})

export interface CatalogModel {
  readonly id: string
  readonly name?: string
  readonly contextLength?: number
}

/** Validate a Command Code API key and read the account it belongs to. */
export const whoami = (http: HttpClient.HttpClient, key: string) =>
  http
    .execute(
      HttpClientRequest.get(`${API}/alpha/whoami`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.setHeader("x-command-code-version", cliVersion),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(User)),
      Effect.map((value) => value.user),
    )

/** Fetch the live model list. API keys are per-plan, so this can 403 on Go. */
export const fetchModels = (http: HttpClient.HttpClient, key: string): Effect.Effect<ReadonlyArray<CatalogModel>> =>
  http
    .execute(
      HttpClientRequest.get(`${API}/provider/v1/models`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.setHeader("x-command-code-version", cliVersion),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelList)),
      Effect.map((value) =>
        value.data.map((model) => ({
          id: model.id,
          name: model.name,
          contextLength: model.context_length,
        })),
      ),
      Effect.catch(() => Effect.succeed([])),
    )

// Kept in sync with the CLI release the request headers advertise. The harness
// rejects requests that look like a proxy when this is missing.
const cliVersion = "1.74.1"

interface CallbackPayload {
  readonly apiKey: string
  readonly userId?: string
  readonly userName?: string
  readonly keyName?: string
}

const callbackCors = ["http://localhost:3000", "https://staging.commandcode.ai", STUDIO]
const allowedOrigin = (origin: string | undefined) => (origin && callbackCors.includes(origin) ? origin : STUDIO)

const corsHeaders = (origin: string | undefined) => ({
  "Access-Control-Allow-Origin": allowedOrigin(origin),
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
})

const readBody = (request: IncomingMessage) =>
  Effect.callback<string>((resume) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))))
    request.on("error", () => resume(Effect.succeed("")))
  })

const parseCallback = Schema.decodeUnknownSync(
  Schema.Struct({
    apiKey: Schema.String,
    state: Schema.String,
    userId: Schema.optional(Schema.String),
    userName: Schema.optional(Schema.String),
    keyName: Schema.optional(Schema.String),
  }),
)

/**
 * A single-use loopback server that receives the API key Command Code Studio
 * POSTs after the user authorizes in the browser. The browser may not be able
 * to reach `127.0.0.1`, so the GET page tells the user to paste the key in the
 * terminal instead; the caller keeps a manual-key fallback for that.
 */
const callbackServer = Effect.fn("CommandCode.callbackServer")(function* (state: string) {
  const deferred = yield* Deferred.make<CallbackPayload>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const headers = corsHeaders(request.headers.origin)
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers)
      response.end()
      return
    }
    if (url.pathname !== "/callback") {
      response.writeHead(404, { ...headers, "Content-Type": "application/json" })
      response.end(JSON.stringify({ success: false, error: "Not found" }))
      return
    }
    if (request.method === "GET") {
      response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      response.end(
        "<!doctype html><meta charset=utf-8><title>Command Code</title><body style='font:14px system-ui;padding:2rem'>" +
          "You can return to the terminal. If it is still waiting, paste your Command Code API key there.</body>",
      )
      return
    }
    Effect.runFork(
      readBody(request).pipe(
        Effect.flatMap((body) =>
          Effect.try({
            try: () => parseCallback(JSON.parse(body)) as CallbackPayload & { state: string },
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined))),
        ),
        Effect.flatMap((payload) => {
          if (!payload || payload.state !== state) {
            response.writeHead(403, { ...headers, "Content-Type": "application/json" })
            response.end(JSON.stringify({ success: false, error: "Invalid state token" }))
            return Effect.void
          }
          response.writeHead(200, { ...headers, "Content-Type": "application/json" })
          response.end(JSON.stringify({ success: true }))
          return Deferred.succeed(deferred, {
            apiKey: payload.apiKey,
            userId: payload.userId,
            userName: payload.userName,
            keyName: payload.keyName,
          })
        }),
      ),
    )
  })

  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.once("error", (error) => resume(Effect.die(error)))
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resume(Effect.succeed(typeof address === "object" && address ? address.port : 0))
      })
    }),
    () =>
      Effect.sync(() => {
        server.closeAllConnections?.()
        server.close()
      }),
  )

  return { port, callback: Deferred.await(deferred) }
})

/**
 * OAuth registration for Command Code. The "authorize" step is really a
 * browser-assisted API-key transfer: there is no token refresh, because the
 * API key never expires.
 */
export function oauth(http: HttpClient.HttpClient): IntegrationOAuthMethodRegistration {
  const grant = (key: string, meta: { userId?: string; userName?: string; keyName?: string }) =>
    grantCredential(http, key, meta)

  return {
    integrationID: "commandcode",
    method: { id: methodID, type: "oauth", label: "Command Code account" },
    authorize: () =>
      Effect.gen(function* () {
        const state = randomBytes(32).toString("base64url")
        const server = yield* callbackServer(state)
        const url = `${STUDIO}/studio/auth/cli?callback=${encodeURIComponent(
          `http://127.0.0.1:${server.port}/callback`,
        )}&state=${encodeURIComponent(state)}&mode=redirect`
        return {
          mode: "auto" as const,
          url,
          instructions: "Authorize in the browser. This window closes when done.",
          callback: server.callback.pipe(Effect.flatMap((payload) => grant(payload.apiKey, payload))),
        }
      }),
    refresh: (credential) => Effect.succeed(credential),
    label: (credential) =>
      typeof credential.metadata?.userName === "string" ? credential.metadata.userName : undefined,
  }
}

/** Validate a login API key and build the credential the integration stores. */
export const grantCredential = (
  http: HttpClient.HttpClient,
  key: string,
  meta: { userId?: string; userName?: string; keyName?: string },
) =>
  Effect.gen(function* () {
    const user = yield* whoami(http, key)
    return Credential.OAuth.make({
      type: "oauth" as const,
      methodID,
      access: key,
      refresh: key,
      expires: Date.now() + TEN_YEARS_MS,
      metadata: {
        userId: meta.userId ?? user.id,
        userName: meta.userName ?? user.userName,
        email: user.email,
        keyName: meta.keyName,
      },
    })
  })

/**
 * Run the browser-assisted login outside an `IntegrationOAuthMethodRegistration`
 * scope, for the V1 auth hook which keeps the loopback server alive across its
 * separate `authorize` and `callback` calls.
 */
export const authorizeDetached = Effect.fn("CommandCode.authorizeDetached")(function* () {
  const state = randomBytes(32).toString("base64url")
  const server = yield* callbackServer(state)
  const url = `${STUDIO}/studio/auth/cli?callback=${encodeURIComponent(
    `http://127.0.0.1:${server.port}/callback`,
  )}&state=${encodeURIComponent(state)}&mode=redirect`
  return {
    url,
    instructions: "Authorize in the browser, then paste your Command Code API key if the terminal still waits.",
    callback: server.callback,
    close: () => Effect.void,
  }
})


