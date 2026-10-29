import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { EngineClient } from "@/engine/client"
import { nativeHostSource } from "../fixture/native-host-source"

test.skipIf(!process.env.MIAO_ENGINE_BIN)(
  "standing-rule snapshot and durable changes cover always, retries, revocation and restart",
  async () => {
    await using fixture = await nativeHostSource()
    const initial = (await fixture.client.request("permission_pattern_snapshot")) as {
      workspace: string
      cursor: number
      patterns: unknown[]
    }
    expect(initial).toEqual({ workspace: fixture.directory, cursor: 0, patterns: [] })
    const assertion = Effect.runFork(
      fixture.permission.assert(fixture.request("remember", "public", { save: ["public"] })),
    )
    await fixture.reply(await fixture.wait("remember"), "always")
    await Effect.runPromise(Fiber.join(assertion))
    const first = (await fixture.client.request("permission_pattern_changes", { after: initial.cursor, limit: 1 })) as {
      workspace: string
      cursor: number
      has_more: boolean
      changes: { seq: number; change: { kind: string; pattern: { id: string; workspace: string; rule: unknown } } }[]
    }
    expect(first.workspace).toBe(fixture.directory)
    expect(first.has_more).toBe(false)
    expect(first.changes).toHaveLength(1)
    expect(first.cursor).toBe(first.changes[0].seq)
    expect(first.changes[0].change).toMatchObject({
      kind: "upsert",
      pattern: {
        workspace: fixture.directory,
        source: "native",
        rule: { action: "read", resource: "public", effect: "allow" },
      },
    })
    await fixture.client.request("permission_pattern_put", {
      rule: { action: "read", resource: "public", effect: "allow" },
    })
    expect(
      await fixture.client.request("permission_pattern_changes", { after: first.cursor, limit: 256 }),
    ).toMatchObject({ cursor: first.cursor, changes: [], has_more: false })
    const id = first.changes[0].change.pattern.id
    await fixture.client.request("permission_pattern_remove", { rule_id: id })
    await fixture.client.request("permission_pattern_remove", { rule_id: id })
    const removed = (await fixture.client.request("permission_pattern_changes", {
      after: first.cursor,
      limit: 256,
    })) as { cursor: number; changes: unknown[] }
    expect(removed.changes).toHaveLength(1)
    expect(removed.changes[0]).toMatchObject({ change: { kind: "remove", id } })
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
      expect(await reopened.request("permission_pattern_snapshot")).toEqual({
        workspace: fixture.directory,
        cursor: removed.cursor,
        patterns: [],
      })
      expect(await reopened.request("permission_pattern_changes", { after: first.cursor, limit: 256 })).toEqual(removed)
      await expect(reopened.request("permission_pattern_changes", { after: 0, limit: 257 })).rejects.toMatchObject({
        code: "invalid_request",
      })
      expect(await reopened.request("permission_pattern_snapshot")).toMatchObject({ patterns: [] })
    } finally {
      await reopened.close()
    }
  },
  20_000,
)
