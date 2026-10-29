import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EngineClient } from "@/engine/client"
import { nativeHostSource } from "../fixture/native-host-source"

const Snapshot = Schema.Struct({
  workspace: Schema.String,
  cursor: Schema.Number,
  migration: Schema.Unknown,
  rules: Schema.Array(Schema.Unknown),
})
const Page = Schema.Struct({ cursor: Schema.Number, changes: Schema.Array(Schema.Unknown), has_more: Schema.Boolean })

test.skipIf(!process.env.MIAO_ENGINE_BIN)(
  "import snapshot and cursor survive handoff, revoke and transport restart",
  async () => {
    await using fixture = await nativeHostSource()
    expect(fixture.supported.permissionImportChanges).toBe(1)
    const initial = Schema.decodeUnknownSync(Snapshot)(await fixture.client.request("permission_import_snapshot"))
    expect(initial).toEqual({ workspace: fixture.directory, cursor: 0, migration: null, rules: [] })
    const input = {
      project: "legacy-project",
      rules: [{ id: "legacy-row", rule: { action: "read", resource: "public", effect: "allow" } }],
    }
    const receipt = await fixture.client.request("permission_saved_migrate", input)
    const first = Schema.decodeUnknownSync(Page)(
      await fixture.client.request("permission_import_changes", { after: initial.cursor, limit: 1 }),
    )
    expect(first.has_more).toBe(false)
    expect(first.changes).toHaveLength(1)
    expect(first.changes[0]).toMatchObject({ change: { kind: "migrated", receipt, rules: input.rules } })
    await fixture.client.request("permission_saved_remove", { id: "legacy-row" })
    await fixture.client.request("permission_saved_migrate", input)
    const second = Schema.decodeUnknownSync(Page)(
      await fixture.client.request("permission_import_changes", { after: first.cursor, limit: 1 }),
    )
    expect(second.changes).toHaveLength(1)
    expect(second.changes[0]).toMatchObject({ change: { kind: "removed", id: "legacy-row" } })
    const snapshot = Schema.decodeUnknownSync(Snapshot)(await fixture.client.request("permission_import_snapshot"))
    expect(snapshot.cursor).toBe(second.cursor)
    expect(snapshot.migration).toEqual(receipt)
    expect(snapshot.rules).toEqual([])
    expect(await fixture.client.request("permission_pattern_changes", { after: 0, limit: 256 })).toMatchObject({
      cursor: 0,
      changes: [],
      has_more: false,
    })
    await fixture.client.close()
    const reopened = EngineClient.start({
      binary: process.env.MIAO_ENGINE_BIN!,
      db: fixture.storage,
      workspace: fixture.directory,
      model: "fixture",
      provider: "openai-chat",
      endpoint: "http://127.0.0.1:9",
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    try {
      expect(await reopened.request("permission_import_snapshot")).toEqual(snapshot)
      expect(await reopened.request("permission_import_changes", { after: second.cursor, limit: 256 })).toMatchObject({
        cursor: second.cursor,
        changes: [],
      })
      await expect(reopened.request("permission_import_changes", { after: 0, limit: 257 })).rejects.toThrow()
    } finally {
      await reopened.close()
    }
  },
  20_000,
)
