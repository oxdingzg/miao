import { engineFake } from "../fixture/engine-binary"
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
    expect(client.stderrText.trim().length).toBeGreaterThan(0)
    expect(failure.message).toContain(client.stderrText.trim())
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
  "native storage is shared by concurrent runtimes",
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
    const other = EngineClient.start(options)
    try {
      // Session ownership is fenced per Session, so a second runtime on the same
      // storage is expected to serve too instead of failing with Busy.
      expect(await owner.request("sessions")).toEqual([])
      expect(await other.request("sessions")).toEqual([])
      expect(await owner.request("sessions")).toEqual([])
    } finally {
      await other.close()
      await owner.close()
    }
  },
  10_000,
)

test.skipIf(process.platform === "win32")(
  "close rejects outstanding requests and reaps an unresponsive stdio child",
  async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, "unresponsive-engine")
    // A real process that accepts its stdin pipe but never reads or replies.
    await Bun.write(binary, "#!/bin/sh\nexec sleep 60\n")
    await Bun.$`chmod +x ${binary}`.quiet()
    const client = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
    })
    const pending = client.request("sessions").catch((error: unknown) => error)
    await client.close()
    expect(await pending).toMatchObject({ code: "engine_closed" })
    expect(client.available).toBe(false)
    await expect(client.request("sessions")).rejects.toMatchObject({ code: "engine_closed" })
  },
  5_000,
)

test.skipIf(process.platform === "win32")(
  "unresponsive native RPCs fail with their operation and retire the client",
  async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, "unresponsive-engine")
    await Bun.write(binary, "#!/bin/sh\nexec sleep 60\n")
    await Bun.$`chmod +x ${binary}`.quiet()
    const client = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      requestTimeoutMs: 50,
    })
    try {
      const first = client.request("admit", { session_id: "s" }).catch((error: unknown) => error)
      const second = client.request("sessions").catch((error: unknown) => error)
      const error = await first
      expect(error).toMatchObject({ code: "engine_request_timeout" })
      if (!(error instanceof EngineError)) throw error
      expect(error.message).toContain("admit")
      expect(error.message).toContain("durable receipt")
      expect(await second).toBe(error)
      expect(client.available).toBe(false)
      await expect(client.request("sessions")).rejects.toBe(error)
    } finally {
      await client.close()
    }
  },
  5_000,
)

for (const method of [
  "snapshot",
  "context_snapshot",
  "permission_import_snapshot",
  "permission_import_changes",
  "permission_saved_migration",
  "permission_saved_imported",
  "permission_pattern_list",
  "permission_pattern_snapshot",
  "permission_pattern_changes",
]) {
  test(`a timed-out ${method} read leaves the executing engine available`, async () => {
    await using tmp = await tmpdir()
    const ready = path.join(tmp.path, "ready")
    const client = EngineClient.start({
      binary: engineFake,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      requestTimeoutMs: 500,
      env: { ENGINE_FAKE_IGNORE_SNAPSHOT: "1", ENGINE_FAKE_READY_FILE: ready },
    })
    try {
      // The RPC budget measures a ready fixture, independently of process startup.
      const deadline = Date.now() + 5_000
      // A BunFile may cache a negative stat; create a fresh handle for each poll.
      while (!(await Bun.file(ready).exists()) || (await Bun.file(ready).text()) !== "ready") {
        if (!client.available || Date.now() >= deadline)
          throw new Error(`engine fixture did not become ready: ${client.stderrText}`)
        await Bun.sleep(10)
      }
      await client.request("sessions")
      // The real fixture deliberately leaves a snapshot request unanswered.
      const failure = client
        .request(method, method === "snapshot" ? { session_id: "s" } : undefined)
        .catch((error: unknown) => error)
      expect(await client.request("sessions")).toEqual({ accepted: true })
      expect(await failure).toMatchObject({ code: "engine_request_timeout" })
      expect(client.available).toBe(true)
      expect(await client.request("sessions")).toEqual({ accepted: true })
    } finally {
      await client.close()
    }
  }, 10_000)
}
