import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { memoMap } from "@miao/core/effect/memo-map"
import { DatabaseFile } from "@miao/core/database/file"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { SessionOwnership } from "@miao/core/session/ownership"
import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { InstallationVersion } from "@miao/core/installation/version"
import { createRoutes } from "@miao/server/routes"

export function listen(hostname: string, port: number, password?: string, owned = false) {
  const server = createServer()
  return Effect.gen(function* () {
    const scope = yield* Effect.scope
    const identity =
      owned && password
        ? RuntimeIdentity.create(
            yield* Effect.promise(() => RuntimeOwnership.canonicalStorage(DatabaseFile.path())),
            InstallationVersion,
            password,
          )
        : undefined
    const execution = identity
      ? ManagedRuntime.make(
          AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionOwnership.node])),
          { memoMap },
        )
      : undefined
    if (execution) yield* Effect.addFinalizer(() => Effect.promise(() => execution.dispose()))
    const state: {
      starting?: Promise<
        Awaited<ReturnType<(typeof import("@miao/sdk/remote-control/control-agent"))["RuntimeControlAgent"]["start"]>>
      >
      closing: boolean
    } = { closing: false }
    const routes = createRoutes(password)
    const application =
      identity && execution
        ? routes.pipe(
            Layer.provide(
              Layer.succeed(RuntimeIdentity.Service, {
                prove: identity.prove,
                administration: async () => {
                  if (state.closing) return undefined
                  state.starting ??= (async () => {
                    const { RuntimeControlAgent } = await import("@miao/sdk/remote-control/control-agent")
                    return RuntimeControlAgent.start({
                      url,
                      credential: password!,
                      username: "opencode",
                      runtimeID: identity.runtimeID,
                      storage: DatabaseFile.path(),
                      run: (effect) => execution.runPromise(effect),
                    })
                  })()
                  return (await state.starting)?.administration
                },
              }),
            ),
          )
        : routes
    const context = yield* Layer.buildWithMemoMap(
      HttpRouter.serve(application, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => server, { port, host: hostname })),
      ),
      memoMap,
      scope,
    )
    // Abort keepalive/SSE before the HTTP server finalizer waits for connections.
    yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
    const url = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address)
    identity?.bind(url)
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closing = true
        await (await state.starting)?.stop()
      }),
    )
    return url
  })
}
