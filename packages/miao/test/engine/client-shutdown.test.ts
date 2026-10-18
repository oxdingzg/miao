import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "../../src/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)("shutdown uses the native unit-command envelope and waits for child exit", async () => {
  if (!binary) throw new Error("native engine binary required")
  await using tmp = await tmpdir()
  const client = EngineClient.start({
    binary,
    db: path.join(tmp.path, "engine.db"),
    workspace: tmp.path,
    model: "fixture",
    provider: "openai-chat",
    env: { OPENAI_API_KEY: "fixture-not-sent-to-provider" },
  })
  try {
    await client.request("model_catalog")
    await expect(client.shutdown()).resolves.toBeDefined()
  } finally {
    await client.close()
  }
  await expect(client.request("model_catalog")).rejects.toMatchObject({ code: "engine_closed" })
})
