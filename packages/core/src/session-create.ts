export * as SessionCreate from "./session-create"

import path from "path"
import { Context, DateTime, Effect, Layer } from "effect"
import type { EffectDrizzleSqlite } from "@miao/effect-drizzle-sqlite"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { ProjectV2 } from "./project"
import { ProjectTable } from "./project/sql"
import { SessionOwnership } from "./session/ownership"
import { SessionStore } from "./session/store"
import { SessionProjector } from "./session/projector"
import { SessionSchema } from "./session/schema"
import { SessionEvent } from "./session/event"
import { RelativePath } from "./schema"
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
    const ownership = yield* SessionOwnership.Service
    const db: EffectDrizzleSqlite.EffectSQLiteDatabase = database.db

    const create = Effect.fn("SessionCreate.create")(function* (input: Input) {
      const sessionID = input.id ?? SessionSchema.ID.create()
      const recorded = yield* store.get(sessionID)
      if (recorded) return recorded
      yield* ownership.claim(sessionID)
      const project = yield* projects.resolve(input.location.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const now = Date.now()
      const timestamp = DateTime.makeUnsafe(now)
      const info: SessionSchema.Info = {
        id: sessionID,
        parentID: input.parentID,
        projectID: project.id,
        agent: input.agent,
        model: input.model,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: timestamp, updated: timestamp },
        title: `New session - ${new Date(now).toISOString()}`,
        location: input.location,
        subpath: RelativePath.make(path.relative(project.directory, input.location.directory).replaceAll("\\", "/")),
      }
      const projected = yield* events
        .publish(
          SessionEvent.Info.Created,
          { sessionID, timestamp, info, slug: Slug.create(), version: InstallationVersion },
          { location: input.location },
        )
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
  deps: [Database.node, EventV2.node, ProjectV2.node, SessionStore.node, SessionOwnership.node],
})
