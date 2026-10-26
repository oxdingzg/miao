import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { AbsolutePath } from "@miao/core/schema"
import { readCatalog } from "@/engine/catalog"
import { capabilities } from "@/engine/discovery"
import { EngineClient } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
test("a storage file that is already gone answers no facts instead of a conflict", async () => {
  // A placement can outlive its storage. The reader must not be spawned for a
  // path no one can open — a bogus binary proves no child ran — and the empty
  // answer is what keeps a listing from warning about the row on every refresh.
  const result = await Effect.runPromise(
    readCatalog("/nonexistent/miao-engine", {
      storage: AbsolutePath.make(path.join(process.env.TMPDIR ?? "/tmp", `missing-${crypto.randomUUID()}.db`)),
      location: { directory: AbsolutePath.make(process.env.TMPDIR ?? "/tmp") },
      sessions: [SessionID.make("ses_missing")],
      usage: true,
    }),
  )
  expect(result).toEqual([])
})
test.skipIf(!binary || capabilities(binary)?.catalog !== 1)(
  "catalog subprocess reads live storage without changing its owner or durable cursor",
  async () => {
    await using tmp = await tmpdir()
    const storage = AbsolutePath.make(path.join(tmp.path, "engine.db"))
    const client = EngineClient.start({
      binary: binary!,
      db: storage,
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    try {
      await client.request("initialize", { session_id: "ses_catalog", title: "live title" })
      const before = await client.request("snapshot", { session_id: "ses_catalog" })
      const result = await Effect.runPromise(
        readCatalog(binary!, {
          storage,
          location: { directory: AbsolutePath.make(tmp.path) },
          sessions: [SessionID.make("ses_catalog"), SessionID.make("ses_missing")],
          usage: true,
        }),
      )
      expect(result.map((entry) => entry.snapshot.title)).toEqual(["live title"])
      expect(result[0]?.usage).toBeDefined()
      const longID = SessionID.make(`ses_${"x".repeat(252)}`)
      await client.request("initialize", { session_id: longID, title: "long identity" })
      const longBefore = await client.request("snapshot", { session_id: longID })
      const sessions = Array.from({ length: 200 }, () => longID)
      expect(JSON.stringify(sessions).length).toBeGreaterThan(32_767)
      const longPage = await Effect.runPromise(
        readCatalog(binary!, {
          storage,
          location: { directory: AbsolutePath.make(tmp.path) },
          sessions,
          usage: false,
        }),
      )
      expect(longPage).toHaveLength(200)
      expect(longPage.every((entry) => entry.sessionID === longID && entry.snapshot.title === "long identity")).toBe(
        true,
      )
      expect(await client.request("snapshot", { session_id: longID })).toEqual(longBefore)
      expect(client.available).toBe(true)
      expect(await client.request("snapshot", { session_id: "ses_catalog" })).toEqual(before)
    } finally {
      await client.close()
    }
  },
)
