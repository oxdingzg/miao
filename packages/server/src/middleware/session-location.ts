import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { LocationServiceMap } from "@miao/core/location-services"
import { Location } from "@miao/core/location"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Project } from "@miao/core/project"
import { SessionHeal } from "@miao/core/session/heal"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionTable } from "@miao/core/session/sql"
import { WorkspaceV2 } from "@miao/core/workspace"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, SessionLocationMissingError, SessionNotFoundError } from "@miao/protocol/errors"
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
        const row = yield* db
          .select({
            directory: SessionTable.directory,
            workspaceID: SessionTable.workspace_id,
            projectID: SessionTable.project_id,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row)
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })

        // A Session whose directory was deleted out-of-band (e.g. a removed
        // worktree) cannot open its Location; move it back to its project's
        // checkout first so the request can proceed.
        const directory = yield* SessionHeal.relocateOrphan({
          db,
          events,
          fs,
          sessionID,
          directory: AbsolutePath.make(row.directory),
          projectID: row.projectID,
        })
        if (!directory)
          return yield* new SessionLocationMissingError({
            sessionID,
            directory: row.directory,
            message:
              `Session ${sessionID} lives in "${row.directory}", which no longer exists, ` +
              "and its project checkout could not take it back.",
          })

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory,
                ...(row.workspaceID ? { workspaceID: WorkspaceV2.ID.make(row.workspaceID) } : {}),
              }),
            ),
          ),
          Effect.provideService(Project.Service, project),
          Effect.provideService(PermissionSaved.Service, permissions),
        )
      }),
    )
  }),
)
