import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { LocationServiceMap } from "@miao/core/location-services"
import { Location } from "@miao/core/location"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Project } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionRouting } from "@miao/core/session/routing"
import { SessionV2 } from "@miao/core/session"
import { WorkspaceV2 } from "@miao/core/workspace"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidRequestError,
  SessionLocationMissingError,
  SessionNotFoundError,
} from "@miao/protocol/errors"
import type { LocationServices } from "../location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@miao/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError, SessionLocationMissingError, ConflictError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap.Service
    const project = yield* Project.Service
    const permissions = yield* PermissionSaved.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const resolution = yield* SessionRouting.resolve({ db, events, fs, sessionID })
        // A native Session is owned and stored by the engine. Serving it through
        // the TypeScript handlers would read and write metadata this server does
        // not own, so refuse instead of returning wrong data.
        if (SessionRouting.route(resolution) === "native")
          return yield* new ConflictError({
            message: `Session ${sessionID} is owned by the native engine and cannot be served by this server.`,
            resource: sessionID,
          })
        if (resolution.type === "unknown")
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })
        if (resolution.type === "missing")
          return yield* new SessionLocationMissingError({
            sessionID,
            directory: resolution.directory,
            message:
              `Session ${sessionID} lives in "${resolution.directory}", which no longer exists, ` +
              "and its project checkout could not take it back.",
          })

        return yield* effect.pipe(
          Effect.provide(locations.get(resolution.location)),
          Effect.provideService(Project.Service, project),
          Effect.provideService(PermissionSaved.Service, permissions),
        )
      }),
    )
  }),
)
