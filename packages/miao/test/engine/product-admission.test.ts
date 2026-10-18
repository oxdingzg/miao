import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { EngineSession } from "@/engine/session"
import { SessionID } from "@miao/schema/session-id"
import { DateTime } from "effect"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "product admission retains durable time and identity, reconciles exact retries, and refuses unsupported input before admission",
  async () => {
    await using tmp = await tmpdir()
    if (!binary) throw new Error("missing native binary")
    const client = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    const facade = new EngineSession(client, () => {})
    const input = { sessionID: SessionID.descending("ses_product_admission"), prompt: { text: "text" }, resume: false }
    try {
      for (const prompt of [
        { text: "audio", files: [{ uri: "data:audio/wav;base64,YQ==", mime: "audio/wav" }] },
        { text: "agents", agents: [{ name: "selected" }] },
        { text: "command", command: { name: "custom", arguments: "", subtask: false } },
      ])
        await expect(facade.promptProduct({ ...input, prompt })).rejects.toMatchObject({
          code: "engine_prompt_unsupported",
        })
      expect(await client.request("events", { session_id: input.sessionID, after: 0 })).toEqual([])
      const first = await facade.promptProduct(input)
      expect(first.id).toMatch(/^msg_/)
      expect(first).toMatchObject({ sessionID: input.sessionID, delivery: "steer", prompt: input.prompt })
      const page = await client.request("events", { session_id: input.sessionID, after: first.admittedSeq - 1 })
      expect(page).toMatchObject([{ recorded_at_ms: DateTime.toEpochMillis(first.timeCreated) }])
      const retry = { ...input, id: first.id }
      expect(await facade.promptProduct(retry)).toEqual(first)
      await expect(facade.promptProduct({ ...retry, prompt: { text: "changed" } })).rejects.toMatchObject({
        code: "input_conflict",
      })
      await expect(facade.promptProduct({ ...retry, delivery: "queue" })).rejects.toMatchObject({
        code: "input_conflict",
      })
      await expect(
        facade.promptProduct({ ...retry, sessionID: SessionID.descending("ses_foreign_product") }),
      ).rejects.toMatchObject({ code: "input_conflict" })
    } finally {
      await client.close()
    }
  },
  30000,
)

// The existing boundary fixture omits durable event metadata; success from
// admit alone must not manufacture a product receipt or a wall-clock time.
test("an admission reply without durable admission metadata cannot become a product receipt", async () => {
  await using tmp = await tmpdir()
  const client = EngineClient.start({
    binary: path.join(import.meta.dir, "../fixture/engine-fake.ts"),
    db: path.join(tmp.path, "engine.db"),
    workspace: tmp.path,
    model: "fixture",
  })
  const facade = new EngineSession(client, () => {})
  try {
    await expect(
      facade.promptProduct({
        sessionID: SessionID.descending("ses_incomplete_receipt"),
        prompt: { text: "prompt" },
        resume: false,
      }),
    ).rejects.toMatchObject({ code: "engine_admission_invalid" })
  } finally {
    await client.close()
  }
})
