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
      expect(client.available).toBe(true)
      expect(await client.request("snapshot", { session_id: "ses_catalog" })).toEqual(before)
    } finally {
      await client.close()
    }
  },
)
