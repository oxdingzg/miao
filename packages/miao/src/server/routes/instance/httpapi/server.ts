import { createRoutes as createAssembly, context as assemblyContext } from "@miao/server/assembly"
import type { CorsOptions } from "@miao/server/cors"
import type { RemoteControl } from "@miao/server/remote-control"
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

export function createRoutes(
  corsOptions?: CorsOptions,
  remote?: RemoteControl.Interface,
  runtime?: RuntimeIdentity.Interface,
) {
  return createAssembly({
    cors: corsOptions,
    remote,
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
  }),
)

export * as HttpApiApp from "./server"
