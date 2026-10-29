import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Schema } from "effect"
import { EngineClient, permissionEnvironment } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Snapshot = Schema.Struct({
  authority: Schema.String,
  project: Schema.String,
  revision: Schema.Number,
  migration: Schema.Unknown,
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      origin: Schema.Literals(["native", "legacy"]),
      rule: Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literal("allow") }),
    }),
  ),
})
const snapshot = async (client: EngineClient) => Schema.decodeUnknownSync(Snapshot)(await client.request("snapshot"))

test("permission control environment carries process basics without model credentials", () => {
  expect(
    permissionEnvironment({
      PATH: "fixture-path",
      SystemRoot: "C:/Windows",
      HOME: "/fixture-home",
      OPENAI_API_KEY: "fixture-key",
      AWS_SECRET_ACCESS_KEY: "fixture-key",
      OTHER_TOKEN: "fixture-key",
    }),
  ).toEqual({ PATH: "fixture-path", SystemRoot: "C:/Windows", HOME: "/fixture-home" })
})

test.skipIf(!binary)(
  "model-free project controllers share rules, preserve scope and survive restart",
  async () => {
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "permissions.db")
    expect(capabilities(binary!)?.permissionProjectStore).toBe(1)
    const first = EngineClient.startPermissionStore({ binary: binary!, db, project: "project" })
    const peer = EngineClient.startPermissionStore({ binary: binary!, db, project: "project" })
    const global = EngineClient.startPermissionStore({ binary: binary!, db, project: "global" })
    try {
      const initial = await Promise.all([snapshot(first), snapshot(peer), snapshot(global)])
      expect(initial.map((value) => value.revision)).toEqual([0, 0, 0])
      expect(new Set(initial.map((value) => value.authority)).size).toBe(1)
      const native = Schema.decodeUnknownSync(Snapshot)(
        await peer.request("put", { rule: { action: "read", resource: "native/**", effect: "allow" } }),
      )
      expect(native.rules[0].origin).toBe("native")
      expect(native.rules[0].id.startsWith("psv_native_project_")).toBe(true)
      expect(await snapshot(first)).toEqual(native)
      expect((await snapshot(global)).rules).toEqual([])
      const input = {
        rules: ["legacy-b", "legacy-a"].map((id) => ({
          id,
          rule: { action: "read", resource: "public/**", effect: "allow" },
        })),
      }
      const imported = Schema.decodeUnknownSync(Snapshot)(await first.request("migrate", input))
      expect(imported.revision).toBe(2)
      expect(imported.rules).toHaveLength(3)
      expect(await peer.request("remove", { id: "legacy-a" })).toEqual({ removed: true })
      expect(await peer.request("remove", { id: "legacy-a" })).toEqual({ removed: false })
      const revoked = await snapshot(first)
      expect(revoked.revision).toBe(3)
      expect(revoked.rules.map((value) => value.id)).not.toContain("legacy-a")
      expect(
        Schema.decodeUnknownSync(Snapshot)(await first.request("migrate", { rules: [...input.rules].reverse() })),
      ).toEqual(revoked)
      await first.close()
      await peer.close()
      const reopened = EngineClient.startPermissionStore({ binary: binary!, db, project: "project" })
      try {
        expect(await snapshot(reopened)).toEqual(revoked)
      } finally {
        await reopened.close()
      }
      const database = new Database(db, { readonly: true })
      try {
        expect(database.query("SELECT name FROM sqlite_schema WHERE name LIKE 'engine_%'").all()).toEqual([])
      } finally {
        database.close()
      }
    } finally {
      await Promise.all([first.close(), peer.close(), global.close()])
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "invalid control frames and oversized input refuse without changing scope or killing reads",
  async () => {
    await using tmp = await tmpdir()
    const client = EngineClient.startPermissionStore({
      binary: binary!,
      db: path.join(tmp.path, "permissions.db"),
      project: "project",
    })
    try {
      const before = await snapshot(client)
      for (const response of await Promise.all(
        [
          client.request("put", { project: "foreign", rule: { action: "read", resource: "*", effect: "allow" } }),
          client.request("migrate", { workspace: "/foreign", rules: [] }),
          client.request("put", { rule: { action: "read", resource: "*", effect: "deny" } }),
          client.request("admit", { session_id: "not-a-session" }),
        ].map(failure),
      ))
        expect(response).toMatchObject({ code: "invalid_request" })
      expect(await snapshot(client)).toEqual(before)
      const oversized = await failure(
        client.request("put", { rule: { action: "read", resource: "x".repeat(17 * 1024 * 1024), effect: "allow" } }),
      )
      expect(oversized).toMatchObject({ code: "request_too_large" })
      expect(await snapshot(client)).toEqual(before)
      expect(client.available).toBe(true)
    } finally {
      await client.close()
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "permission control refuses a Session or foreign database before serving requests",
  async () => {
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "foreign.db")
    const database = new Database(db)
    database.exec("CREATE TABLE sentinel(value INTEGER); INSERT INTO sentinel VALUES(42)")
    database.close()
    const client = EngineClient.startPermissionStore({ binary: binary!, db, project: "project" })
    try {
      expect(await failure(client.request("snapshot"))).toMatchObject({
        code: "engine_closed",
        message: expect.stringContaining("unsupported project permission database"),
      })
      const reader = new Database(db, { readonly: true })
      try {
        expect(reader.query("SELECT value FROM sentinel").get()).toEqual({ value: 42 })
      } finally {
        reader.close()
      }
    } finally {
      await client.close()
    }
  },
  10_000,
)

function failure(request: Promise<unknown>) {
  return request.then(
    () => undefined,
    (error: unknown) => error,
  )
}

const ContextSnapshot = Schema.Struct({
  project: Snapshot,
  directory: Schema.String,
  workspace_id: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  migration: Schema.Unknown,
  patterns: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      workspace: Schema.String,
      rule: Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literal("allow") }),
      source: Schema.Literal("native"),
      created_at_ms: Schema.Number,
    }),
  ),
})
const contextSnapshot = async (client: EngineClient) =>
  Schema.decodeUnknownSync(ContextSnapshot)(await client.request("context_snapshot"))

test.skipIf(!binary)(
  "bound directory controllers share project rules without leaking directory grants or reviving revocations",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "a")
    const otherDirectory = path.join(tmp.path, "b")
    await Bun.write(path.join(directory, "keep"), "fixture")
    await Bun.write(path.join(otherDirectory, "keep"), "fixture")
    const db = path.join(tmp.path, "permissions.db")
    const open = (project: string, directory: string, workspaceID?: string) =>
      EngineClient.startPermissionStore({ binary: binary!, db, project, context: { directory, workspaceID } })
    const first = open("project", directory)
    const peer = open("project", directory)
    const other = open("project", otherDirectory)
    const explicit = open("project", directory, "explicit-workspace")
    const foreign = open("foreign", directory)
    const clients = [first, peer, other, explicit, foreign]
    try {
      expect(capabilities(binary!)?.permissionContextStore).toBe(1)
      const initial = await Promise.all(clients.map(contextSnapshot))
      expect(initial.map((value) => value.patterns)).toEqual([[], [], [], [], []])
      expect(initial[0].workspace_id).toBeNull()
      expect(initial[3].workspace_id).toBe("explicit-workspace")
      const project = Schema.decodeUnknownSync(Snapshot)(
        await peer.request("put", { rule: { action: "read", resource: "project/**", effect: "allow" } }),
      )
      const own = Schema.decodeUnknownSync(ContextSnapshot)(
        await first.request("context_put", { rule: { action: "read", resource: "directory/**", effect: "allow" } }),
      )
      expect(own.project).toEqual(project)
      expect(own.directory).toBe(process.platform === "win32" ? path.toNamespacedPath(directory) : directory)
      expect(await contextSnapshot(peer)).toEqual(own)
      expect((await contextSnapshot(other)).project).toEqual(project)
      expect((await contextSnapshot(other)).patterns).toEqual([])
      expect((await contextSnapshot(explicit)).patterns).toEqual([])
      expect((await contextSnapshot(foreign)).project.rules).toEqual([])
      expect(await first.request("context_remove", { id: project.rules[0].id })).toEqual({ removed: false })
      await foreign.request("context_put", { rule: { action: "read", resource: "legacy-a/**", effect: "allow" } })
      const input = Schema.decodeUnknownSync(ContextSnapshot)(
        await foreign.request("context_put", { rule: { action: "read", resource: "legacy-b/**", effect: "allow" } }),
      ).patterns
      const migrated = Schema.decodeUnknownSync(ContextSnapshot)(
        await first.request("context_migrate", { patterns: input }),
      )
      expect(migrated.patterns).toHaveLength(3)
      expect(migrated.patterns).toEqual(expect.arrayContaining(input))
      expect(await peer.request("context_remove", { id: input[0].id })).toEqual({ removed: true })
      const revoked = await contextSnapshot(first)
      expect(revoked.revision).toBe(3)
      expect(
        Schema.decodeUnknownSync(ContextSnapshot)(
          await peer.request("context_migrate", { patterns: [...input].reverse() }),
        ),
      ).toEqual(revoked)
      expect(await failure(first.request("context_migrate", { patterns: [] }))).toMatchObject({
        code: "invalid_request",
      })
      expect(
        await failure(
          first.request("context_put", {
            directory: otherDirectory,
            rule: { action: "read", resource: "escape/**", effect: "allow" },
          }),
        ),
      ).toMatchObject({ code: "invalid_request" })
      await first.close()
      const reopened = open("project", directory)
      clients.push(reopened)
      expect(await contextSnapshot(reopened)).toEqual(revoked)
      expect((await contextSnapshot(foreign)).patterns).toEqual(input)
      expect((await contextSnapshot(other)).patterns).toEqual([])
    } finally {
      await Promise.all(clients.map((client) => client.close()))
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "unbound and invalid directory controls fail without creating a database",
  async () => {
    await using tmp = await tmpdir()
    const unbound = EngineClient.startPermissionStore({
      binary: binary!,
      db: path.join(tmp.path, "unbound.db"),
      project: "project",
    })
    try {
      expect(await failure(unbound.request("context_snapshot"))).toMatchObject({ code: "invalid_request" })
      expect((await snapshot(unbound)).rules).toEqual([])
    } finally {
      await unbound.close()
    }
    await Bun.write(path.join(tmp.path, "file"), "fixture")
    for (const directory of ["", path.join(tmp.path, "missing"), path.join(tmp.path, "file")]) {
      const db = path.join(tmp.path, `invalid-${directory.length}.db`)
      const client = EngineClient.startPermissionStore({
        binary: binary!,
        db,
        project: "project",
        context: { directory },
      })
      try {
        expect(await failure(client.request("context_snapshot"))).toBeInstanceOf(Error)
        expect(await Bun.file(db).exists()).toBe(false)
      } finally {
        await client.close()
      }
    }
  },
  30_000,
)
