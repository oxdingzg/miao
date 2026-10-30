import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { handoffNativeDirectoryPermissions } from "@/engine/native-directory-permission-handoff"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Snapshot = Schema.Struct({ authority: Schema.String })
const Changes = Schema.Struct({
  changes: Schema.Array(Schema.Unknown),
  cursor: Schema.Struct({ authority: Schema.String, seq: Schema.Number }),
})

test.skipIf(!binary)(
  "shared SDK startup bootstraps without a model and uses Root controls after paired handoff",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await Bun.write(path.join(workspace, "fixture"), "fixture")
    const db = path.join(tmp.path, "engine.db")
    const root = path.join(tmp.path, "permissions.db")
    const destination = EngineClient.startPermissionStore({
      binary: binary!,
      db: root,
      project: "fixture",
      context: { directory: workspace },
    })
    const source = EngineClient.startPermissionSource({
      binary: binary!,
      db,
      project: "fixture",
      directory: workspace,
      initialize: true,
    })
    const supported = capabilities(binary!)
    if (!supported) throw new Error("native capabilities unavailable")
    const before = Schema.decodeUnknownSync(Snapshot)(await destination.request("snapshot"))
    try {
      await destination.request("handoff", { authority: before.authority, rules: [] })
      await handoffNativeDirectoryPermissions({ projectID: "fixture", source, destination, capabilities: supported })
    } finally {
      await Promise.all([source.close(), destination.close()])
    }
    const client = EngineClient.start({
      binary: binary!,
      db,
      workspace,
      model: "fixture",
      provider: "openai-chat",
      endpoint: "http://127.0.0.1:9",
      env: { OPENAI_API_KEY: "fixture-only" },
      sharedPermission: { db: root, project: "fixture" },
    })
    try {
      const snapshot = await client.request("shared_permission_snapshot")
      expect(snapshot).toMatchObject({
        snapshot: { project: { authority: before.authority } },
        cursor: { authority: before.authority },
      })
      const observed = Schema.decodeUnknownSync(
        Schema.Struct({ cursor: Schema.Struct({ authority: Schema.String, seq: Schema.Number }) }),
      )(snapshot)
      await client.request("permission_pattern_put", {
        rule: { action: "read", resource: "public/**", effect: "allow" },
      })
      const changes = Schema.decodeUnknownSync(Changes)(
        await client.request("shared_permission_changes", { after: observed.cursor, limit: 16 }),
      )
      expect(changes.cursor.authority).toBe(before.authority)
      expect(changes.changes.length).toBeGreaterThan(0)
      expect(await client.request("permission_pattern_list")).toHaveLength(1)
      const denied = await client.request("permission_saved_snapshot", { workspace, rules: [] }).then(
        () => false,
        () => true,
      )
      expect(denied).toBe(true)
      expect(await client.request("sessions")).toEqual([])
      expect(await client.request("shared_permission_snapshot")).toMatchObject({
        snapshot: { patterns: [{ rule: { resource: "public/**" } }] },
      })
    } finally {
      await client.close()
    }
  },
  30_000,
)
