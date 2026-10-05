import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@miao/protocol/errors"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const RuntimeHandler = HttpApiBuilder.group(Api, "server.runtime", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Effect.serviceOption(RuntimeIdentity.Service)
    const administration = () => (Option.isSome(identity) ? identity.value.administration?.() : undefined)
    const unavailable = () =>
      new ServiceUnavailableError({ message: "Remote Control administration unavailable", service: "runtime" })
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
      .handle("runtime.control.get", () =>
        Effect.sync(() => administration()?.status() ?? { enabled: false, connected: false }),
      )
      .handle("runtime.control.configure", (ctx) => {
        const configure = administration()?.configure
        if (!configure) return Effect.fail(unavailable())
        return Effect.tryPromise({
          try: () => configure(ctx.payload),
          catch: () => new InvalidRequestError({ message: "Relay configuration could not be saved or applied" }),
        })
      })
      .handle("runtime.control.invite", (ctx) => {
        const admin = administration()
        if (!admin) return Effect.fail(unavailable())
        return Effect.tryPromise({
          try: () => admin.invite(ctx.payload),
          catch: () => new InvalidRequestError({ message: "Invalid pairing policy or unavailable scope" }),
        })
      })
      .handle("runtime.control.pending", () => {
        const admin = administration()
        return admin ? Effect.sync(() => admin.pending()) : Effect.fail(unavailable())
      })
      .handle("runtime.control.approve", (ctx) => {
        const admin = administration()
        if (!admin) return Effect.fail(unavailable())
        return Effect.tryPromise({
          try: () => admin.approve(ctx.params.pairingID, ctx.payload.publicKey),
          catch: () => new ConflictError({ message: "Pairing unavailable or device key changed" }),
        })
      })
      .handle("runtime.control.reject", (ctx) => {
        const admin = administration()
        return admin
          ? Effect.sync(() => {
              admin.reject(ctx.params.pairingID)
              return HttpApiSchema.NoContent.make()
            })
          : Effect.fail(unavailable())
      })
      .handle("runtime.control.devices", () => {
        const admin = administration()
        return admin ? Effect.sync(() => admin.devices()) : Effect.fail(unavailable())
      })
      .handle("runtime.control.revoke", (ctx) => {
        const admin = administration()
        if (!admin) return Effect.fail(unavailable())
        return Effect.tryPromise({
          try: () => admin.revoke(ctx.params.grantID, ctx.payload.version),
          catch: () => new ConflictError({ message: "Device grant version conflict" }),
        })
      })
  }),
)
