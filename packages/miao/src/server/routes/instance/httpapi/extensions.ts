export * as Extensions from "./extensions"

import { FSUtil } from "@miao/core/fs-util"
import { Flag } from "@miao/core/flag/flag"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { lazy } from "@/util/lazy"
import { ServerAuth } from "@/server/auth"
import { EventForwarder } from "@/server/event-forwarder"
import { serveUIEffect } from "@/server/shared/ui"
import { authorizationRouterMiddleware } from "./middleware/authorization"
import { PublicApi } from "./public"

// Raw routes the server assembly cannot build itself: the OpenAPI document and
// the embedded/remote web UI. They are merged next to the typed /api/* tree.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))

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
    // Builds the EventV2 -> GlobalBus relay so in-process TUI clients keep
    // receiving events.
    yield* EventForwarder.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: Flag.MIAO_DISABLE_EMBEDDED_WEB_UI }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

export const layer = Layer.mergeAll(docRoute, uiRoute).pipe(
  Layer.provide(AppNodeBuilder.build(EventForwarder.node)),
)
