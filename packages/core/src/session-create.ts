export * as SessionCreate from "./session-create"

import path from "path"
import { Context, Effect, Layer } from "effect"
import type { EffectDrizzleSqlite } from "@miao/effect-drizzle-sqlite"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { ProjectV2 } from "./project"
import { ProjectTable } from "./project/sql"
import { SessionStore } from "./session/store"
import { SessionProjector } from "./session/projector"
import { SessionSchema } from "./session/schema"
import { SessionV1 } from "./v1/session"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { AgentV2 } from "./agent"
import { Location } from "./location"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { makeGlobalNode } from "./effect/app-node"

export type Input = {
  readonly id?: SessionSchema.ID
  readonly parentID?: SessionSchema.ID
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly location: Location.Ref
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<SessionSchema.Info>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionCreate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const db: EffectDrizzleSqlite.EffectSQLiteDatabase = database.db

    const create = Effect.fn("SessionCreate.create")(function* (input: Input) {
      const sessionID = input.id ?? SessionSchema.ID.create()
      const recorded = yield* store.get(sessionID)
      if (recorded) return recorded
      const project = yield* projects.resolve(input.location.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const now = Date.now()
      const info = SessionV1.SessionInfo.make({
        id: sessionID,
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: project.id,
        directory: input.location.directory,
        path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
        workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
        parentID: input.parentID,
        title: `New session - ${new Date(now).toISOString()}`,
        agent: input.agent,
        model: input.model
          ? {
              id: ModelV2.ID.make(input.model.id),
              providerID: input.model.providerID,
              variant: input.model.variant,
            }
          : undefined,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      })
      const projected = yield* events
        .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
        .pipe(
          Effect.as({ type: "created" } as const),
          Effect.catchDefect((defect) => {
            if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) return Effect.die(defect)
            // Concurrent creation lost the projection race. The existing Session identity wins.
            return store
              .get(sessionID)
              .pipe(
                Effect.flatMap((session) =>
                  session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                ),
              )
          }),
        )
      if (projected.type === "existing") return projected.session
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found after create: ${sessionID}`)
      return session
    })

    return Service.of({ create })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, ProjectV2.node, SessionStore.node],
})
