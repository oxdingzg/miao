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
