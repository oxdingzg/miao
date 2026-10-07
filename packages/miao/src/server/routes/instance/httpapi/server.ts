import { createRoutes as createAssembly, context as assemblyContext, HttpApiAssembly } from "@miao/server/assembly"
import type { CorsOptions } from "@miao/server/cors"
import type { RuntimeIdentity } from "@miao/core/runtime/identity"
import { memoMap } from "@miao/core/effect/memo-map"
import { HttpRouter } from "effect/unstable/http"
import { lazy } from "@/util/lazy"
import { ServerAuth } from "@/server/auth"
import { Extensions } from "./extensions"

// The release server is the shared `packages/server` assembly plus miao's raw
// routes (/doc and the embedded UI) and the EventV2 -> GlobalBus relay. The
// listener, mDNS and websocket tracking stay in the CLI shell.
export const context = assemblyContext

export function createRoutes(corsOptions?: CorsOptions, runtime?: RuntimeIdentity.Interface) {
  return createAssembly({
    cors: corsOptions,
    runtime,
    auth: ServerAuth.Config.layer,
    extensions: Extensions.layer,
  })
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: HttpApiAssembly.defectLogging(),
  }),
)

export * as HttpApiApp from "./server"
