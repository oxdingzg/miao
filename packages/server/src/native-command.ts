import { Effect, Option } from "effect"
import { ConflictError } from "@miao/protocol/errors"
import { NativeEngine } from "./native-engine"

/** A native-owned identity must never fall through to the TS writer. */
export const requireTypescriptOwner = Effect.fn("NativeCommand.requireTypescriptOwner")(function* (
  sessionID: string,
  operation: string,
) {
  const placement = yield* Effect.serviceOption(NativeEngine.Placement)
  if (Option.isSome(placement))
    return yield* new ConflictError({
      message: `Native engine operation is not implemented: ${operation}`,
      resource: sessionID,
    })
})

export const requireNativeOwner = Effect.fn("NativeCommand.requireNativeOwner")(function* (sessionID: string) {
  const native = yield* Effect.serviceOption(NativeEngine.Service)
  const placement = yield* Effect.serviceOption(NativeEngine.Placement)
  if (Option.isNone(native) || Option.isNone(placement))
    return yield* new ConflictError({
      message: "This operation requires a Rust-owned Session and its native transport.",
      resource: sessionID,
    })
  return { native: native.value, placement: placement.value }
})
