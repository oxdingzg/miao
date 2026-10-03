export * as WorkspaceLive from "./workspace-live"

import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { WorkspaceTable } from "./control-plane/workspace.sql"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { GitCli } from "./git-cli"
import { Project } from "./project"
import { ProjectWorktree } from "./project/worktree"
import { AbsolutePath } from "./schema"
import { SessionV2 } from "./session"
import { SessionEvent } from "./session/event"
import { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"
import { WorkspaceV2 } from "./workspace"

const ADAPTERS: WorkspaceV2.AdapterEntry[] = [
  {
    type: "worktree",
    name: "Worktree",
    description: "Create a git worktree",
  },
]

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

const unsupported = (message: string) => new WorkspaceV2.UnsupportedError({ message })

const fromWorktree = <A, R>(effect: Effect.Effect<A, ProjectWorktree.WorktreeError, R>) =>
  effect.pipe(Effect.mapError((error) => unsupported(error.message)))

const layer = Layer.effect(
  WorkspaceV2.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    const cli = yield* GitCli.Service
    const projects = yield* Project.Service
    const worktrees = yield* ProjectWorktree.Service
    const connections = new Map<WorkspaceV2.ID, WorkspaceV2.ConnectionStatus>()

    const setStatus = (id: WorkspaceV2.ID, status: WorkspaceV2.ConnectionStatus["status"]) => {
      const previous = connections.get(id)
      if (previous?.status === status) return
      connections.set(id, { workspaceID: id, status })
    }

    // Only local worktree workspaces exist under V2; remote sync was removed with the V1 routes.
    const target = Effect.fnUntraced(function* (scope: WorkspaceV2.Scope) {
      const resolved = yield* projects.resolve(AbsolutePath.make(scope.directory))
      return { projectID: scope.projectID, checkout: scope.directory, git: resolved.vcs !== undefined }
    })

    const get = Effect.fn("Workspace.get")(function* (id: WorkspaceV2.ID) {
      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return
      return fromRow(row)
    })

    const list = Effect.fn("Workspace.list")(function* (scope: WorkspaceV2.Scope) {
      return (yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, scope.projectID))
        .all()
        .pipe(Effect.orDie))
        .map(fromRow)
        .sort((a, b) => a.id.localeCompare(b.id))
    })

    const status = Effect.fn("Workspace.status")(function* (_scope: WorkspaceV2.Scope) {
      return [...connections.values()]
    })

    const adapters = Effect.fn("Workspace.adapters")(function* (_scope: WorkspaceV2.Scope) {
      return ADAPTERS
    })

    const insert = Effect.fnUntraced(function* (row: WorkspaceV2.Info) {
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: row.id,
          type: row.type,
          branch: row.branch,
          name: row.name,
          directory: row.directory,
          extra: row.extra,
          project_id: row.projectID,
          time_used: row.timeUsed,
        })
        .run()
        .pipe(Effect.orDie)
    })

    const create = Effect.fn("Workspace.create")(function* (input: WorkspaceV2.CreateInput, scope: WorkspaceV2.Scope) {
      if (input.type !== "worktree") return yield* unsupported(`Unknown workspace adapter: ${input.type}`)
      const worktreeTarget = yield* target(scope)
      const prepared = yield* fromWorktree(worktrees.prepare(worktreeTarget, { detached: true }))
      const info: WorkspaceV2.Info = {
        id: WorkspaceV2.ID.ascending(),
        type: "worktree",
        branch: null,
        name: prepared.name,
        directory: prepared.directory,
        extra: input.extra ?? null,
        projectID: scope.projectID,
        timeUsed: Date.now(),
      }
      yield* insert(info)
      yield* fromWorktree(
        worktrees.createFromInfo(worktreeTarget, {
          name: prepared.name,
          directory: prepared.directory,
        }),
      )
      setStatus(info.id, "connected")
      return info
    })

    const syncList = Effect.fn("Workspace.syncList")(function* (scope: WorkspaceV2.Scope) {
      const worktreeTarget = yield* target(scope)
      const names = new Set((yield* list(scope)).map((workspace) => workspace.name))
      const discovered = yield* fromWorktree(worktrees.list(worktreeTarget))
      yield* Effect.forEach(
        discovered,
        (item) =>
          Effect.gen(function* () {
            if (names.has(item.name)) return
            names.add(item.name)
            const info: WorkspaceV2.Info = {
              id: WorkspaceV2.ID.ascending(),
              type: "worktree",
              branch: item.branch ?? null,
              name: item.name,
              directory: item.directory,
              extra: null,
              projectID: scope.projectID,
              timeUsed: Date.now(),
            }
            yield* insert(info)
            setStatus(info.id, "connected")
          }),
        { concurrency: 1 },
      )
    })

    const remove = Effect.fn("Workspace.remove")(function* (id: WorkspaceV2.ID, scope: WorkspaceV2.Scope) {
      const worktreeTarget = yield* target(scope)
      const rows = yield* db
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.workspace_id, id))
        .all()
        .pipe(Effect.orDie)
      const ids = new Set(rows.map((row) => row.id))
      yield* Effect.forEach(
        rows.filter((row) => !row.parentID || !ids.has(row.parentID)),
        (row) => sessions.remove(row.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
        { discard: true },
      )

      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return
      connections.delete(id)
      const info = fromRow(row)
      if (info.directory) {
        yield* fromWorktree(worktrees.remove(worktreeTarget, { directory: info.directory })).pipe(
          Effect.catchCause(() =>
            Effect.logError("worktree workspace could not be removed", { directory: info.directory }),
          ),
        )
      }
      yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run().pipe(Effect.orDie)
      return info
    })

    const setWorkspace = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, workspaceID: WorkspaceV2.ID | undefined) {
      const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        location: {
          directory: info.location.directory,
          ...(workspaceID ? { workspaceID } : {}),
        },
        timestamp: yield* DateTime.now,
      })
    })

    const patchRaw = Effect.fnUntraced(function* (directory: string) {
      const [hasHead, status] = yield* Effect.all([cli.hasHead(directory), cli.status(directory)], {
        concurrency: 2,
      })
      const tracked = hasHead ? (yield* cli.patchAll(directory, "HEAD")).text : ""
      const untracked = yield* Effect.forEach(
        status.filter((item) => item.code === "??"),
        (item) => cli.patchUntracked(directory, item.file).pipe(Effect.map((patch) => patch.text)),
      )
      return [tracked, ...untracked].filter(Boolean).join("\n")
    })

    const warp = Effect.fn("Workspace.warp")(function* (input: WorkspaceV2.WarpInput, _scope: WorkspaceV2.Scope) {
      const sessionID = SessionSchema.ID.make(input.sessionID)
      const current = yield* db
        .select({ workspaceID: SessionTable.workspace_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)

      const previous = current?.workspaceID ? yield* get(current.workspaceID) : undefined
      if (current?.workspaceID && previous) {
        // "claim" the session so events from the old workspace no longer apply to it.
        yield* events.claim(sessionID, input.id ?? previous.projectID)
      }

      const sourcePatch =
        input.copyChanges && previous?.directory ? yield* patchRaw(previous.directory) : ""
      if (sourcePatch) {
        const next = input.id ? yield* get(input.id) : undefined
        if (!next?.directory) return yield* unsupported(`Workspace not found: ${input.id}`)
        const applied = yield* cli.applyPatch(next.directory, sourcePatch)
        if (applied.exitCode !== 0) return yield* unsupported("Patch can't be applied")
      }

      if (input.id === null) {
        yield* setWorkspace(sessionID, undefined)
        return
      }

      const space = yield* get(input.id)
      if (!space) return yield* unsupported(`Workspace not found: ${input.id}`)
      yield* setWorkspace(sessionID, input.id)
    })

    return WorkspaceV2.Service.of({
      list,
      status,
      adapters,
      create,
      remove,
      syncList,
      warp,
    })
  }),
)

export const node = makeGlobalNode({
  service: WorkspaceV2.Service,
  layer,
  deps: [Database.node, EventV2.node, SessionV2.node, GitCli.node, Project.node, ProjectWorktree.node],
})
