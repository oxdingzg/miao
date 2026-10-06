import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { createRoutes } from "@miao/server/routes"

export function listen(hostname: string, port: number, password?: string) {
  const server = createServer()
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      HttpRouter.serve(createRoutes(password), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => server, { port, host: hostname })),
      ),
    )
    // Abort keepalive/SSE before the HTTP server finalizer waits for connections.
    yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
    return HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address)
  })
}
