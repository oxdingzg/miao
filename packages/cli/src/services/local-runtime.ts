export * as LocalRuntime from "./local-runtime"

import { OpenCode } from "@miao/client"
import { ServerAuth } from "@miao/server/auth"
import { Context, Effect, Layer, Scope, Semaphore } from "effect"
import { randomBytes } from "node:crypto"

export interface Interface {
  readonly client: () => Effect.Effect<ReturnType<typeof OpenCode.make>, unknown>
  readonly transport: () => Effect.Effect<{ url: string; headers: RequestInit["headers"] }, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@miao/cli/LocalRuntime") {}

/** A lazy, private listener built in this invocation's scope. No discovery or child process. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const gate = Semaphore.makeUnsafe(1)
    const password = randomBytes(48).toString("hex")
    const state: { url?: string } = {}
    const transport = () =>
      gate.withPermit(
        Effect.gen(function* () {
          if (!state.url) {
            const { listen } = yield* Effect.promise(() => import("./listener"))
            state.url = yield* listen("127.0.0.1", 0, password).pipe(Effect.provideService(Scope.Scope, scope))
          }
          return { url: state.url, headers: ServerAuth.headers({ username: "opencode", password }) }
        }),
      )
    return Service.of({
      transport,
      client: () =>
        transport().pipe(
          Effect.map((connection) => OpenCode.make({ baseUrl: connection.url, headers: connection.headers })),
        ),
    })
  }),
)
