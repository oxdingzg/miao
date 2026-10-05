import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/unstable/http"
import { FSUtil } from "@miao/core/fs-util"
import * as Observability from "@miao/core/observability"
import { GitCli } from "@miao/core/git-cli"
import { ConfigWrite } from "@miao/core/config/write"
import { ProjectWorktree } from "@miao/core/project/worktree"
import { Global } from "@miao/core/global"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { Git } from "@miao/core/git"
import { McpAuth } from "@miao/core/mcp/auth"
import { MoveSession } from "@miao/core/control-plane/move-session"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { httpClient } from "@miao/core/effect/app-node-platform"
import { EventV2 } from "@miao/core/event"
import { ModelsDev } from "@miao/core/models-dev"
import { Npm } from "@miao/core/npm"
import { PermissionSaved } from "@miao/core/permission/saved"
import { ProjectV2 } from "@miao/core/project"
import { ProjectCopy } from "@miao/core/project/copy"
import { PtyTicket } from "@miao/core/pty/ticket"
import { Ripgrep } from "@miao/core/ripgrep"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionExecutionLocal } from "@miao/core/session/execution/local"
import { WorkspaceLive } from "@miao/core/workspace-live"
import { buildLocationServiceMap, LocationServiceMap } from "@miao/core/location-services"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "./cors"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { errorLayer } from "./middleware/error"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"
import { PtyEnvironment } from "./pty-environment"
import { RuntimeIdentity } from "@miao/core/runtime/identity"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

export interface AssemblyOptions {
  readonly cors?: CorsOptions
  readonly runtime?: RuntimeIdentity.Interface
  /** Provides `ServerAuth.Config`; defaults to the environment-backed layer. */
  readonly auth?: Layer.Layer<ServerAuth.Config, any, any>
  /**
   * Extra raw routes merged next to the typed `/api/*` tree, such as the OpenAPI
   * document and the embedded web UI. `packages/server` cannot build those
   * itself, so the host supplies them.
   */
  readonly extensions?: Layer.Layer<never, any, any>
}

// Route tree:
// - apiRoutes: the typed /api/* routes.
// - extensions: host-supplied raw routes (OpenAPI document, embedded UI).
// - the catch-all UI fallback lives in the host extension so the server package
//   stays free of build-time virtual modules.
const apiRoutes = (auth: AssemblyOptions["auth"], runtime: AssemblyOptions["runtime"]) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlers),
    Layer.provide(runtime ? Layer.succeed(RuntimeIdentity.Service)(runtime) : Layer.empty),
    Layer.provide([authorizationLayer.pipe(Layer.provide(auth ?? ServerAuth.Config.layer)), schemaErrorLayer]),
  )

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

// The application service graph shared by every non-location-scoped route. The
// location service map is built lazily by AppNodeBuilder when a root needs it.
const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  GitCli.node,
  ConfigWrite.node,
  ProjectWorktree.node,
  Global.node,
  ProjectDirectories.node,
  ProjectMetadata.node,
  // The location middleware resolves Core's repository-level Git service, which is distinct from
  // the cwd-based GitCli service above.
  Git.node,
  Ripgrep.node,
  ModelsDev.node,
  PermissionSaved.node,
  SessionProjector.node,
  McpAuth.node,
  WorkspaceLive.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
])

export function createRoutes(
  options: AssemblyOptions = {},
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const locationServiceMapV2 = buildLocationServiceMap()

  const http = Layer.mergeAll(apiRoutes(options.auth, options.runtime), options.extensions ?? Layer.empty).pipe(
    Layer.provide([errorLayer, compressionLayer, corsVaryFix, cors(options.cors), HttpServer.layerServices]),
    Layer.provide(Layer.succeed(CorsConfig)(options.cors)),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
  )
  // Routers, authentication, middleware, and controls belong to a listener.
  // Core execution and storage services below share the process MemoMap.
  return Layer.fresh(http).pipe(
    Layer.provide(AppNodeBuilder.build(MoveSession.node, [[LocationServiceMap.node, locationServiceMapV2]])),
    Layer.provide(
      AppNodeBuilder.build(SessionV2.node, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
    Layer.provide(locationServiceMapV2),
    Layer.provide(
      AppNodeBuilder.build(app, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
    // Must stay last: layers provided later in this pipe build beneath earlier ones,
    // so Observability must come after every service graph. Otherwise eagerly forked
    // fibers (e.g. the ModelsDev background refresh) capture Effect's default stdout
    // logger and corrupt the TUI (#34730).
    Layer.provideMerge(Observability.layer),
  ) as Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements>
}

export const routes = createRoutes()

export * as HttpApiAssembly from "./assembly"
