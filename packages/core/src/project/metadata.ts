export * as ProjectMetadata from "./metadata"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Project } from "@miao/schema/project"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { AbsolutePath } from "../schema"
import { ProjectV2 } from "../project"
import { ProjectTable } from "./sql"

type Row = typeof ProjectTable.$inferSelect

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ProjectMetadata.NotFoundError", {
  projectID: Project.ID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Project.Info[]>
  /** Record a resolved project that no session has been created in yet, so it can carry metadata. */
  readonly ensure: (project: ProjectV2.Resolved) => Effect.Effect<void>
  readonly update: (id: Project.ID, input: Project.UpdateInput) => Effect.Effect<Project.Info, NotFoundError>
  /** Stamps the project's initialized time (the `/init` command fired for it). */
  readonly setInitialized: (id: Project.ID) => Effect.Effect<void>
  /** Existing, still-present sandbox checkouts for a project. */
  readonly sandboxes: (id: Project.ID) => Effect.Effect<string[]>
  readonly addSandbox: (id: Project.ID, directory: string) => Effect.Effect<void>
  readonly removeSandbox: (id: Project.ID, directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@miao/ProjectMetadata") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service

    return Service.of({
      list: Effect.fn("ProjectMetadata.list")(function* () {
        return (yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).map(fromRow)
      }),
      ensure: Effect.fn("ProjectMetadata.ensure")(function* (project: ProjectV2.Resolved) {
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }),
      update: Effect.fn("ProjectMetadata.update")(function* (id: Project.ID, input: Project.UpdateInput) {
        const row = yield* db
          .update(ProjectTable)
          .set({
            name: input.name,
            icon_url: input.icon?.url,
            icon_url_override: input.icon?.override,
            icon_color: input.icon?.color,
            commands: input.commands,
            time_updated: Date.now(),
          })
          .where(eq(ProjectTable.id, id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ projectID: id })
        const info = fromRow(row)
        yield* events.publish(Project.Event.Updated, info)
        return info
      }),
      setInitialized: Effect.fn("ProjectMetadata.setInitialized")(function* (id: Project.ID) {
        yield* db
          .update(ProjectTable)
          .set({ time_initialized: Date.now() })
          .where(eq(ProjectTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      sandboxes: Effect.fn("ProjectMetadata.sandboxes")(function* (id: Project.ID) {
        const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return []
        return yield* Effect.forEach(
          fromRow(row).sandboxes,
          (dir) => fs.isDir(dir).pipe(Effect.orDie, Effect.map((ok) => (ok ? dir : undefined))),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
      }),
      addSandbox: Effect.fn("ProjectMetadata.addSandbox")(function* (id: Project.ID, directory: string) {
        const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
        if (!row) throw new Error(`Project not found: ${id}`)
        const sandbox = AbsolutePath.make(directory)
        const sboxes = [...row.sandboxes]
        if (!sboxes.includes(sandbox)) sboxes.push(sandbox)
        const result = yield* db
          .update(ProjectTable)
          .set({ sandboxes: sboxes, time_updated: Date.now() })
          .where(eq(ProjectTable.id, id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!result) throw new Error(`Project not found: ${id}`)
        yield* events.publish(Project.Event.Updated, fromRow(result))
      }),
      removeSandbox: Effect.fn("ProjectMetadata.removeSandbox")(function* (id: Project.ID, directory: string) {
        const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
        if (!row) throw new Error(`Project not found: ${id}`)
        const sandbox = AbsolutePath.make(directory)
        const sboxes = row.sandboxes.filter((s) => s !== sandbox)
        const result = yield* db
          .update(ProjectTable)
          .set({ sandboxes: sboxes, time_updated: Date.now() })
          .where(eq(ProjectTable.id, id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!result) throw new Error(`Project not found: ${id}`)
        yield* events.publish(Project.Event.Updated, fromRow(result))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node, FSUtil.node] })

export function fromRow(row: Row): Project.Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(Project.Vcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
    commands: row.commands ?? undefined,
  }
}
