import { Database } from "@miao/core/database/database"
import { LayerNode } from "@miao/core/effect/layer-node"
import { httpClient } from "@miao/core/effect/app-node-platform"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { EventV2 } from "@miao/core/event"
import { Git } from "@miao/core/git"
import { GitCli } from "@miao/core/git-cli"
import { ConfigWrite } from "@miao/core/config/write"
import { ProjectWorktree } from "@miao/core/project/worktree"
import { Global } from "@miao/core/global"
import { FSUtil } from "@miao/core/fs-util"
import { ProjectDirectories } from "@miao/core/project/directories"
import { ProjectMetadata } from "@miao/core/project/metadata"
import { MoveSession } from "@miao/core/control-plane/move-session"
import { Credential } from "@miao/core/credential"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Project } from "@miao/core/project"
import { PtyTicket } from "@miao/core/pty/ticket"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { LocationServiceMap } from "@miao/core/location-service-map"
import { SessionExecutionLocal } from "@miao/core/session/execution/local"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { WorkspaceLive } from "@miao/core/workspace-live"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { HttpApiAssembly } from "./assembly"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  Project.node,
  Git.node,
  GitCli.node,
  ConfigWrite.node,
  ProjectWorktree.node,
  Global.node,
  FSUtil.node,
  ProjectDirectories.node,
  ProjectMetadata.node,
  WorkspaceLive.node,
  MoveSession.node,
])

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(password) })
      : ServerAuth.Config.layer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [[SessionExecution.node, SessionExecutionLocal.node]])

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
    middleware: HttpApiAssembly.defectLogging(),
  })
