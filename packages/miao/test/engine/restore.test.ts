import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { EngineSession, type EngineSessionEvent } from "@/engine/session"
import { tmpdir } from "../fixture/fixture"

test.each(["cursor", "session", "gap", "time", "empty"])(
  "restore refuses %s corruption before live attachment",
  async (scenario) => {
    await using tmp = await tmpdir()
    const client = EngineClient.start({
      binary: path.join(import.meta.dir, "../fixture/engine-replay-fake.ts"),
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      env: { MIAO_REPLAY_FIXTURE: scenario },
    })
    const events: EngineSessionEvent[] = []
    const facade = new EngineSession(client, (event) => events.push(event))
    try {
      await expect(facade.restore("ses_restore_invalid")).rejects.toMatchObject({
        code: scenario === "cursor" ? "engine_snapshot_invalid" : "engine_replay_invalid",
      })
      expect(events).toHaveLength(0)
      const first = await client.request("calls", {})
      expect(first).not.toContain("subscribe")
      await expect(facade.restore("ses_restore_invalid")).rejects.toMatchObject({
        code: scenario === "cursor" ? "engine_snapshot_invalid" : "engine_replay_invalid",
      })
      const retried = await client.request("calls", {})
      expect(Array.isArray(retried) && retried.filter((call) => call === "snapshot").length).toBe(2)
      expect(retried).not.toContain("subscribe")
    } finally {
      await client.close()
    }
  },
)

test("restore refuses an already live-attached Session instead of mixing replay cursors", async () => {
  await using tmp = await tmpdir()
  const client = EngineClient.start({
    binary: path.join(import.meta.dir, "../fixture/engine-fake.ts"),
    db: path.join(tmp.path, "engine.db"),
    workspace: tmp.path,
    model: "fixture",
  })
  const facade = new EngineSession(client, () => {})
  try {
    await facade.prompt("ses_live_attached", "prompt")
    await expect(facade.restore("ses_live_attached")).rejects.toMatchObject({ code: "engine_already_subscribed" })
  } finally {
    await client.close()
  }
})
