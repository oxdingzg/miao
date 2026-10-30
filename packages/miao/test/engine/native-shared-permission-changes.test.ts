import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { rename } from "node:fs/promises"
import { Schema } from "effect"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Cursor = Schema.Struct({ authority: Schema.String, seq: Schema.Number })
const Observation = Schema.Struct({ snapshot: Schema.Unknown, cursor: Cursor })
const Page = Schema.Struct({
  cursor: Cursor,
  changes: Schema.Array(Schema.Struct({ seq: Schema.Number, scope: Schema.Unknown, revision: Schema.Number, recorded_at_ms: Schema.Number })),
  has_more: Schema.Boolean,
})

test.skipIf(!binary)("shared permission changes cross real control processes without leaking directory scopes", async () => {
  await using tmp = await tmpdir()
  const db = path.join(tmp.path, "permissions.db")
  const context = { directory: tmp.path }
  const first = EngineClient.startPermissionStore({ binary: binary!, db, project: "p", context })
  const peer = EngineClient.startPermissionStore({ binary: binary!, db, project: "p", context })
  const explicit = EngineClient.startPermissionStore({ binary: binary!, db, project: "p", context: { ...context, workspaceID: "explicit" } })
  const foreign = EngineClient.startPermissionStore({ binary: binary!, db, project: "foreign" })
  try {
    expect(capabilities(binary!)?.permissionChangefeed).toBe(1)
    const initial = Schema.decodeUnknownSync(Observation)(await first.request("context_observe"))
    const inserted = Schema.decodeUnknownSync(Schema.Struct({ rules: Schema.Array(Schema.Struct({ id: Schema.String })) }))(
      await peer.request("put", { rule: { action: "read", resource: "project/**", effect: "allow" } }),
    )
    await explicit.request("context_put", { rule: { action: "read", resource: "explicit/**", effect: "allow" } })
    await peer.request("context_put", { rule: { action: "read", resource: "local/**", effect: "allow" } })
    await foreign.request("put", { rule: { action: "read", resource: "foreign/**", effect: "allow" } })
    const page = Schema.decodeUnknownSync(Page)(await first.request("context_changes", { after: initial.cursor, limit: 1 }))
    expect(page.changes.map((change) => change.seq)).toEqual([1])
    expect(page.has_more).toBe(true)
    const last = Schema.decodeUnknownSync(Page)(await first.request("context_changes", { after: page.cursor, limit: 1 }))
    expect(last.changes.map((change) => change.seq)).toEqual([3])
    expect(last.has_more).toBe(false)
    expect(last.cursor.seq).toBe(4)
    expect(last.changes[0].scope).toMatchObject({ type: "directory", workspace_id: null })
    const project = Schema.decodeUnknownSync(Page)(await first.request("changes", { after: initial.cursor, limit: 256 }))
    expect(project.changes.map((change) => change.seq)).toEqual([1, 2, 3])
    await peer.request("remove", { id: inserted.rules[0].id })
    await peer.request("remove", { id: inserted.rules[0].id })
    const revoked = Schema.decodeUnknownSync(Page)(await first.request("context_changes", { after: last.cursor, limit: 256 }))
    expect(revoked.cursor.seq).toBe(5)
    expect(revoked.changes.map((change) => change.revision)).toEqual([2])
    expect(revoked.changes[0].scope).toEqual({ type: "project" })
    await first.close()
    const reopened = EngineClient.startPermissionStore({ binary: binary!, db, project: "p", context })
    try {
      const replay = Schema.decodeUnknownSync(Page)(await reopened.request("context_changes", { after: initial.cursor, limit: 256 }))
      expect(replay.changes.map((change) => change.seq)).toEqual([1, 3, 5])
      expect(replay.cursor).toEqual(revoked.cursor)
    } finally { await reopened.close() }
    using stored = new Database(db, { readonly: true })
    expect(stored.query("select name from sqlite_schema where name like 'engine_%'").all()).toEqual([])
    expect(stored.query("pragma user_version").get()).toEqual({ user_version: 5 })
  } finally { await Promise.all([first.close(), peer.close(), explicit.close(), foreign.close()]) }
}, 30_000)

test.skipIf(!binary)("shared permission control refuses replaced-root and future cursors while remaining readable", async () => {
  await using tmp = await tmpdir()
  const db = path.join(tmp.path, "permissions.db")
  const first = EngineClient.startPermissionStore({ binary: binary!, db, project: "p" })
  const initial = Schema.decodeUnknownSync(Observation)(await first.request("observe"))
  await first.close()
  await rename(db, db + ".old")
  const replaced = EngineClient.startPermissionStore({ binary: binary!, db, project: "p", requestTimeoutMs: 5000 })
  try {
    const current = Schema.decodeUnknownSync(Observation)(await replaced.request("observe"))
    expect(current.cursor.authority).not.toBe(initial.cursor.authority)
    for (const input of [
      { after: initial.cursor, limit: 1 },
      { after: { ...current.cursor, seq: 1 }, limit: 1 },
      { after: current.cursor, limit: 257 },
    ]) {
      const failure = await replaced.request("changes", input).then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({ code: "invalid_request" })
    }
    expect(Schema.decodeUnknownSync(Observation)(await replaced.request("observe"))).toEqual(current)
  } finally { await replaced.close() }
}, 30_000)
