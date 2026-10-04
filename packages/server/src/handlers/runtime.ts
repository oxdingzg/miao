import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { ServiceUnavailableError } from "@miao/protocol/errors"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const RuntimeHandler = HttpApiBuilder.group(Api, "server.runtime", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Effect.serviceOption(RuntimeIdentity.Service)
    return handlers
      .handle("runtime.identity", (ctx) => {
        const proof = Option.isSome(identity) ? identity.value.prove(ctx.query.challenge) : undefined
        return proof
          ? Effect.succeed(proof)
          : Effect.fail(new ServiceUnavailableError({ message: "No hosted Runtime identity", service: "runtime" }))
      })
      .handle("runtime.stop", () => {
        if (!Option.isSome(identity) || !identity.value.stop)
          return Effect.fail(
            new ServiceUnavailableError({ message: "No hosted Runtime lifecycle", service: "runtime" }),
          )
        return Effect.sync(() => {
          identity.value.stop!()
          return HttpApiSchema.NoContent.make()
        })
      })
  }),
)
