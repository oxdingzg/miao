import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { runEnginePrompt } from "@/engine/run"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "native failure capture retains diagnostics and strict replay rejects a changed cause",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "miao-failure-trace-"))
    const endpoint = Bun.serve({ port: 0, fetch: () => new Response("rejected fixture", { status: 400 }) })
    const file = path.join(root, "bundle.json")
    const recorder = new BlackboxTape.Recorder(file, { engine: "rust", protocol: "openai-chat" })
    try {
      await expect(
        runEnginePrompt({
          binary: binary!,
          db: path.join(root, "engine.db"),
          workspace: root,
          model: "fixture",
          provider: "openai-chat",
          endpoint: endpoint.url.toString(),
          env: { OPENAI_API_KEY: "fixture-only" },
          prompt: "hello",
          blackbox: recorder,
          timeoutMs: 30_000,
        }),
      ).rejects.toMatchObject({ code: "provider_failed" })
      const bundle = await BlackboxTape.load(file)
      const failure = bundle.trace.find((event) => event.kind === "provider.failed")
      const data = failure?.data
      if (!failure || !BlackboxTape.isObject(data)) throw new Error("missing native failure trace")
      expect(data).toMatchObject({ run_id: "run_0", step: 0, message: expect.stringContaining("400") })
      expect(data).not.toEqual({ failed: true })
      const isolated = { ...bundle, interactions: [], trace: [failure] }
      const exact = new BlackboxTape.Replay(isolated)
      exact.expectTrace(failure.session, failure.kind, data)
      exact.assertConsumed()
      const changed = new BlackboxTape.Replay(isolated)
      expect(() => changed.expectTrace(failure.session, failure.kind, { ...data, message: "different cause" })).toThrow(
        BlackboxTape.Mismatch,
      )
      expect(() => changed.assertConsumed()).toThrow(BlackboxTape.Mismatch)
      expect(await Bun.file(file).text()).not.toContain("fixture-only")
    } finally {
      await endpoint.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
