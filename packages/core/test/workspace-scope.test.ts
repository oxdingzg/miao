import { describe, expect } from "bun:test"
import { $ } from "bun"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { WorkspaceTable } from "../src/control-plane/workspace.sql"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionTable } from "../src/session/sql"
import { WorkspaceV2 } from "../src/workspace"
import { WorkspaceLive } from "../src/workspace-live"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([WorkspaceLive.node, Database.node, SessionV2.node, Project.node]), [
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
)

const fixture = Effect.gen(function* () {
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  )
  const projects = yield* Project.Service
  const sessions = yield* SessionV2.Service
  const database = yield* Database.Service
  const entries = yield* Effect.forEach(["first", "second"], (name) =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make(path.join(tmp.path, name))
      yield* Effect.promise(async () => {
        await Bun.write(path.join(directory, "README.md"), name)
        await $`git init -b main`.cwd(directory).quiet()
        await $`git config commit.gpgsign false`.cwd(directory).quiet()
        await $`git config user.email test@opencode.test`.cwd(directory).quiet()
        await $`git config user.name Test`.cwd(directory).quiet()
        await $`git add README.md`.cwd(directory).quiet()
        await $`git commit -m root`.cwd(directory).quiet()
      })
      const project = yield* projects.resolve(directory)
      const session = yield* sessions.create({ location: { directory } })
      const id = WorkspaceV2.ID.ascending()
      yield* database.db
        .insert(WorkspaceTable)
        .values({
          id,
          type: "worktree",
          name,
          directory,
          project_id: project.id,
        })
        .run()
        .pipe(Effect.orDie)
      return { id, session, scope: { projectID: project.id, directory } }
    }),
  )
  return { first: entries[0]!, second: entries[1]! }
})

const state = Effect.gen(function* () {
  const database = yield* Database.Service
  return {
    workspaces: yield* database.db.select().from(WorkspaceTable).all().pipe(Effect.orDie),
    sessions: yield* database.db.select().from(SessionTable).all().pipe(Effect.orDie),
    events: yield* database.db.select().from(EventTable).all().pipe(Effect.orDie),
    sequences: yield* database.db.select().from(EventSequenceTable).all().pipe(Effect.orDie),
  }
})

describe("workspace project scope", () => {
  it.live("does not remove another project's workspace or its sessions", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const database = yield* Database.Service
      const workspaces = yield* WorkspaceV2.Service
      yield* database.db
        .update(SessionTable)
        .set({ workspace_id: test.second.id })
        .where(eq(SessionTable.id, test.second.session.id))
        .run()
        .pipe(Effect.orDie)
      const before = yield* state
      yield* workspaces.remove(test.second.id, test.first.scope)
      expect(yield* state).toEqual(before)
      expect(yield* Effect.promise(() => Bun.file(path.join(test.second.scope.directory, "README.md")).text())).toBe(
        "second",
      )
    }),
  )

  it.live("rejects moving a local session into another project's workspace before writing events", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const workspaces = yield* WorkspaceV2.Service
      const before = yield* state
      const result = yield* workspaces
        .warp({ id: test.second.id, sessionID: test.first.session.id, copyChanges: true }, test.first.scope)
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* state).toEqual(before)
    }),
  )

  it.live("rejects changing another project's session even when the target workspace is local", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const workspaces = yield* WorkspaceV2.Service
      const before = yield* state
      const result = yield* workspaces
        .warp({ id: test.first.id, sessionID: test.second.session.id }, test.first.scope)
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* state).toEqual(before)
    }),
  )

  it.live("leaves dangling sessions untouched when the requested workspace does not exist", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const database = yield* Database.Service
      const workspaces = yield* WorkspaceV2.Service
      const missing = WorkspaceV2.ID.ascending()
      yield* database.db
        .update(SessionTable)
        .set({ workspace_id: missing })
        .where(eq(SessionTable.id, test.first.session.id))
        .run()
        .pipe(Effect.orDie)
      const before = yield* state
      expect(yield* workspaces.remove(missing, test.first.scope)).toBeUndefined()
      expect(yield* state).toEqual(before)
    }),
  )

  it.live("validates the destination before changing the existing event owner", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const database = yield* Database.Service
      const workspaces = yield* WorkspaceV2.Service
      yield* database.db
        .update(SessionTable)
        .set({ workspace_id: test.first.id })
        .where(eq(SessionTable.id, test.first.session.id))
        .run()
        .pipe(Effect.orDie)
      const before = yield* state
      const result = yield* workspaces
        .warp({ id: WorkspaceV2.ID.ascending(), sessionID: test.first.session.id }, test.first.scope)
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* state).toEqual(before)
    }),
  )

  it.live("still moves and detaches a session within its project", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const database = yield* Database.Service
      const workspaces = yield* WorkspaceV2.Service
      yield* workspaces.warp({ id: test.first.id, sessionID: test.first.session.id }, test.first.scope)
      const moved = yield* database.db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, test.first.session.id))
        .get()
        .pipe(Effect.orDie)
      expect(moved?.workspace_id).toBe(test.first.id)
      yield* workspaces.warp({ id: null, sessionID: test.first.session.id }, test.first.scope)
      const detached = yield* database.db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, test.first.session.id))
        .get()
        .pipe(Effect.orDie)
      expect(detached?.workspace_id).toBeNull()
    }),
  )

  it.live("only lists connection statuses for the requested project", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const workspaces = yield* WorkspaceV2.Service
      const first = yield* workspaces.create({ type: "worktree" }, test.first.scope)
      const second = yield* workspaces.create({ type: "worktree" }, test.second.scope)
      expect(yield* workspaces.status(test.first.scope)).toEqual([{ workspaceID: first.id, status: "connected" }])
      expect(yield* workspaces.status(test.second.scope)).toEqual([{ workspaceID: second.id, status: "connected" }])
    }),
  )
})
