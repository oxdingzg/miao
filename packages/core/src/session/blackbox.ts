export * as SessionBlackbox from "./blackbox"

import path from "node:path"
import { Context, Effect, Exit, Stream, Schema, Cause, Option } from "effect"
import { LLMError, LLMEvent, ToolOutput, ToolResultValue, type LLMRequest } from "@miao/llm"
import { ToolRegistry } from "../tool/registry"
import { BlackboxTape } from "../blackbox/tape"
import { InstallationVersion, InstallationChannel } from "../installation/version"

export type Port = { get: (sessionID: string) => Promise<BlackboxTape.Recorder | BlackboxTape.Replay> }

/** Opt-in diagnostic mode. Replay replaces both provider and local tool IO. */
export const Current = Context.Reference<Port | undefined>("@miao/SessionBlackbox", {
  defaultValue: () => {
    const directory = process.env.MIAO_BLACKBOX_RECORD
    const file = process.env.MIAO_BLACKBOX_REPLAY
    if (directory && file) throw new Error("Choose blackbox record or replay, not both")
    if (!directory && !file) return undefined
    const sessions = new Map<string, Promise<BlackboxTape.Recorder | BlackboxTape.Replay>>()
    return {
      get(sessionID) {
        if (!/^ses_[a-zA-Z0-9_-]+$/.test(sessionID)) throw new Error("Invalid blackbox Session id")
        if (file && sessions.size > 0 && !sessions.has(sessionID))
          throw new Error("A replay bundle belongs to one Session")
        const existing = sessions.get(sessionID)
        if (existing) return existing
        const created = file
          ? BlackboxTape.load(file).then((bundle) => new BlackboxTape.Replay(bundle))
          : Promise.resolve(
              new BlackboxTape.Recorder(path.join(directory!, `${sessionID}.json`), {
                engine: "typescript",
                version: InstallationVersion,
                channel: InstallationChannel,
                sessionID,
              }),
            )
        sessions.set(sessionID, created)
        return created
      },
    }
  },
})

const Settlement = Schema.Struct({
  result: Schema.toType(ToolResultValue),
  output: Schema.optional(ToolOutput),
  outputPaths: Schema.optional(Schema.Array(Schema.String)),
})

const snapshot = (value: unknown) =>
  BlackboxTape.json(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(JSON.stringify(value)))

export function requestValue(request: LLMRequest) {
  // Route values close over auth functions. Only transport-free model identity
  // and semantic inputs belong in the recording; never serialize a route.
  const ids = new Map<string, string>()
  const messages = request.messages.map((message) => {
    if (!message.id?.startsWith("msg_")) return message
    const id = ids.get(message.id) ?? `message_${ids.size}`
    ids.set(message.id, id)
    return Object.fromEntries([...Object.entries(message).filter(([key]) => key !== "id"), ["id", id]])
  })
  return snapshot({
    model: { id: request.model.id, provider: request.model.provider, route: request.model.route.id },
    system: request.system,
    messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    generation: request.generation,
    providerOptions: request.providerOptions,
    responseFormat: request.responseFormat,
    cache: request.cache,
  })
}

export function stream<R>(sessionID: string, request: LLMRequest, live: () => Stream.Stream<LLMEvent, LLMError, R>) {
  const source: { value?: Stream.Stream<LLMEvent, LLMError, R> } = {}
  return Stream.unwrap(
    Effect.gen(function* () {
      const port = yield* Current
      if (!port) return (source.value ??= live())
      const tape = yield* Effect.promise(() => port.get(sessionID))
      const input = requestValue(request)
      if (tape instanceof BlackboxTape.Replay) {
        const recorded = yield* Effect.sync(() => tape.take("llm", input))
        const frames = Stream.fromIterable(recorded.frames).pipe(
          Stream.map((frame) => Schema.decodeUnknownSync(Schema.toType(LLMEvent))(frame.value)),
        )
        if (recorded.outcome === "complete") return frames
        if (recorded.outcome === "cancelled") return Stream.concat(frames, Stream.fromEffect(Effect.interrupt))
        if (!recorded.error) return yield* Effect.die(new Error("Recorded provider error has no classification"))
        return Stream.concat(frames, Stream.fail(Schema.decodeUnknownSync(LLMError)(recorded.error)))
      }
      const ticket = yield* Effect.promise(() => tape.begin("llm", input))
      return (source.value ??= live()).pipe(
        Stream.tap((event) => Effect.promise(() => ticket.frame(snapshot(event)))),
        Stream.onExit((exit) =>
          Effect.promise(() => {
            if (Exit.isSuccess(exit)) return ticket.finish("complete")
            if (Cause.hasInterrupts(exit.cause)) return ticket.finish("cancelled")
            const failure = Cause.findErrorOption(exit.cause)
            const error = Option.isSome(failure) && failure.value instanceof LLMError ? failure.value : undefined
            // Error transport context can contain Authorization headers and signed
            // URLs. Preserve classification/retry fields, not the HTTP context.
            const reason = error ? Schema.encodeSync(LLMError)(error).reason : undefined
            const classified = reason
              ? snapshot({
                  _tag: "LLM.Error",
                  module: error?.module,
                  method: error?.method,
                  reason: {
                    ...Object.fromEntries(
                      Object.entries(reason).filter(([key]) =>
                        [
                          "_tag",
                          "kind",
                          "status",
                          "retryAfterMs",
                          "transient",
                          "route",
                          "provider",
                          "model",
                          "classification",
                        ].includes(key),
                      ),
                    ),
                    message: error?.retryable
                      ? "Recorded provider temporarily overloaded"
                      : "Recorded provider failure",
                    ...(reason._tag === "UnknownProvider" ? { transient: error?.retryable } : {}),
                  },
                })
              : undefined
            return ticket.finish("error", classified)
          }),
        ),
      )
    }),
  )
}

export function tool<E, R>(
  sessionID: string,
  name: string,
  input: unknown,
  live: Effect.Effect<ToolRegistry.Settlement, E, R>,
) {
  return Effect.gen(function* () {
    const port = yield* Current
    if (!port) return yield* live
    const tape = yield* Effect.promise(() => port.get(sessionID))
    const request = snapshot({ name, input })
    if (tape instanceof BlackboxTape.Replay) {
      const recorded = yield* Effect.sync(() => tape.take("tool", request))
      if (recorded.outcome === "cancelled") return yield* Effect.interrupt
      if (recorded.outcome !== "complete" || recorded.frames.length !== 1)
        return yield* Effect.die(new Error("Recorded tool boundary did not produce one complete settlement"))
      return Schema.decodeUnknownSync(Settlement)(recorded.frames[0].value)
    }
    const ticket = yield* Effect.promise(() => tape.begin("tool", request))
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(restore(live))
        if (Exit.isSuccess(result)) {
          yield* Effect.promise(() => ticket.frame(snapshot(result.value)))
          yield* Effect.promise(() => ticket.finish("complete"))
          return result.value
        }
        yield* Effect.promise(() => ticket.finish(Cause.hasInterrupts(result.cause) ? "cancelled" : "error"))
        return yield* Effect.failCause(result.cause)
      }),
    )
  })
}
