import { makeGlobalNode } from "@miao/core/effect/app-node"
import { ClientEvents } from "@miao/server/client-events"
import { NativeEngine } from "@miao/server/native-engine"
import { ConflictError } from "@miao/protocol/errors"
import { Location } from "@miao/schema/location"
import { Effect, Layer } from "effect"
import { EngineError, type EngineOptions } from "./client"
import { makeEngineOwners } from "./owners"

/**
 * Production native transport, opt-in through the engine binary environment:
 * without `MIAO_ENGINE_BIN` the layer is never built and native-owned Sessions
 * keep the explicit refusal. The model identity is required from the operator
 * because the engine cannot invent provider credentials or catalog facts.
 */
/**
 * Provider keys the engine reads from its environment when no credential
 * database is configured. Named one by one so an unrelated secret in the
 * operator's environment never reaches the child.
 */
const PROVIDER_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ACCESS_TOKEN",
  "OPENAI_ACCOUNT_ID",
  "GEMINI_API_KEY",
] as const

/**
 * Engine deployment knobs the operator may set for the child. Passed by name so
 * the explicit channel keeps working for them now that the child no longer
 * inherits the whole environment.
 */
const ENGINE_ENVIRONMENT = [
  "MIAO_ENGINE_VERSION",
  "MIAO_ENGINE_HTTP_TOKEN",
  "MIAO_LLM_FIRST_BYTE_TIMEOUT_MS",
  "MIAO_TOOL_INPUT_MAX_BYTES",
  "MIAO_TOOL_INPUT_TIMEOUT_MS",
] as const

const named = (keys: readonly string[], environment: Record<string, string | undefined>) =>
  Object.fromEntries(
    keys.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]]])),
  )

const options = (
  environment: Record<string, string | undefined> = process.env,
): Omit<EngineOptions, "db" | "workspace"> | undefined => {
  const binary = environment.MIAO_ENGINE_BIN
  if (!binary) return undefined
  const limits = environment.MIAO_CONTEXT_LIMITS
  return {
    binary,
    model: environment.MIAO_ENGINE_MODEL ?? "",
    provider: environment.MIAO_ENGINE_PROVIDER,
    contextLimits: limits ? JSON.parse(limits) : undefined,
    // ADR-09: the product's credential database is the explicit channel; the
    // engine only reads it. Named provider keys are the single-key fallback.
    credentialDatabase: environment.MIAO_ENGINE_CREDENTIAL_DB,
    credentialID: environment.MIAO_ENGINE_CREDENTIAL_ID,
    credentialIntegration: environment.MIAO_ENGINE_CREDENTIAL_INTEGRATION,
    env: {
      ...named(PROVIDER_ENVIRONMENT, environment),
      ...named(ENGINE_ENVIRONMENT, environment),
    },
  }
}

/** Whether the composition root should build the native transport at all. */
export const configured = (): boolean => options() !== undefined

const refusal = (sessionID: string, error: unknown) =>
  new ConflictError({
    message:
      error instanceof EngineError
        ? `Native engine rejected admission for ${sessionID}: ${error.message}`
        : `Native engine admission for ${sessionID} failed unexpectedly.`,
    resource: sessionID,
  })

type Owners = Effect.Success<ReturnType<typeof makeEngineOwners>>

/**
 * The transport implementation over a server-scoped owner registry. Kept apart
 * from the layer so tests exercise the exact code the server runs.
 */
export const fromOwners = (owners: Owners): NativeEngine.Interface => {
  const connect = (input: { storage: string; location: Location.Ref }) =>
    owners.get({
      storage: input.storage,
      engineID: input.storage,
      location: input.location,
    })
  const read = <T>(
    input: { storage: string; location: Location.Ref },
    request: (connection: Effect.Success<ReturnType<Owners["get"]>>) => Promise<unknown>,
  ) =>
    connect(input).pipe(
      Effect.flatMap((connection) =>
        Effect.tryPromise({
          try: () => request(connection) as Promise<T>,
          catch: (error) => refusal(input.storage, error),
        }),
      ),
      Effect.mapError((error) => refusal(input.storage, error)),
    )
  return {
    admit: (input) =>
      connect(input).pipe(
        Effect.flatMap((connection) =>
          Effect.tryPromise({
            try: () =>
              connection.session.promptProduct({
                sessionID: input.sessionID,
                prompt: { text: input.prompt.text },
                id: input.id,
                delivery: input.delivery,
                resume: input.resume,
              }),
            catch: (error) => refusal(input.sessionID, error),
          }),
        ),
        Effect.mapError((error) => refusal(input.sessionID, error)),
      ),
    snapshot: (input) =>
      read<Readonly<Record<string, unknown>>>(input, (connection) =>
        connection.client.request("snapshot", { session_id: input.sessionID }),
      ).pipe(Effect.map((value) => (typeof value === "object" && value !== null ? value : {}))),
    sessions: (input) =>
      // `sessions` is a unit command: it takes no params.
      read<readonly unknown[]>(input, (connection) => connection.client.request("sessions")).pipe(
        Effect.map((value) => (Array.isArray(value) ? value : [])),
      ),
  }
}

const layer = Layer.effect(
  NativeEngine.Service,
  Effect.gen(function* () {
    const configuration = options()
    if (!configuration) return yield* Effect.die("NativeEngine layer built without MIAO_ENGINE_BIN")
    const owners = yield* makeEngineOwners(configuration)
    return fromOwners(owners)
  }),
)

export const node = makeGlobalNode({ service: NativeEngine.Service, layer, deps: [ClientEvents.node] })

export * as NativeEngineNode from "./native-engine"
