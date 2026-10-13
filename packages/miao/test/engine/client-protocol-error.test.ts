import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("unmatched native protocol errors reject instead of hanging", () => {})
if (binary)
  test("unmatched native protocol errors reject instead of hanging", async () => {
    await using tmp = await tmpdir()
    const client = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    try {
      await expect(client.request("unknown_method")).rejects.toMatchObject({ code: "invalid_request" })
      expect(await client.request("sessions")).toEqual([])
    } finally {
      await client.close()
    }
  }, 10_000)
