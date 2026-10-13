import { makeGlobalNode } from "@miao/core/effect/app-node"
import { ClientEvents } from "@miao/server/client-events"
import { NativeEngine } from "@miao/server/native-engine"
import { ConflictError } from "@miao/protocol/errors"
import { Effect, Layer } from "effect"
import { EngineError, type EngineOptions } from "./client"
import { makeEngineOwners } from "./owners"

/**
 * Production native transport, opt-in through the engine binary environment:
 * without `MIAO_ENGINE_BIN` the layer is never built and native-owned Sessions
 * keep the explicit refusal. The model identity is required from the operator
 * because the engine cannot invent provider credentials or catalog facts.
 */
const options = (): Omit<EngineOptions, "db" | "workspace"> | undefined => {
  const binary = process.env.MIAO_ENGINE_BIN
  if (!binary) return undefined
  const limits = process.env.MIAO_CONTEXT_LIMITS
  return {
    binary,
    model: process.env.MIAO_ENGINE_MODEL ?? "",
    provider: process.env.MIAO_ENGINE_PROVIDER,
    contextLimits: limits ? JSON.parse(limits) : undefined,
    env: { ...process.env },
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

const layer = Layer.effect(
  NativeEngine.Service,
  Effect.gen(function* () {
    const configuration = options()
    if (!configuration) return yield* Effect.die("NativeEngine layer built without MIAO_ENGINE_BIN")
    const owners = yield* makeEngineOwners(configuration)
    return {
      admit: (input) =>
        owners
          .get({
            storage: input.storage,
            engineID: input.storage,
            location: input.location,
          })
          .pipe(
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
    }
  }),
)

export const node = makeGlobalNode({ service: NativeEngine.Service, layer, deps: [ClientEvents.node] })

export * as NativeEngineNode from "./native-engine"
