import type { AuthOAuthResult, Hooks } from "@miao/plugin"
import { Effect, Exit, Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AppRuntime } from "@/effect/app-runtime"
import type { InternalPluginInput } from "./auth-store"

/**
 * V1 auth hook for Command Code, so `miao auth login commandcode` can connect
 * the subscription. The V2 `commandcode` provider plugin owns the same OAuth
 * registration for the catalog. There is no refresh: the API key never expires.
 *
 * The loopback server must outlive the single `authorize` effect until the
 * browser posts the key back, so it is opened in a scope this hook closes from
 * the callback.
 */
export const CommandCodeAuthPlugin: (input: InternalPluginInput) => Promise<Hooks> = async () => {
  const { CommandCode } = await import("@miao/core/commandcode")
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    AppRuntime.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer)))
  return {
    auth: {
      provider: "commandcode",
      methods: [
        {
          label: "Command Code account",
          type: "oauth",
          authorize: async (): Promise<AuthOAuthResult> => {
            const http = await run(
              Effect.gen(function* () {
                return yield* HttpClient.HttpClient
              }),
            )
            const session = await run(
              Effect.gen(function* () {
                const scope = yield* Scope.make()
                const authorization = yield* CommandCode.authorizeDetached().pipe(Scope.provide(scope))
                return { authorization, scope }
              }),
            )
            return {
              url: session.authorization.url,
              instructions: session.authorization.instructions,
              method: "auto",
              callback: async () => {
                try {
                  const payload = await Effect.runPromise(session.authorization.callback)
                  const credential = await Effect.runPromise(
                    CommandCode.grantCredential(http, payload.apiKey, payload).pipe(
                      Effect.provide(FetchHttpClient.layer),
                    ),
                  )
                  return {
                    type: "success",
                    refresh: credential.refresh,
                    access: credential.access,
                    expires: credential.expires,
                  }
                } finally {
                  await Effect.runPromise(Scope.close(session.scope, Exit.void))
                }
              },
            }
          },
        },
        { label: "API key", type: "api" },
      ],
    },
  }
}
