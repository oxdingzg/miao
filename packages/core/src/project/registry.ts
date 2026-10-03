export * as ProjectRegistry from "./registry"

import { and, eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Project as ProjectSchema } from "@miao/schema/project"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Project } from "../project"
import { AbsolutePath } from "../schema"
import { SessionTable } from "../session/sql"
import { ProjectDirectories } from "./directories"
import { ProjectMetadata } from "./metadata"
import { ProjectDirectoryTable, ProjectTable } from "./sql"

export interface Input {
  readonly id: Project.ID
  /** The ID the repository cached before this resolution; set when the project ID changed. */
  readonly previous?: Project.ID
  /** The worktree the project resolved from (the filesystem root for a directory outside any repository). */
  readonly directory: AbsolutePath
  readonly vcs?: Project.Vcs
}

const fakeVcs = Option.getOrUndefined(Schema.decodeUnknownOption(ProjectSchema.Vcs)(Flag.MIAO_FAKE_VCS))

/**
 * Records the project a directory resolved to. A changed project ID moves the old project's sessions and
 * workspaces to the new one; the opened worktree joins the project's directories (and its sandboxes when it
 * is a second checkout); sessions filed under the global project for this directory move to the project.
 */
export const register = Effect.fn("ProjectRegistry.register")(function* (input: Input) {
  const { db } = yield* Database.Service
  const fs = yield* FSUtil.Service
  const directories = yield* ProjectDirectories.Service
  const events = yield* EventV2.Service
  const projects = yield* Project.Service
  const global = input.id === Project.ID.global
  const worktree = global && !input.vcs ? AbsolutePath.make("/") : input.directory
  const migrating = input.previous !== undefined && input.previous !== Project.ID.global && input.previous !== input.id

  const result = yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          if (migrating) yield* migrate(tx, input.previous!, input.id)
          const row = yield* tx.select().from(ProjectTable).where(eq(ProjectTable.id, input.id)).get()
          const before = row ? ProjectMetadata.fromRow(row) : undefined
          const stored = global ? worktree : (before?.worktree ?? worktree)
          const candidates = [
            ...(before?.sandboxes ?? []),
            ...(!global && input.directory !== stored && !before?.sandboxes.includes(input.directory)
              ? [input.directory]
              : []),
          ]
          const values = {
            worktree: AbsolutePath.make(stored),
            vcs: input.vcs?.type ?? fakeVcs ?? null,
            sandboxes: (yield* Effect.filter(candidates, (sandbox) => fs.existsSafe(sandbox))).map((sandbox) =>
              AbsolutePath.make(sandbox),
            ),
            time_updated: Date.now(),
          }
          const next = yield* tx
            .insert(ProjectTable)
            .values({ id: input.id, time_created: values.time_updated, ...values })
            .onConflictDoUpdate({ target: ProjectTable.id, set: values })
            .returning()
            .get()
          if (!global) {
            yield* tx
              .update(SessionTable)
              .set({ project_id: input.id })
              .where(and(eq(SessionTable.project_id, Project.ID.global), eq(SessionTable.directory, input.directory)))
              .run()
            yield* directories.create(
              { projectID: input.id, directory: AbsolutePath.make(FSUtil.resolve(input.directory)) },
              tx,
            )
          }
          return { before, after: ProjectMetadata.fromRow(next!) }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)

  if (
    migrating ||
    !result.before ||
    result.before.worktree !== result.after.worktree ||
    result.before.vcs !== result.after.vcs ||
    result.before.sandboxes.join("\n") !== result.after.sandboxes.join("\n")
  )
    yield* events.publish(ProjectSchema.Event.Updated, result.after)
  if (!global && input.vcs) yield* projects.commit({ store: input.vcs.store, id: input.id })
  return result.after
})

// Copies the old project's row to the new ID (keeping one that already exists), moves its sessions and
// workspaces, and drops its directory list, which the new ID rebuilds as checkouts are opened.
const migrate = Effect.fnUntraced(function* (tx: ProjectDirectories.Transaction, from: Project.ID, to: Project.ID) {
  const old = yield* tx.select().from(ProjectTable).where(eq(ProjectTable.id, from)).get()
  const current = yield* tx.select().from(ProjectTable).where(eq(ProjectTable.id, to)).get()
  if (old && !current)
    yield* tx
      .insert(ProjectTable)
      .values({ ...old, id: to, time_updated: Date.now() })
      .run()
  yield* tx.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, from)).run()
  yield* tx.update(SessionTable).set({ project_id: to }).where(eq(SessionTable.project_id, from)).run()
  yield* tx.update(WorkspaceTable).set({ project_id: to }).where(eq(WorkspaceTable.project_id, from)).run()
  if (old) yield* tx.delete(ProjectTable).where(eq(ProjectTable.id, from)).run()
})

/** Uses the shortest-path favicon in a git worktree as the project icon unless one is already set. */
export const discoverIcon = Effect.fn("ProjectRegistry.discoverIcon")(function* (project: ProjectSchema.Info) {
  if (project.vcs !== "git" || project.icon?.override || project.icon?.url) return
  const fs = yield* FSUtil.Service
  const metadata = yield* ProjectMetadata.Service
  const matches = yield* fs.glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
    cwd: project.worktree,
    absolute: true,
    include: "file",
  })
  const shortest = matches.toSorted((a, b) => a.length - b.length)[0]
  if (!shortest) return
  const bytes = yield* fs.readFile(shortest)
  yield* metadata.update(project.id, {
    icon: { url: `data:${FSUtil.mimeType(shortest)};base64,${Buffer.from(bytes).toString("base64")}` },
  })
})

// Registration is bookkeeping: a failure is logged and never keeps a location from opening.
const registerLocation = Effect.gen(function* () {
  const location = yield* Location.Service
  const project = yield* register({
    id: location.project.id,
    previous: location.previous,
    directory: AbsolutePath.make(location.project.directory),
    vcs: location.vcs,
  })
  if (Flag.MIAO_EXPERIMENTAL_ICON_DISCOVERY)
    yield* discoverIcon(project).pipe(
      Effect.catchCause((cause) => Effect.logWarning("project icon discovery failed", { cause })),
      Effect.forkScoped,
    )
}).pipe(Effect.catchCause((cause) => Effect.logWarning("project registration failed", { cause })))

export const node = makeLocationNode({
  name: "project-registry",
  layer: Layer.effectDiscard(registerLocation),
  deps: [
    Location.node,
    Database.node,
    FSUtil.node,
    ProjectDirectories.node,
    EventV2.node,
    Project.node,
    ProjectMetadata.node,
  ],
})
