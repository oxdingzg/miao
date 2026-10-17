import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient, EngineError } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

test("a failed child rejects pending and later requests with its startup diagnostic", async () => {
  await using tmp = await tmpdir()
  // Bun is a real executable, but cannot run the engine's `serve` entrypoint.
  const client = EngineClient.start({
    binary: process.execPath,
    db: path.join(tmp.path, "native.db"),
    workspace: tmp.path,
    model: "fixture",
  })
  try {
    const failure = await client.request("sessions").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(EngineError)
    expect(failure).toMatchObject({ code: "engine_closed" })
    if (!(failure instanceof EngineError)) throw failure
    expect(failure.message).toContain("serve")
    await expect(client.request("snapshot", { session_id: "s" })).rejects.toBe(failure)
    await expect(client.request("sessions")).rejects.toBe(failure)
  } finally {
    await client.close()
  }
}, 5_000)

test("a closed client refuses new requests", async () => {
  await using tmp = await tmpdir()
  const client = EngineClient.start({
    binary: process.execPath,
    db: path.join(tmp.path, "native.db"),
    workspace: tmp.path,
    model: "fixture",
  })
  await client.close()
  await expect(client.request("sessions")).rejects.toMatchObject({ code: "engine_closed" })
}, 5_000)

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native storage contention reports Busy instead of losing the exit reason",
  async () => {
    await using tmp = await tmpdir()
    const options = {
      binary: binary!,
      db: path.join(tmp.path, "native.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      env: { OPENAI_API_KEY: "fixture-only" },
    }
    const owner = EngineClient.start(options)
    try {
      expect(await owner.request("sessions")).toEqual([])
      const other = EngineClient.start(options)
      try {
        await expect(other.request("sessions")).rejects.toMatchObject({ code: "engine_busy" })
        await expect(other.request("sessions")).rejects.toMatchObject({ code: "engine_busy" })
      } finally {
        await other.close()
      }
    } finally {
      await owner.close()
    }
  },
  10_000,
)
