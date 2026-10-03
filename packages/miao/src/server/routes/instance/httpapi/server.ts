import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@miao/core/fs-util"
import * as Observability from "@miao/core/observability"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { Format } from "@/format"
import { GitCli } from "@miao/core/git-cli"
import { ConfigWrite } from "@miao/core/config/write"
import { ProjectWorktree } from "@miao/core/project/worktree"
import { Global } from "@miao/core/global"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { Git } from "@miao/core/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@miao/core/mcp/auth"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@miao/core/control-plane/move-session"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
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
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@miao/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { EventForwarder } from "@/server/event-forwarder"
import { Api } from "@miao/server/api"
import { PublicApi } from "./public"
import { authorizationRouterMiddleware, serverAuthorizationLayer } from "./middleware/authorization"
import { handlers } from "@miao/server/handlers"
import { buildLocationServiceMap, LocationServiceMap } from "@miao/core/location-services"
import { layer as locationLayer } from "@miao/server/location"
import { sessionLocationLayer } from "@miao/server/middleware/session-location"
import { PtyEnvironment } from "@miao/server/pty-environment"
import { RemoteControl } from "@miao/server/remote-control"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@miao/server/middleware/schema-error"
import { memoMap } from "@miao/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - serverRoutes: the typed /api/* routes.
// - docRoute: the OpenAPI document of the public API.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
// The /api/remote routes answer only when `miao remote` hands in its control; elsewhere they are 404.
const serverRoutes = (remote: RemoteControl.Interface | undefined) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlers),
    Layer.provide(remote ? RemoteControl.layer(remote) : Layer.empty),
    Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
  )

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    // Builds the EventV2 -> GlobalBus relay so in-process TUI clients keep
    // receiving events after the V1 bridge leaves the assembly.
    yield* EventForwarder.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Config.node,
  Env.node,
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
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  PermissionSaved.node,
  SessionProjector.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Format.node,
  Project.node,
  Vcs.node,
  Workspace.node,
  WorkspaceLive.node,
  Worktree.node,
  Installation.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
])

export function createRoutes(
  corsOptions?: CorsOptions,
  remote?: RemoteControl.Interface,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const locationServiceMapV2 = buildLocationServiceMap()

  return Layer.mergeAll(serverRoutes(remote), docRoute, uiRoute).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      cors(corsOptions),
      AppNodeBuilderV1.build(MoveSession.node, [[LocationServiceMap.node, locationServiceMapV2]]),
      AppNodeBuilderV1.build(EventForwarder.node, [[LocationServiceMap.node, locationServiceMapV2]]),
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
    Layer.provide(
      AppNodeBuilderV1.build(SessionV2.node, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
    Layer.provide(locationServiceMapV2),
    Layer.provide(
      AppNodeBuilderV1.build(app, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
    // Must stay last: layers provided later in this pipe build beneath earlier ones,
    // so Observability must come after every service graph. Otherwise eagerly forked
    // fibers (e.g. the ModelsDev background refresh) capture Effect's default stdout
    // logger and corrupt the TUI (#34730).
    Layer.provideMerge(Observability.layer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
  }),
)

export * as HttpApiApp from "./server"
