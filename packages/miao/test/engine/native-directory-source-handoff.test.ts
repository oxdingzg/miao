import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Record = Schema.Struct({
  workspace: Schema.String,
  target: Schema.Struct({
    authority: Schema.String,
    project: Schema.String,
    directory: Schema.String,
    workspace_id: Schema.Null,
  }),
  state: Schema.Literals(["prepared", "completed"]),
  fingerprint: Schema.String,
  patterns: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      workspace: Schema.String,
      source: Schema.Literal("native"),
      created_at_ms: Schema.Number,
      rule: Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.Literal("allow") }),
    }),
  ),
})
const Destination = Schema.Struct({ project: Schema.Struct({ authority: Schema.String }) })
const failure = (request: Promise<unknown>) =>
  request.then(
    () => undefined,
    (error: unknown) => error,
  )

test.skipIf(!binary)(
  "directory source control freezes, imports and completes across lost acknowledgements",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "workspace")
    await Bun.write(path.join(directory, "keep"), "fixture")
    const db = path.join(tmp.path, "engine.db")
    const openLegacy = () =>
      EngineClient.start({
        binary: binary!,
        db,
        workspace: directory,
        model: "fixture",
        provider: "anthropic",
        endpoint: "http://127.0.0.1:9",
        env: { ANTHROPIC_API_KEY: "fixture-only" },
      })
    const openSource = (project = "project") =>
      EngineClient.startPermissionSource({ binary: binary!, db, project, directory })
    const seed = openLegacy()
    try {
      await seed.request("permission_pattern_put", { rule: { action: "read", resource: "a/**", effect: "allow" } })
      await seed.request("permission_pattern_put", { rule: { action: "read", resource: "b/**", effect: "allow" } })
    } finally {
      await seed.close()
    }
    const source = openSource()
    const destination = EngineClient.startPermissionStore({
      binary: binary!,
      db: path.join(tmp.path, "permissions.db"),
      project: "project",
      context: { directory },
    })
    const clients = [source, destination]
    try {
      expect(capabilities(binary!)?.permissionSourceHandoff).toBe(1)
      expect(await source.request("snapshot")).toBeNull()
      const authority = Schema.decodeUnknownSync(Destination)(await destination.request("context_snapshot")).project
        .authority
      const prepared = Schema.decodeUnknownSync(Record)(await source.request("prepare", { authority }))
      expect(prepared.state).toBe("prepared")
      expect(prepared.target.project).toBe("project")
      expect(prepared.patterns).toHaveLength(2)
      expect(await source.request("prepare", { authority })).toEqual(prepared)
      expect(await failure(source.request("prepare", { authority: "replacement" }))).toMatchObject({
        code: "invalid_request",
      })
      for (const override of [
        { project: "foreign" },
        { directory: "/foreign" },
        { workspace_id: "explicit" },
        { db: "/foreign.db" },
      ])
        expect(await failure(source.request("prepare", { authority, ...override }))).toMatchObject({
          code: "invalid_request",
        })
      const legacy = openLegacy()
      clients.push(legacy)
      expect(await failure(legacy.request("permission_pattern_list"))).toMatchObject({ code: "invalid_request" })
      expect(
        await failure(
          legacy.request("permission_pattern_put", { rule: { action: "read", resource: "late/**", effect: "allow" } }),
        ),
      ).toMatchObject({ code: "invalid_request" })
      for (const rules of [[], [{ action: "read", resource: "late/**", effect: "allow" }]])
        expect(
          await failure(legacy.request("permission_saved_snapshot", { workspace: directory, rules })),
        ).toMatchObject({ code: "invalid_request" })
      await destination.request("context_handoff", { authority, patterns: prepared.patterns })
      await destination.request("context_remove", { id: prepared.patterns[0].id })
      const revoked = await destination.request("context_snapshot")
      await source.close()
      const resumed = openSource()
      const foreign = openSource("foreign")
      clients.push(resumed, foreign)
      expect(await resumed.request("snapshot")).toEqual(prepared)
      expect(
        await destination.request("context_handoff", { authority, patterns: [...prepared.patterns].reverse() }),
      ).toEqual(revoked)
      expect(await failure(foreign.request("snapshot"))).toMatchObject({ code: "invalid_request" })
      expect(await failure(foreign.request("complete", { snapshot: revoked }))).toMatchObject({
        code: "invalid_request",
      })
      const completed = Schema.decodeUnknownSync(Record)(await resumed.request("complete", { snapshot: revoked }))
      expect(completed.state).toBe("completed")
      expect(completed.patterns).toEqual(prepared.patterns)
      expect(await resumed.request("prepare", { authority })).toEqual(completed)
      expect(await resumed.request("complete", { snapshot: revoked })).toEqual(completed)
      const database = new Database(db, { readonly: true })
      try {
        expect(database.query("SELECT COUNT(*) AS count FROM engine_owned_permission_rule_legacy").get()).toEqual({
          count: 2,
        })
        expect(database.query("SELECT COUNT(*) AS count FROM engine_session").get()).toEqual({ count: 0 })
      } finally {
        database.close()
      }
    } finally {
      await Promise.all(clients.map((client) => client.close()))
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "source control refuses missing databases without creating storage",
  async () => {
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "missing.db")
    const client = EngineClient.startPermissionSource({ binary: binary!, db, project: "project", directory: tmp.path })
    try {
      expect(await failure(client.request("snapshot"))).toBeInstanceOf(Error)
      expect(await Bun.file(db).exists()).toBe(false)
    } finally {
      await client.close()
    }
  },
  10_000,
)
