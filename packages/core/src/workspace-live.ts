export * as WorkspaceLive from "./workspace-live"

import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "./database/database"
import { WorkspaceTable } from "./control-plane/workspace.sql"
import { makeGlobalNode } from "./effect/app-node"
import { WorkspaceV2 } from "./workspace"

const layer = Layer.effect(
  WorkspaceV2.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = (scope: WorkspaceV2.Scope) =>
      db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, scope.projectID))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(fromRow).sort((a, b) => a.id.localeCompare(b.id))),
        )

    return WorkspaceV2.Service.of({
      list,
      status: () => Effect.succeed([]),
      adapters: () => Effect.succeed([]),
      create: () => Effect.fail(new WorkspaceV2.UnsupportedError({ message: "Workspace adapters are unavailable" })),
      remove: (id) =>
        Effect.gen(function* () {
          const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
          if (!row) return undefined
          yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run().pipe(Effect.orDie)
          return fromRow(row)
        }),
      syncList: () => Effect.void,
      warp: () => Effect.fail(new WorkspaceV2.UnsupportedError({ message: "Workspace sync is unavailable" })),
    })
  }),
)

function fromRow(row: typeof WorkspaceTable.$inferSelect): WorkspaceV2.Info {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    branch: row.branch,
    directory: row.directory,
    extra: row.extra,
    projectID: row.project_id,
    timeUsed: row.time_used,
  }
}

export const node = makeGlobalNode({ service: WorkspaceV2.Service, layer, deps: [Database.node] })
