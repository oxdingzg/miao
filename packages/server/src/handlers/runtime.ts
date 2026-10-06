import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@miao/protocol/errors"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const RuntimeHandler = HttpApiBuilder.group(Api, "server.runtime", (handlers) =>
  Effect.gen(function* () {
    const identity = yield* Effect.serviceOption(RuntimeIdentity.Service)
    const unavailable = () =>
      new ServiceUnavailableError({ message: "Remote Control administration unavailable", service: "runtime" })
    const administration = () =>
      Effect.tryPromise({
        try: async () => (Option.isSome(identity) ? identity.value.administration?.() : undefined),
        catch: unavailable,
      })
    const required = () =>
      administration().pipe(Effect.flatMap((admin) => (admin ? Effect.succeed(admin) : Effect.fail(unavailable()))))
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
        administration().pipe(
          Effect.map((admin) => admin?.status() ?? { enabled: false, connected: false }),
          Effect.catch(() => Effect.succeed({ enabled: false, connected: false })),
        ),
      )
      .handle("runtime.control.configure", (ctx) =>
        required().pipe(
          Effect.flatMap(
            Effect.fn(function* (admin) {
              const configure = admin.configure
              if (!configure) return yield* unavailable()
              return yield* Effect.tryPromise({
                try: () => configure(ctx.payload),
                catch: () => new InvalidRequestError({ message: "Relay configuration could not be saved or applied" }),
              })
            }),
          ),
        ),
      )
      .handle("runtime.control.invite", (ctx) =>
        required().pipe(
          Effect.flatMap((admin) =>
            Effect.tryPromise({
              try: () => admin.invite(ctx.payload),
              catch: () => new InvalidRequestError({ message: "Invalid pairing policy or unavailable scope" }),
            }),
          ),
        ),
      )
      .handle("runtime.control.pending", () => required().pipe(Effect.map((admin) => admin.pending())))
      .handle("runtime.control.approve", (ctx) =>
        required().pipe(
          Effect.flatMap((admin) =>
            Effect.tryPromise({
              try: () => admin.approve(ctx.params.pairingID, ctx.payload.publicKey),
              catch: () => new ConflictError({ message: "Pairing unavailable or device key changed" }),
            }),
          ),
        ),
      )
      .handle("runtime.control.reject", (ctx) =>
        required().pipe(
          Effect.map((admin) => {
            admin.reject(ctx.params.pairingID)
            return HttpApiSchema.NoContent.make()
          }),
        ),
      )
      .handle("runtime.control.devices", () => required().pipe(Effect.map((admin) => admin.devices())))
      .handle("runtime.control.revoke", (ctx) =>
        required().pipe(
          Effect.flatMap((admin) =>
            Effect.tryPromise({
              try: () => admin.revoke(ctx.params.grantID, ctx.payload.version),
              catch: () => new ConflictError({ message: "Device grant version conflict" }),
            }),
          ),
        ),
      )
  }),
)
