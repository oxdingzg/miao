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
